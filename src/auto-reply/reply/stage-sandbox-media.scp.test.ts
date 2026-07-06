/** Tests for scpFile stream error handling. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { scpFile } from "./stage-sandbox-media.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn } = await import("node:child_process");

describe("scpFile", () => {
  it("rejects when stderr emits an error", async () => {
    const mockSpawn = vi.mocked(spawn);
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter & { setEncoding: (enc: string) => void };
    };
    const stderr = new EventEmitter() as EventEmitter & {
      setEncoding: (enc: string) => void;
    };
    stderr.setEncoding = () => {};
    child.stderr = stderr;
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const resultPromise = scpFile("host", "/remote/path", "/local/path");

    stderr.emit("error", new Error("stderr EPIPE"));

    await expect(resultPromise).rejects.toThrow("stderr EPIPE");
  });
});
