import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn(() => ({
  gateway: {
    auth: {
      token: "config-token",
    },
  },
}));

const runtimeLogs: string[] = [];
const defaultRuntime = {
  log: (message: string) => runtimeLogs.push(message),
  error: vi.fn(),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

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

const isRestartEnabled = vi.fn(() => true);
const buildGatewayConnectionDetails = vi.fn(() => ({
  url: "ws://127.0.0.1:18789",
  urlSource: "local loopback",
  message: "Gateway target: ws://127.0.0.1:18789",
}));
const resolveGatewayCredentialsFromConfig = vi.fn((): { token?: string; password?: string } => ({
  token: "resolved-token",
  password: undefined,
}));
const resolveGatewayPid = vi.fn(() => Promise.resolve(42 as number | null));
const pollUntilGatewayHealthy = vi.fn(() => Promise.resolve(true));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
}));

vi.mock("../../config/commands.js", () => ({
  isRestartEnabled: (...args: Parameters<typeof isRestartEnabled>) => isRestartEnabled(...args),
}));

vi.mock("../../gateway/call.js", () => ({
  buildGatewayConnectionDetails: (...args: Parameters<typeof buildGatewayConnectionDetails>) =>
    buildGatewayConnectionDetails(...args),
}));

vi.mock("../../gateway/credentials.js", () => ({
  resolveGatewayCredentialsFromConfig: (
    ...args: Parameters<typeof resolveGatewayCredentialsFromConfig>
  ) => resolveGatewayCredentialsFromConfig(...args),
}));

vi.mock("./sigusr1-restart.js", () => ({
  resolveGatewayPid: (...args: Parameters<typeof resolveGatewayPid>) => resolveGatewayPid(...args),
  pollUntilGatewayHealthy: (...args: Parameters<typeof pollUntilGatewayHealthy>) =>
    pollUntilGatewayHealthy(...args),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;

function parseJsonEmit(): Record<string, unknown> {
  const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as Record<string, unknown>;
}

function baseParams(overrides?: Partial<Parameters<typeof runServiceRestart>[0]>) {
  return {
    serviceNoun: "Gateway",
    service,
    renderStartHints: () => [] as string[],
    ...overrides,
  };
}

function resetAllMocks() {
  runtimeLogs.length = 0;
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ gateway: { auth: { token: "config-token" } } });
  isRestartEnabled.mockClear();
  isRestartEnabled.mockReturnValue(true);
  buildGatewayConnectionDetails.mockClear();
  buildGatewayConnectionDetails.mockReturnValue({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "Gateway target: ws://127.0.0.1:18789",
  });
  resolveGatewayCredentialsFromConfig.mockClear();
  resolveGatewayCredentialsFromConfig.mockReturnValue({
    token: "resolved-token",
    password: undefined,
  });
  resolveGatewayPid.mockClear();
  resolveGatewayPid.mockResolvedValue(42);
  pollUntilGatewayHealthy.mockClear();
  pollUntilGatewayHealthy.mockResolvedValue(true);
  service.isLoaded.mockClear();
  service.isLoaded.mockResolvedValue(true);
  service.readCommand.mockClear();
  service.readCommand.mockResolvedValue({
    environment: { OPENCLAW_GATEWAY_TOKEN: "service-token" },
  });
  service.restart.mockClear();
  service.restart.mockResolvedValue(undefined);
  vi.unstubAllEnvs();
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
  vi.restoreAllMocks();
}

describe("runServiceRestart token drift", () => {
  beforeAll(async () => {
    ({ runServiceRestart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetAllMocks();
  });

  it("emits drift warning when enabled", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    await runServiceRestart({
      ...baseParams(),
      opts: { json: true },
      checkTokenDrift: true,
    });

    expect(loadConfig).toHaveBeenCalledTimes(1);
    const payload = parseJsonEmit();
    expect((payload.warnings as string[])?.[0]).toContain("gateway install --force");
  });

  it("uses env-first token precedence when checking drift", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    service.readCommand.mockResolvedValue({
      environment: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
    });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");
    // resolveGatewayCredentialsFromConfig with modeOverride: "local" returns env token
    // when env-first precedence is used — the service token matches, so no drift.
    resolveGatewayCredentialsFromConfig.mockReturnValue({
      token: "env-token",
      password: undefined,
    });

    await runServiceRestart({
      ...baseParams(),
      opts: { json: true },
      checkTokenDrift: true,
    });

    const payload = parseJsonEmit();
    expect(payload.warnings).toBeUndefined();
  });

  it("skips drift warning when checkTokenDrift is not set", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    await runServiceRestart({
      ...baseParams({ serviceNoun: "Node" }),
      opts: { json: true },
    });

    // loadConfig IS called (hoisted for restart-enabled check), but readCommand is NOT
    expect(service.readCommand).not.toHaveBeenCalled();
    const payload = parseJsonEmit();
    expect(payload.warnings).toBeUndefined();
  });
});

