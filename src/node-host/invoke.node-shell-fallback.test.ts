import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const { runCommand } = await import("./invoke.js");

beforeEach(() => {
  spawnMock.mockReset();
});

function mockSpawnError(message: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  setImmediate(() => child.emit("error", new Error(message)));
  return child;
}

function mockSpawnSuccess(stdout: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  setImmediate(() => {
    child.stdout.write(stdout);
    child.stdout.end();
    child.emit("exit", 0);
  });
  return child;
}

describe("node host shell fallback execution", () => {
  it("does not retry a missing /bin/sh below the system.run policy path", async () => {
    spawnMock.mockReturnValueOnce(mockSpawnError("spawn /bin/sh ENOENT"));

    const result = await runCommand(
      ["/bin/sh", "-lc", "printf NODE_SHELL_FALLBACK_OK"],
      undefined,
      undefined,
      undefined,
    );

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "/bin/sh",
      ["-lc", "printf NODE_SHELL_FALLBACK_OK"],
      expect.any(Object),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      exitCode: undefined,
      success: false,
      error: "spawn /bin/sh ENOENT",
    });
  });

  it("executes the canonical fallback shell argv supplied by system.run planning", async () => {
    spawnMock.mockReturnValueOnce(mockSpawnSuccess("NODE_SHELL_FALLBACK_OK"));

    const result = await runCommand(
      ["/usr/bin/sh", "-lc", "printf NODE_SHELL_FALLBACK_OK"],
      undefined,
      undefined,
      undefined,
    );

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/sh",
      ["-lc", "printf NODE_SHELL_FALLBACK_OK"],
      expect.any(Object),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      exitCode: 0,
      success: true,
      stdout: "NODE_SHELL_FALLBACK_OK",
      error: null,
    });
  });
});
