import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testing } from "./stage-sandbox-media.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

describe("scpFile", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  function createChild() {
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), { kill, stderr });
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    return { child, kill, stderr };
  }

  it("keeps child close authoritative when stderr emits an error", async () => {
    const { child, kill, stderr } = createChild();

    const resultPromise = testing.scpFile("host", "/remote/path", "/local/path");

    expect(() => stderr.emit("error", new Error("stderr EPIPE"))).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
    child.emit("close", 0);

    await expect(resultPromise).resolves.toBeUndefined();
  });

  it("includes the stderr stream error when scp exits unsuccessfully", async () => {
    const { child, stderr } = createChild();

    const resultPromise = testing.scpFile("host", "/remote/path", "/local/path");
    stderr.emit("error", new Error("stderr EPIPE"));
    child.emit("close", 1);

    await expect(resultPromise).rejects.toThrow("scp failed (1): stderr EPIPE");
  });

  it("does not terminate scp again when spawning fails", async () => {
    const { child, kill } = createChild();

    const resultPromise = testing.scpFile("host", "/remote/path", "/local/path");
    child.emit("error", new Error("spawn failed"));

    await expect(resultPromise).rejects.toThrow("spawn failed");
    expect(kill).not.toHaveBeenCalled();
  });
});
