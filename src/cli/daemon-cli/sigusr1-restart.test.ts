import { beforeEach, describe, expect, it, vi } from "vitest";

const probeGatewayStatus = vi.fn();

vi.mock("./probe.js", () => ({
  probeGatewayStatus,
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
});

describe("pollUntilGatewayHealthy", () => {
  beforeEach(async () => {
    probeGatewayStatus.mockReset();
    ({ pollUntilGatewayHealthy } = await import("./sigusr1-restart.js"));
  });

  it("two-phase success: waits for down then up", async () => {
    // Phase 1: old process alive twice, then down
    // Phase 2: down once, then new process up
    probeGatewayStatus
      .mockResolvedValueOnce({ ok: true }) // Phase 1: still up
      .mockResolvedValueOnce({ ok: true }) // Phase 1: still up
      .mockResolvedValueOnce({ ok: false, error: "connection refused" }) // Phase 1: down → break
      .mockResolvedValueOnce({ ok: false, error: "connection refused" }) // Phase 2: still down
      .mockResolvedValueOnce({ ok: true }); // Phase 2: up → return true

    const result = await pollUntilGatewayHealthy({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 30_000,
      intervalMs: 1,
    });
    expect(result).toBe(true);
    expect(probeGatewayStatus).toHaveBeenCalledTimes(5);
    // Verify json: true passed on every tick
    for (const call of probeGatewayStatus.mock.calls) {
      expect(call[0].json).toBe(true);
    }
  });

  it("Phase 1 instant-down advances to Phase 2", async () => {
    probeGatewayStatus
      .mockResolvedValueOnce({ ok: false, error: "refused" }) // Phase 1: instant down
      .mockResolvedValueOnce({ ok: false, error: "refused" }) // Phase 2: still starting
      .mockResolvedValueOnce({ ok: true }); // Phase 2: up

    const result = await pollUntilGatewayHealthy({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 30_000,
      intervalMs: 1,
    });
    expect(result).toBe(true);
  });

  it("Phase 1 timeout: never sees down → returns false", async () => {
    // Old process never goes down within budget
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

  it("no false-positive: ok:true (old) → ok:false → ok:true (new) reports true only after full cycle", async () => {
    probeGatewayStatus
      .mockResolvedValueOnce({ ok: true }) // Phase 1: old process still alive
      .mockResolvedValueOnce({ ok: false }) // Phase 1: old process down → break
      .mockResolvedValueOnce({ ok: true }); // Phase 2: new process up → return true

    const result = await pollUntilGatewayHealthy({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 30_000,
      intervalMs: 1,
    });
    expect(result).toBe(true);
    // Confirm 3 probes (not 1 — the initial ok:true must NOT be treated as success)
    expect(probeGatewayStatus).toHaveBeenCalledTimes(3);
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
