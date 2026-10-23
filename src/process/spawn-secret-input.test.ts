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

function childWithSecretStream(stream: ControlledSecretStream): ChildProcess {
  return { stdio: [null, null, null, stream] } as unknown as ChildProcess;
}

function writeSecret(stream: ControlledSecretStream): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  try {
    using prepared = prepareSecretInputStdio([], {
      fd: 3,
      createData: () => Buffer.from("selected-secret"),
    });
    return prepared!.deliverTo(childWithSecretStream(stream));
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("Windows secret input delivery", () => {
  it("completes once the pipe accepts the bytes, even if the child never reads them", async () => {
    const stream = new ControlledSecretStream();
    const write = writeSecret(stream);

    expect(stream.written?.toString()).toBe("selected-secret");
    stream.finishWrite();
    await expect(write).resolves.toBeUndefined();
    expect(stream.destroyed).toBe(true);
    expect(stream.written?.every((byte) => byte === 0)).toBe(true);
  });

  it("consumes pipe errors after delivery until the stream closes", async () => {
    const stream = new ControlledSecretStream();
    const write = writeSecret(stream);

    stream.finishWrite();
    await expect(write).resolves.toBeUndefined();

    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(() => stream.emit("error", reset)).not.toThrow();
    expect(stream.listenerCount("error")).toBe(1);

    stream.emit("close");
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("rejects a blocked write when abortSignal fires", async () => {
    const stream = new ControlledSecretStream();
    const abort = new AbortController();
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      using prepared = prepareSecretInputStdio([], {
        fd: 3,
        createData: () => Buffer.from("selected-secret"),
      });
      const write = prepared!.deliverTo(childWithSecretStream(stream), {
        abortSignal: abort.signal,
      });
      abort.abort();
      await expect(write).rejects.toThrow("secret delivery aborted");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
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
  expect({ dev: current.dev, ino: current.ino }).not.toEqual({
    dev: original.dev,
    ino: original.ino,
  });
}

describe.skipIf(process.platform === "win32")("POSIX secret input ownership", () => {
  const descriptorPath = process.platform === "darwin" ? "/dev/fd/3" : "/proc/self/fd/3";

  it.each(["path", "direct"])(
    "delivers once through a %s reader without replay to descendants",
    async (reader) => {
      const stdio: SpawnStdioEntry[] = ["ignore", "pipe", "pipe"];
      const data = Buffer.from("private-fixture");
      using prepared = prepareSecretInputStdio(stdio, { fd: 3, createData: () => data });
      const original = fstatSync(stdio[3] as number);
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
      const fs = require("node:fs");
      const value = fs.readFileSync(${JSON.stringify(reader === "path" ? descriptorPath : 3)}, "utf8");
      const descendant = require("node:child_process").spawnSync(process.execPath,
        ["-e", 'process.stdout.write(String(require("node:fs").readFileSync(3).length))'],
        {stdio: ["ignore", "pipe", "inherit", 3]});
      process.stdout.write(JSON.stringify({value, descendant: descendant.stdout.toString()}));
    `,
        ],
        { stdio },
      );
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
      try {
        await prepared!.deliverTo(child);
        expect(JSON.parse(await output)).toEqual({ value: "private-fixture", descendant: "0" });
        expect(data.every((byte) => byte === 0)).toBe(true);
        expectDescriptorReleased(stdio[3] as number, original);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );

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
    const stdio: SpawnStdioEntry[] = ["ignore", "pipe", "pipe"];
    const reason = new Error("credential unavailable");
    using prepared = prepareSecretInputStdio(stdio, {
      fd: 3,
      createData: () => {
        throw reason;
      },
    });
    const child = spawn(
      process.execPath,
      ["-e", 'process.stdout.write(String(require("node:fs").readFileSync(3).length))'],
      { stdio },
    );
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
    try {
      await expect(prepared!.deliverTo(child)).rejects.toBe(reason);
      await expect(output).resolves.toBe("0");
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe.runIf(process.platform === "win32")("Windows secret input pipes", () => {
  function spawnWithSecret(script: string, data: Buffer) {
    const stdio: SpawnStdioEntry[] = ["pipe", "pipe", "pipe"];
    const prepared = prepareSecretInputStdio(stdio, { fd: 3, createData: () => data })!;
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
    return { child, delivery: prepared.deliverTo(child), output };
  }

  it("does not wait for a live child that never reads the descriptor", async () => {
    const { child, delivery, output } = spawnWithSecret(
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("done"))',
      Buffer.from("private-fixture"),
    );
    try {
      await delivery;
      child.stdin!.end();
      await expect(output).resolves.toBe("done");
    } finally {
      child.kill();
    }
  });

  it("keeps accepted bytes readable after closing the writer", async () => {
    // Larger than the pipe buffer, so delivery spans partial writes before close.
    const data = Buffer.alloc(1024 * 1024, "s");
    const { child, delivery, output } = spawnWithSecret(
      `
      let length = 0;
      const secret = new (require("node:net").Socket)({ fd: 3, readable: true, writable: false });
      secret.on("data", (chunk) => { length += chunk.length; });
      secret.on("end", () => process.stdout.write(String(length)));
    `,
      data,
    );
    try {
      await delivery;
      await expect(output).resolves.toBe(String(1024 * 1024));
      expect(data.every((byte) => byte === 0)).toBe(true);
    } finally {
      child.kill();
    }
  });
});
