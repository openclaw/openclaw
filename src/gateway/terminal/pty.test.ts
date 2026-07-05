import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above module scope, so the mock target must be created with
// vi.hoisted for the factory to reference it.
const { signalProcessTree } = vi.hoisted(() => ({ signalProcessTree: vi.fn() }));
vi.mock("../../process/kill-tree.js", () => ({ signalProcessTree }));

const { killPtyTree } = await import("./pty.js");

function fakePty(pid = 4321) {
  return { pid, kill: vi.fn() };
}

describe("killPtyTree", () => {
  it("tears down the whole process tree on the default (SIGKILL) close", () => {
    const pty = fakePty();
    killPtyTree(pty);
    // Kills the tree, not just the shell — orphaned child commands are reaped.
    expect(signalProcessTree).toHaveBeenCalledWith(4321, "SIGKILL");
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("uses the process tree for SIGTERM too", () => {
    const pty = fakePty(999);
    killPtyTree(pty, "SIGTERM");
    expect(signalProcessTree).toHaveBeenCalledWith(999, "SIGTERM");
  });

  it("falls back to a direct pty kill for non-terminating signals", () => {
    const pty = fakePty();
    signalProcessTree.mockClear();
    killPtyTree(pty, "SIGHUP");
    expect(signalProcessTree).not.toHaveBeenCalled();
    expect(pty.kill).toHaveBeenCalledWith("SIGHUP");
  });

  it("does not throw when the process is already gone", () => {
    const pty = { pid: 0, kill: vi.fn() };
    expect(() => killPtyTree(pty)).not.toThrow();
  });
});
