import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { formatOpenClawProcessTitle } from "../infra/openclaw-installation-id.js";

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  load: vi.fn(),
  resolveRoot: vi.fn(() => "/opt/openclaw"),
  respawn: vi.fn(),
  runTui: vi.fn(),
  wait: vi.fn(),
}));

vi.mock("../infra/local-tui-processes.js", () => ({
  announceLocalTuiClient: mocks.announce,
  waitForLocalTuiUpdate: mocks.wait,
}));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRootSync: mocks.resolveRoot,
}));
vi.mock("../entry.respawn.js", () => ({
  runCliRespawnPlan: mocks.respawn,
}));
vi.mock("./tui.js", () => {
  mocks.load();
  return { runTui: mocks.runTui };
});

const { runNestedTuiAfterUpdateGate, runTuiAfterUpdateGate, withTuiAfterUpdateGate } =
  await import("./tui-update-gate.js");

describe("TUI update startup gate", () => {
  const originalTitle = process.title;
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.title = originalTitle;
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mocks.announce.mockReset();
    mocks.wait.mockResolvedValue({ waitedForUpdate: false });
  });

  it("does not load the mutable TUI graph until an in-flight update finishes", async () => {
    const waiting = createDeferred<{ waitedForUpdate: boolean }>();
    const result = { exitReason: "quit" };
    mocks.wait.mockImplementation(async () => await waiting.promise);
    mocks.runTui.mockResolvedValue(result);

    const loading = runTuiAfterUpdateGate({} as never);
    await Promise.resolve();
    expect(mocks.load).not.toHaveBeenCalled();

    waiting.resolve({ waitedForUpdate: false });
    await expect(loading).resolves.toBe(result);
    expect(mocks.wait).toHaveBeenCalledWith("/opt/openclaw");
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.runTui).toHaveBeenCalledOnce();
    expect(process.title).toBe(formatOpenClawProcessTitle("openclaw-tui", "/opt/openclaw"));
  });

  it("does not invoke lifecycle cleanup when the startup gate rejects", async () => {
    const gateError = new Error("process discovery unavailable");
    const lifecycle = vi.fn();
    mocks.wait.mockRejectedValue(gateError);

    await expect(withTuiAfterUpdateGate(lifecycle)).rejects.toBe(gateError);

    expect(mocks.load).not.toHaveBeenCalled();
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it("respawns from the replaced installation instead of importing stale chunks", async () => {
    process.argv = [
      process.execPath,
      "/opt/node_modules/.pnpm/openclaw@1.0.0/node_modules/openclaw/dist/entry.js",
      "tui",
    ];
    mocks.wait.mockResolvedValue({ waitedForUpdate: true });

    void runTuiAfterUpdateGate({} as never);
    await vi.waitFor(() => expect(mocks.respawn).toHaveBeenCalledOnce());

    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.respawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        argv: [...process.execArgv, "/opt/node_modules/openclaw/openclaw.mjs", "tui"],
        detachForProcessTree: false,
      }),
    );
  });

  it("returns nested callers through cleanup after a crossed update", async () => {
    mocks.wait.mockResolvedValue({ waitedForUpdate: true });

    await expect(runNestedTuiAfterUpdateGate({} as never)).resolves.toBeUndefined();

    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
    expect(mocks.respawn).not.toHaveBeenCalled();
  });

  it("keeps an internal Windows TUI discoverable until its lifecycle ends", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const release = vi.fn(async () => {});
    mocks.announce.mockResolvedValue({ pid: 104, release });
    mocks.runTui.mockResolvedValue({ exitReason: "quit" });

    await runTuiAfterUpdateGate({} as never);

    expect(mocks.announce).toHaveBeenCalledWith("/opt/openclaw");
    expect(release).toHaveBeenCalledOnce();
  });
});