describe("runServiceRestart graceful restart", () => {
  beforeAll(async () => {
    ({ runServiceRestart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetAllMocks();
  });

  // === Core flow tests ===

  it("default restart: PID resolved, SIGUSR1 sent, health confirms up", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(result).toBe(true);
    expect(resolveGatewayPid).toHaveBeenCalledWith(service);
    expect(killSpy).toHaveBeenCalledWith(42, "SIGUSR1");
    expect(pollUntilGatewayHealthy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "resolved-token",
        timeoutMs: 45_000,
      }),
    );
    expect(service.restart).not.toHaveBeenCalled();
    const payload = parseJsonEmit();
    expect(payload.result).toBe("restarted");
  });

  it("default restart: PID null → falls back to hard restart", async () => {
    resolveGatewayPid.mockResolvedValue(null);

    const result = await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalled();
    expect(pollUntilGatewayHealthy).not.toHaveBeenCalled();
  });

  it("default restart: process.kill throws → falls back to hard restart", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });

    const result = await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalled();
  });

  it("--hard flag → hard restart directly, skips resolveGatewayPid and isRestartEnabled", async () => {
    const result = await runServiceRestart(baseParams({ opts: { json: true, hard: true } }));

    expect(result).toBe(true);
    expect(resolveGatewayPid).not.toHaveBeenCalled();
    expect(isRestartEnabled).not.toHaveBeenCalled();
    expect(service.restart).toHaveBeenCalled();
  });

  it("commands.restart: false → error, no fallback to hard", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    isRestartEnabled.mockReturnValue(false);

    const result = await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(result).toBe(false);
    expect(resolveGatewayPid).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    const payload = parseJsonEmit();
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("commands.restart=false");
  });

  it("--hard with commands.restart: false → hard restart proceeds", async () => {
    isRestartEnabled.mockReturnValue(false);

    const result = await runServiceRestart(baseParams({ opts: { json: true, hard: true } }));

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalled();
  });

  it("loadConfig() throws → falls back to hard restart", async () => {
    loadConfig.mockImplementation(() => {
      throw new Error("corrupt config");
    });

    const result = await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalled();
    expect(resolveGatewayPid).not.toHaveBeenCalled();
  });

  it("post-SIGUSR1 setup failure → restarted-unverified", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    buildGatewayConnectionDetails.mockImplementation(() => {
      throw new Error("SECURITY ERROR: ws:// to non-loopback");
    });

    const result = await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(result).toBe(true);
    const payload = parseJsonEmit();
    expect(payload.result).toBe("restarted-unverified");
    expect(payload.message).toContain("health check setup failed");
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("health poll times out → restarted-unverified", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    pollUntilGatewayHealthy.mockResolvedValue(false);

    const result = await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(result).toBe(true);
    const payload = parseJsonEmit();
    expect(payload.result).toBe("restarted-unverified");
    expect(payload.message).toContain("timed out");
  });

  it("token drift fires before both graceful and hard paths", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await runServiceRestart(baseParams({ opts: { json: true }, checkTokenDrift: true }));
    expect(service.readCommand).toHaveBeenCalledTimes(1);

    service.readCommand.mockClear();
    await runServiceRestart(
      baseParams({ opts: { json: true, hard: true }, checkTokenDrift: true }),
    );
    expect(service.readCommand).toHaveBeenCalledTimes(1);
  });

  // === postRestartCheck routing ===

  it("postRestartCheck fires on hard path, NOT on graceful path", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const postRestartCheck = vi.fn();

    await runServiceRestart(baseParams({ opts: { json: true }, postRestartCheck }));
    expect(postRestartCheck).not.toHaveBeenCalled();

    postRestartCheck.mockClear();
    await runServiceRestart(baseParams({ opts: { json: true, hard: true }, postRestartCheck }));
    expect(postRestartCheck).toHaveBeenCalledTimes(1);
  });

  // === Credential forwarding ===

  it("credentials forwarded to pollUntilGatewayHealthy", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    resolveGatewayCredentialsFromConfig.mockReturnValue({ token: "t", password: "p" });

    await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(pollUntilGatewayHealthy).toHaveBeenCalledWith(
      expect.objectContaining({ token: "t", password: "p" }),
    );
  });

  it("undefined credentials flow through without error", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    resolveGatewayCredentialsFromConfig.mockReturnValue({ token: undefined, password: undefined });

    const result = await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(result).toBe(true);
    expect(pollUntilGatewayHealthy).toHaveBeenCalledWith(
      expect.objectContaining({ token: undefined, password: undefined }),
    );
  });

  // === JSON output shapes ===

  it("--json graceful path: full payload shape", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await runServiceRestart(baseParams({ opts: { json: true } }));

    const payload = parseJsonEmit();
    expect(payload.ok).toBe(true);
    expect(payload.result).toBe("restarted");
    expect(payload.message).toBeDefined();
    expect(typeof payload.notice).toBe("string");
    expect(payload.warnings).toBeUndefined();
  });

  it("--hard --json: payload has service snapshot, no notice", async () => {
    await runServiceRestart(baseParams({ opts: { json: true, hard: true } }));

    const payload = parseJsonEmit();
    expect(payload.ok).toBe(true);
    expect(payload.result).toBe("restarted");
    expect(payload.service).toBeDefined();
    expect(payload.notice).toBeUndefined();
  });

  // === Migration notice ===

  it("migration notice shown on happy path, not when restart disabled", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await runServiceRestart(baseParams());
    expect(runtimeLogs.some((l) => l.includes("now defaults to graceful restart"))).toBe(true);

    runtimeLogs.length = 0;
    isRestartEnabled.mockReturnValue(false);
    await runServiceRestart(baseParams());
    expect(runtimeLogs.some((l) => l.includes("now defaults to graceful restart"))).toBe(false);
  });

  // === Error handling edge cases ===

  it("resolveGatewayCredentialsFromConfig throws after SIGUSR1 → restarted-unverified", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    resolveGatewayCredentialsFromConfig.mockImplementation(() => {
      throw new Error("pathological config");
    });

    const result = await runServiceRestart(baseParams({ opts: { json: true } }));

    expect(result).toBe(true);
    const payload = parseJsonEmit();
    expect(payload.result).toBe("restarted-unverified");
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("service.readCommand throws in token drift — suppressed, continues", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    service.readCommand.mockRejectedValue(new Error("no command"));

    const result = await runServiceRestart(
      baseParams({ opts: { json: true }, checkTokenDrift: true }),
    );

    expect(result).toBe(true);
    const payload = parseJsonEmit();
    expect(payload.warnings).toBeUndefined();
  });

  it("loadConfig called once (hoisted)", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await runServiceRestart(baseParams({ opts: { json: true }, checkTokenDrift: true }));

    expect(loadConfig).toHaveBeenCalledTimes(1);
  });
});
