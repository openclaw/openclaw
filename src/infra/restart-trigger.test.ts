import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const writeFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock("node:fs", () => ({
  default: { writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args) },
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
}));

vi.mock("./restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: () => [],
  findGatewayPidsOnPortSync: () => [],
}));

vi.mock("../config/paths.js", () => ({
  DEFAULT_GATEWAY_PORT: 18789,
}));

const { triggerOpenClawRestart } = await import("./restart.js");

const originalPlatform = process.platform;

beforeEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  // Return a mock child with unref
  spawnMock.mockReturnValue({ unref: vi.fn() });
  // Bypass test-mode guard
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  process.env.VITEST = "true";
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("triggerOpenClawRestart on win32", () => {
  it("returns schtasks method and spawns restart script", () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const result = triggerOpenClawRestart();

    expect(result.method).toBe("schtasks");
    expect(result.ok).toBe(true);
    expect(writeFileSyncMock).toHaveBeenCalledOnce();
    // Verify the batch script content
    const scriptContent = writeFileSyncMock.mock.calls[0][1] as string;
    expect(scriptContent).toContain("schtasks /End");
    expect(scriptContent).toContain("schtasks /Run");
    expect(scriptContent).toContain(":wait_for_port_release");
    expect(scriptContent).toContain(":force_kill_listener");
    // Verify spawn was called with cmd.exe
    expect(spawnMock).toHaveBeenCalledWith(
      "cmd.exe",
      ["/c", expect.stringContaining(".bat")],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("returns failure for unsafe task name", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.OPENCLAW_PROFILE = "test&whoami";

    const result = triggerOpenClawRestart();

    expect(result.method).toBe("schtasks");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("unsafe task name");
    expect(writeFileSyncMock).not.toHaveBeenCalled();

    delete process.env.OPENCLAW_PROFILE;
  });

  it("returns failure when writeFileSync throws", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    writeFileSyncMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = triggerOpenClawRestart();

    expect(result.method).toBe("schtasks");
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("disk full");
  });
});
