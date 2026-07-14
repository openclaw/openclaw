import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

describe("Windows process-tree termination tracking", () => {
  let forceKillAndWait: typeof import("./process-tree-termination.js").forceKillProcessTreeAndWait;
  let probeAlive: typeof import("./process-tree-termination.js").probeProcessTreeAlive;

  beforeEach(async () => {
    vi.resetModules();
    spawnMock.mockReset();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    ({ forceKillProcessTreeAndWait: forceKillAndWait, probeProcessTreeAlive: probeAlive } =
      await import("./process-tree-termination.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
  });

  it("releases a normally exited root instead of retaining a reusable PID", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("process is not alive");
    });

    expect(probeAlive({ pid: 4321, detached: false })).toBe(false);
  });

  it("never invokes taskkill after the tracked root has exited", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("process is not alive");
    });

    await expect(forceKillAndWait({ pid: 4321, detached: false, timeoutMs: 1_000 })).resolves.toBe(
      false,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("uses taskkill while the tracked root is still live", async () => {
    let alive = true;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0 && alive) {
        return true;
      }
      throw new Error("process is not alive");
    });
    const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn() });
    spawnMock.mockImplementation(() => {
      alive = false;
      queueMicrotask(() => taskkill.emit("close", 0));
      return taskkill;
    });

    await expect(forceKillAndWait({ pid: 4321, detached: false, timeoutMs: 1_000 })).resolves.toBe(
      true,
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/T", "/PID", "4321"],
      expect.objectContaining({ stdio: "ignore", windowsHide: true }),
    );
  });
});
