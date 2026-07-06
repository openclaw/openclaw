/** Tests for runCommand stream error handling. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { testing } from "./invoke.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn } = await import("node:child_process");

describe("runCommand", () => {
  it("finalizes with an error when stdout emits an error", async () => {
    const mockSpawn = vi.mocked(spawn);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const resultPromise = testing.runCommand(["echo", "hello"], undefined, undefined, undefined);

    stdout.emit("error", new Error("stdout broke"));

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("stdout broke");
  });

  it("finalizes with an error when stderr emits an error", async () => {
    const mockSpawn = vi.mocked(spawn);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const resultPromise = testing.runCommand(["echo", "hello"], undefined, undefined, undefined);

    stderr.emit("error", new Error("stderr broke"));

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("stderr broke");
  });
});
