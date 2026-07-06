/** Tests for logs-cli runtime helpers. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { execFileUtf8Tail } from "./logs-cli.runtime.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn } = await import("node:child_process");

describe("execFileUtf8Tail", () => {
  it("resolves with an error when stdout emits an error", async () => {
    const mockSpawn = vi.mocked(spawn);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const resultPromise = execFileUtf8Tail("tail", ["-f", "log"], { maxBytes: 1024 });

    stdout.emit("error", new Error("stdout EPIPE"));

    const result = await resultPromise;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stdout EPIPE");
  });

  it("resolves with an error when stderr emits an error", async () => {
    const mockSpawn = vi.mocked(spawn);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const resultPromise = execFileUtf8Tail("tail", ["-f", "log"], { maxBytes: 1024 });

    stderr.emit("error", new Error("stderr EPIPE"));

    const result = await resultPromise;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stderr EPIPE");
  });
});
