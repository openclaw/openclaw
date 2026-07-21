// Spawn utility tests cover child process setup and stream handling helpers.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { spawnWithFallback } from "./spawn-utils.js";

function createStubChild() {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: 1234, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  queueMicrotask(() => {
    child.emit("spawn");
  });
  return child;
}

function spawnOptionsAt(
  spawnMock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
): SpawnOptions {
  const call = spawnMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected spawn call ${callIndex}`);
  }
  const options = call[2];
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error(`expected spawn call ${callIndex} options`);
  }
  return options as SpawnOptions;
}

describe("spawnWithFallback", () => {
  it("retries on EBADF using fallback options", async () => {
    const spawnMock = vi
      .fn()
      .mockImplementationOnce(() => {
        const err = new Error("spawn EBADF");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      })
      .mockImplementationOnce(() => createStubChild());

    const result = await spawnWithFallback({
      argv: ["echo", "ok"],
      options: { stdio: ["pipe", "pipe", "pipe"] },
      fallbacks: [{ label: "safe-stdin", options: { stdio: ["ignore", "pipe", "pipe"] } }],
      spawnImpl: spawnMock,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackLabel).toBe("safe-stdin");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnOptionsAt(spawnMock, 0).stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(spawnOptionsAt(spawnMock, 1).stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("does not retry on non-EBADF errors", async () => {
    const spawnMock = vi.fn().mockImplementationOnce(() => {
      const err = new Error("spawn ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    await expect(
      spawnWithFallback({
        argv: ["missing"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
        fallbacks: [{ label: "safe-stdin", options: { stdio: ["ignore", "pipe", "pipe"] } }],
        spawnImpl: spawnMock,
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("strips detached true before spawn on Windows (#105528)", async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const spawnMock = vi.fn().mockImplementation(() => createStubChild());
    try {
      await spawnWithFallback({
        argv: ["cmd.exe", "/c", "echo", "hello"],
        options: {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
        fallbacks: [{ label: "retry-detach", options: { detached: true } }],
        spawnImpl: spawnMock,
        retryCodes: ["EBADF"],
      });

      expect(spawnOptionsAt(spawnMock, 0).detached).toBe(false);
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("keeps detached true on POSIX hosts", async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const spawnMock = vi.fn().mockImplementation(() => createStubChild());
    try {
      await spawnWithFallback({
        argv: ["echo", "hello"],
        options: {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
        spawnImpl: spawnMock,
      });

      expect(spawnOptionsAt(spawnMock, 0).detached).toBe(true);
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it.runIf(process.platform === "win32")(
    "captures stdout for Windows cmd echo through spawnWithFallback",
    async () => {
      const { spawn } = await import("node:child_process");
      const result = await spawnWithFallback({
        argv: ["cmd.exe", "/d", "/s", "/c", "echo hello-105528"],
        options: {
          // Intentionally request detached; the Windows guard must clear it.
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
        spawnImpl: spawn,
      });

      const chunks: Buffer[] = [];
      result.child.stdout?.on("data", (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
      });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        result.child.once("error", reject);
        result.child.once("close", (code) => resolve(code));
      });
      const stdout = Buffer.concat(chunks).toString("utf8");

      expect(exitCode).toBe(0);
      expect(stdout).toContain("hello-105528");
    },
  );

  it.runIf(process.platform === "win32")(
    "restores PowerShell stdout when caller requests detached true (#105528)",
    async () => {
      const { spawn } = await import("node:child_process");

      // BEFORE: unsanitized detached:true loses PowerShell stdout on this host.
      const before = spawn(
        "powershell.exe",
        ["-NoProfile", "-Command", "Write-Output hello-ps-105528"],
        {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const beforeChunks: Buffer[] = [];
      before.stdout?.on("data", (chunk: Buffer) => {
        beforeChunks.push(Buffer.from(chunk));
      });
      const beforeCode = await new Promise<number | null>((resolve, reject) => {
        before.once("error", reject);
        before.once("close", (code) => resolve(code));
      });
      const beforeStdout = Buffer.concat(beforeChunks).toString("utf8");
      expect(beforeCode).toBe(0);
      expect(beforeStdout).toBe("");

      // AFTER: spawnWithFallback forces detached:false and captures stdout.
      let detachedPassedToNode: boolean | undefined;
      const spawnImpl: typeof spawn = ((...args: Parameters<typeof spawn>) => {
        const options = args[2];
        if (options && typeof options === "object" && !Array.isArray(options)) {
          detachedPassedToNode = Boolean((options as { detached?: boolean }).detached);
        }
        return spawn(...args);
      }) as typeof spawn;

      const result = await spawnWithFallback({
        argv: ["powershell.exe", "-NoProfile", "-Command", "Write-Output hello-ps-105528"],
        options: {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
        spawnImpl,
      });

      const afterChunks: Buffer[] = [];
      result.child.stdout?.on("data", (chunk: Buffer) => {
        afterChunks.push(Buffer.from(chunk));
      });
      const afterCode = await new Promise<number | null>((resolve, reject) => {
        result.child.once("error", reject);
        result.child.once("close", (code) => resolve(code));
      });
      const afterStdout = Buffer.concat(afterChunks).toString("utf8");

      expect(detachedPassedToNode).toBe(false);
      expect(afterCode).toBe(0);
      expect(afterStdout).toContain("hello-ps-105528");
    },
  );
});
