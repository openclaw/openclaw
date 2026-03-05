import { beforeEach, describe, expect, it, vi } from "vitest";

const probeGatewayStatus = vi.fn();
const findGatewayPidsOnPortSync = vi.fn(() => [] as number[]);
const loadConfig = vi.fn(() => ({ gateway: { port: 18789 } }));
const resolveGatewayPort = vi.fn(() => 18789);

vi.mock("./probe.js", () => ({
  probeGatewayStatus,
}));

vi.mock("../../infra/restart-stale-pids.js", () => ({
  findGatewayPidsOnPortSync: (...args: Parameters<typeof findGatewayPidsOnPortSync>) =>
    findGatewayPidsOnPortSync(...args),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  resolveGatewayPort: (...args: Parameters<typeof resolveGatewayPort>) =>
    resolveGatewayPort(...args),
}));

let resolveGatewayPid: typeof import("./sigusr1-restart.js").resolveGatewayPid;
let pollUntilGatewayHealthy: typeof import("./sigusr1-restart.js").pollUntilGatewayHealthy;

describe("resolveGatewayPid", () => {
  const service = {
    label: "TestService",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    isLoaded: vi.fn(),
    readCommand: vi.fn(),
    readRuntime: vi.fn(),
    restart: vi.fn(),
  };

  beforeEach(async () => {
    service.readRuntime.mockReset();
    findGatewayPidsOnPortSync.mockReset();
    findGatewayPidsOnPortSync.mockReturnValue([]);
    loadConfig.mockReset();
    loadConfig.mockReturnValue({ gateway: { port: 18789 } });
    resolveGatewayPort.mockReset();
    resolveGatewayPort.mockReturnValue(18789);
    ({ resolveGatewayPid } = await import("./sigusr1-restart.js"));
  });

  it("returns valid PID from readRuntime", async () => {
    service.readRuntime.mockResolvedValue({ pid: 12345 });
    expect(await resolveGatewayPid(service)).toBe(12345);
  });

  it("returns null when pid is undefined", async () => {
    service.readRuntime.mockResolvedValue({ pid: undefined });
    expect(await resolveGatewayPid(service)).toBeNull();
  });

  it("returns null for invalid PIDs: 0, -1, NaN", async () => {
    for (const badPid of [0, -1, NaN]) {
      service.readRuntime.mockResolvedValue({ pid: badPid });
      expect(await resolveGatewayPid(service)).toBeNull();
    }
  });

  it("returns null when readRuntime throws", async () => {
    service.readRuntime.mockRejectedValue(new Error("service not available"));
    expect(await resolveGatewayPid(service)).toBeNull();
  });

  it("falls back to lsof when readRuntime has no PID", async () => {
    service.readRuntime.mockResolvedValue({ pid: undefined });
    findGatewayPidsOnPortSync.mockReturnValue([42]);

    expect(await resolveGatewayPid(service)).toBe(42);
    expect(findGatewayPidsOnPortSync).toHaveBeenCalledWith(18789);
  });

  it("returns null when lsof finds multiple PIDs", async () => {
    service.readRuntime.mockResolvedValue({ pid: undefined });
    findGatewayPidsOnPortSync.mockReturnValue([42, 43]);

    expect(await resolveGatewayPid(service)).toBeNull();
  });

  it("loads config for port resolution", async () => {
    service.readRuntime.mockResolvedValue({ pid: undefined });
    findGatewayPidsOnPortSync.mockReturnValue([42]);

    await resolveGatewayPid(service);

    expect(loadConfig).toHaveBeenCalled();
    expect(resolveGatewayPort).toHaveBeenCalled();
  });
});

describe("pollUntilGatewayHealthy", () => {
  beforeEach(async () => {
    probeGatewayStatus.mockReset();
    ({ pollUntilGatewayHealthy } = await import("./sigusr1-restart.js"));
  });

  it("two-phase success: waits for down then up", async () => {
    probeGatewayStatus
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "connection refused" })
      .mockResolvedValueOnce({ ok: false, error: "connection refused" })
      .mockResolvedValueOnce({ ok: true });

    const result = await pollUntilGatewayHealthy({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 30_000,
      intervalMs: 1,
    });
    expect(result).toBe(true);
    expect(probeGatewayStatus).toHaveBeenCalledTimes(5);
    for (const call of probeGatewayStatus.mock.calls) {
      expect(call[0].json).toBe(true);
    }
  });

  it("Phase 1 instant-down advances to Phase 2", async () => {
    probeGatewayStatus
      .mockResolvedValueOnce({ ok: false, error: "refused" })
      .mockResolvedValueOnce({ ok: false, error: "refused" })
      .mockResolvedValueOnce({ ok: true });

    const result = await pollUntilGatewayHealthy({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 30_000,
      intervalMs: 1,
    });
    expect(result).toBe(true);
  });

  it("Phase 1 timeout: never sees down → returns false", async () => {
    probeGatewayStatus.mockResolvedValue({ ok: true });

    const result = await pollUntilGatewayHealthy({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 50,
      intervalMs: 10,
    });
    expect(result).toBe(false);
  });

  it("Phase 2 timeout: never sees up → returns false", async () => {
    probeGatewayStatus.mockResolvedValue({ ok: false, error: "refused" });

    const result = await pollUntilGatewayHealthy({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 50,
      intervalMs: 10,
    });
    expect(result).toBe(false);
  });

  it("caps per-probe timeout at 2000ms", async () => {
    probeGatewayStatus.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });

    await pollUntilGatewayHealthy({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 30_000,
      intervalMs: 1,
    });

    const firstCallTimeout = probeGatewayStatus.mock.calls[0][0].timeoutMs;
    expect(firstCallTimeout).toBeLessThanOrEqual(2_000);
  });

  it("forwards token and password to probeGatewayStatus", async () => {
    probeGatewayStatus.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });

    await pollUntilGatewayHealthy({
      url: "ws://127.0.0.1:18789",
      token: "my-token",
      password: "my-pass",
      timeoutMs: 30_000,
      intervalMs: 1,
    });

    expect(probeGatewayStatus.mock.calls[0][0]).toMatchObject({
      url: "ws://127.0.0.1:18789",
      token: "my-token",
      password: "my-pass",
    });
  });
});
