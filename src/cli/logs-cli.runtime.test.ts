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

function mockSpawnedChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), { kill, stderr, stdout });
  spawnMock.mockReturnValue(child as unknown as ChildProcess);
  return { child, kill, stderr, stdout };
}

describe("execFileUtf8Tail", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it.each(["stdout", "stderr"] as const)(
    "terminates the child when %s emits an error",
    async (streamName) => {
      const { kill, stderr, stdout } = mockSpawnedChild();

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
    const { child, kill } = mockSpawnedChild();

    const resultPromise = execFileUtf8Tail("journalctl", ["--no-pager"], { maxBytes: 1024 });
    child.emit("error", new Error("spawn failed"));

    await expect(resultPromise).resolves.toMatchObject({ code: 1, stderr: "spawn failed" });
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    { label: "two-byte", text: "¢z", maxBytes: 2, expected: "z" },
    { label: "three-byte", text: "€z", maxBytes: 3, expected: "z" },
    { label: "four-byte", text: "😀z", maxBytes: 4, expected: "z" },
    { label: "complete", text: "a¢z", maxBytes: 3, expected: "¢z" },
  ])("decodes a $label character at the stdout tail boundary", async (testCase) => {
    const { child, stdout } = mockSpawnedChild();
    const resultPromise = execFileUtf8Tail("journalctl", ["--no-pager"], {
      maxBytes: testCase.maxBytes,
    });

    stdout.emit("data", Buffer.from(testCase.text, "utf8"));
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      stderr: "",
      stdout: testCase.expected,
      truncated: true,
    });
  });

  it("decodes a truncated stderr tail at a UTF-8 boundary", async () => {
    const { child, stderr } = mockSpawnedChild();
    const resultPromise = execFileUtf8Tail("journalctl", ["--no-pager"], { maxBytes: 1024 });

    stderr.emit("data", Buffer.concat([Buffer.from("😀"), Buffer.alloc(64 * 1024 - 3, "x")]));
    child.emit("close", 1);

    const result = await resultPromise;
    expect(result.stderr).toBe("x".repeat(64 * 1024 - 3));
    expect(result.stderr).not.toContain("�");
    expect(result.truncated).toBe(false);
  });
});
