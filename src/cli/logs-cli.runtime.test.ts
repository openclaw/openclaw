import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileUtf8Tail } from "./logs-cli.runtime.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

describe("execFileUtf8Tail", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it.each(["stdout", "stderr"] as const)(
    "terminates the child when %s emits an error",
    async (streamName) => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const kill = vi.fn(() => true);
      const child = Object.assign(new EventEmitter(), { kill, stderr, stdout });
      spawnMock.mockReturnValue(child as unknown as ChildProcess);

      const resultPromise = execFileUtf8Tail("journalctl", ["--no-pager"], { maxBytes: 1024 });
      stdout.emit("data", Buffer.from("partial output"));
      const streamError = new Error(`${streamName} read failed`);
      (streamName === "stdout" ? stdout : stderr).emit("error", streamError);

      await expect(resultPromise).resolves.toEqual({
        code: 1,
        stderr: streamError.message,
        stdout: "partial output",
        truncated: false,
      });
      expect(kill).toHaveBeenCalledOnce();
    },
  );

  it("does not kill the child when spawning fails", async () => {
    const child = new EventEmitter();
    const kill = vi.fn(() => true);
    Object.assign(child, { kill, stderr: new EventEmitter(), stdout: new EventEmitter() });
    spawnMock.mockReturnValue(child as unknown as ChildProcess);

    const resultPromise = execFileUtf8Tail("journalctl", ["--no-pager"], { maxBytes: 1024 });
    child.emit("error", new Error("spawn failed"));

    await expect(resultPromise).resolves.toMatchObject({ code: 1, stderr: "spawn failed" });
    expect(kill).not.toHaveBeenCalled();
  });
});
