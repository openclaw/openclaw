import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { fstatSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareSecretInputStdio, type SpawnStdioEntry } from "./spawn-secret-input.js";

// Models a Windows overlapped pipe: writes complete once the pipe buffers them,
// while end()'s shutdown flush waits for a read the child may never perform.
class ControlledSecretStream extends EventEmitter {
  private writeCallback: ((error?: Error | null) => void) | undefined;
  written: Buffer | undefined;
  destroyed = false;

  write(data: Buffer, callback?: (error?: Error | null) => void): boolean {
    this.written = data;
    this.writeCallback = callback;
    return true;
  }

  end(): this {
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  finishWrite(error?: Error): void {
    if (!this.writeCallback) {
      throw new Error("secret write callback was not registered");
    }
    this.writeCallback(error);
  }
}

function writeSecret(stream: ControlledSecretStream, abortSignal?: AbortSignal): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  try {
    using prepared = prepareSecretInputStdio([], {
      fd: 3,
      createData: () => Buffer.from("selected-secret"),
    });
    const child = { stdio: [null, null, null, stream] } as unknown as ChildProcess;
    return prepared!.deliverTo(child, { abortSignal });
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

function spawnSecret(script: string, createData: () => Buffer) {
  const stdin = process.platform === "win32" ? "pipe" : "ignore";
  const stdio: SpawnStdioEntry[] = [stdin, "pipe", "pipe"];
  using prepared = prepareSecretInputStdio(stdio, { fd: 3, createData })!;
  const original = process.platform === "win32" ? undefined : fstatSync(stdio[3] as number);
  const child = spawn(process.execPath, ["-e", script], { stdio, windowsHide: true });
  const output = new Promise<string>((resolve, reject) => {
    let text = "";
    child.stdout!.on("data", (chunk) => {
      text += chunk;
    });
    child.on("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(text) : reject(new Error(`child exited ${code}`)),
    );
  });
  return {
    child,
    output,
    delivery: prepared.deliverTo(child),
    assertReleased: () => expectDescriptorReleased(stdio[3] as number, original!),
    [Symbol.dispose]() {
      child.kill(process.platform === "win32" ? undefined : "SIGKILL");
    },
  };
}

describe("Windows secret input delivery", () => {
  it("completes on accepted bytes and consumes late errors until the pipe closes", async () => {
    const stream = new ControlledSecretStream();
    const write = writeSecret(stream);
    expect(stream.written?.toString()).toBe("selected-secret");
    stream.finishWrite();
    await expect(write).resolves.toBeUndefined();
    expect(stream.destroyed).toBe(true);
    expect(stream.written?.every((byte) => byte === 0)).toBe(true);
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(() => stream.emit("error", reset)).not.toThrow();
    expect(stream.listenerCount("error")).toBe(1);
    stream.emit("close");
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("rejects a blocked write when abortSignal fires", async () => {
    const stream = new ControlledSecretStream();
    const abort = new AbortController();
    const write = writeSecret(stream, abort.signal);
    abort.abort();
    await expect(write).rejects.toThrow("secret delivery aborted");
  });

  it("rejects delivery errors before consuming their later stream event", async () => {
    const stream = new ControlledSecretStream();
    const write = writeSecret(stream);
    const deliveryError = new Error("secret delivery failed");

    stream.finishWrite(deliveryError);
    await expect(write).rejects.toBe(deliveryError);
    expect(() => stream.emit("error", deliveryError)).not.toThrow();

    stream.emit("close");
    expect(stream.listenerCount("error")).toBe(0);
  });
});

function expectDescriptorReleased(fd: number, original: ReturnType<typeof fstatSync>) {
  let current: ReturnType<typeof fstatSync>;
  try {
    current = fstatSync(fd);
  } catch (error) {
    expect(error).toMatchObject({ code: "EBADF" });
    return;
  }
  // Other Vitest workers can reuse the number after close; identity owns the pipe.
  expect([current.dev, current.ino]).not.toEqual([original.dev, original.ino]);
}

describe.skipIf(process.platform === "win32")("POSIX secret input ownership", () => {
  const descriptorPath = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";

  it("delivers once through a path reader without replay to descendants", async () => {
    const data = Buffer.from("private-fixture");
    using test = spawnSecret(
      `
      const fs = require("node:fs");
      const value = fs.readFileSync(${JSON.stringify(descriptorPath)}, "utf8");
      const descendant = require("node:child_process").spawnSync(process.execPath,
        ["-e", 'process.stdout.write(String(require("node:fs").readFileSync(3).length))'],
        {stdio: ["ignore", "pipe", "inherit", 3]});
      process.stdout.write(JSON.stringify({value, descendant: descendant.stdout.toString()}));
    `,
      () => data,
    );
    await test.delivery;
    expect(JSON.parse(await test.output)).toEqual({ value: "private-fixture", descendant: "0" });
    expect(data.every((byte) => byte === 0)).toBe(true);
    test.assertReleased();
  });

  it("closes both untransferred ends when spawning throws", () => {
    const stdio: SpawnStdioEntry[] = ["ignore", "pipe", "pipe"];
    const createData = vi.fn(() => Buffer.from("not-delivered"));
    let original: ReturnType<typeof fstatSync>;
    expect(() => {
      using prepared = prepareSecretInputStdio(stdio, { fd: 3, createData });
      void prepared;
      original = fstatSync(stdio[3] as number);
      spawn("", [], { stdio });
    }).toThrow();
    expect(createData).not.toHaveBeenCalled();
    expectDescriptorReleased(stdio[3] as number, original!);
  });
  it("closes the writer without delivering bytes when credential creation throws", async () => {
    const reason = new Error("credential unavailable");
    using test = spawnSecret(
      'process.stdout.write(String(require("node:fs").readFileSync(3).length))',
      () => {
        throw reason;
      },
    );
    await expect(test.delivery).rejects.toBe(reason);
    await expect(test.output).resolves.toBe("0");
  });
});

describe.runIf(process.platform === "win32")("Windows secret input pipes", () => {
  it("does not wait for a live child that never reads the descriptor", async () => {
    using test = spawnSecret(
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("done"))',
      () => Buffer.from("private-fixture"),
    );
    await test.delivery;
    test.child.stdin!.end();
    await expect(test.output).resolves.toBe("done");
  });

  it("keeps accepted bytes readable after closing the writer", async () => {
    // Larger than the pipe buffer, so delivery spans partial writes before close.
    const data = Buffer.alloc(1024 * 1024, "s");
    using test = spawnSecret(
      `
      let length = 0;
      const secret = new (require("node:net").Socket)({ fd: 3, readable: true, writable: false });
      secret.on("data", (chunk) => { length += chunk.length; });
      secret.on("end", () => process.stdout.write(String(length)));
    `,
      () => data,
    );
    await test.delivery;
    await expect(test.output).resolves.toBe(String(1024 * 1024));
    expect(data.every((byte) => byte === 0)).toBe(true);
  });
});
