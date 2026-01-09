import { describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn(() => ({
  gateway: {
    mode: "remote",
    remote: { url: "ws://remote.example:18789", token: "rtok" },
    auth: { token: "ltok" },
  },
}));
const resolveGatewayPort = vi.fn(() => 18789);
const discoverGatewayBeacons = vi.fn(async () => []);
const pickPrimaryTailnetIPv4 = vi.fn(() => "100.64.0.10");
const probeGateway = vi.fn(async ({ url }: { url: string }) => {
  if (url.includes("127.0.0.1")) {
    return {
      ok: true,
      url,
      connectLatencyMs: 12,
      error: null,
      close: null,
      health: { ok: true },
      status: { web: { linked: false }, sessions: { count: 0 } },
      presence: [
        { mode: "gateway", reason: "self", host: "local", ip: "127.0.0.1" },
      ],
      configSnapshot: {
        path: "/tmp/cfg.json",
        exists: true,
        valid: true,
        config: {
          gateway: { mode: "local" },
          bridge: { enabled: true, port: 18790 },
        },
        issues: [],
        legacyIssues: [],
      },
    };
  }
  return {
    ok: true,
    url,
    connectLatencyMs: 34,
    error: null,
    close: null,
    health: { ok: true },
    status: { web: { linked: true }, sessions: { count: 2 } },
    presence: [
      { mode: "gateway", reason: "self", host: "remote", ip: "100.64.0.2" },
    ],
    configSnapshot: {
      path: "/tmp/remote.json",
      exists: true,
      valid: true,
      config: { gateway: { mode: "remote" }, bridge: { enabled: false } },
      issues: [],
      legacyIssues: [],
    },
  };
});

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  resolveGatewayPort: (cfg: unknown) => resolveGatewayPort(cfg),
}));

vi.mock("../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons: (opts: unknown) => discoverGatewayBeacons(opts),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => pickPrimaryTailnetIPv4(),
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
}));

describe("gateway-status command", () => {
  it("prints human output by default", async () => {
    const runtimeLogs: string[] = [];
    const runtimeErrors: string[] = [];
    const runtime = {
      log: (msg: string) => runtimeLogs.push(msg),
      error: (msg: string) => runtimeErrors.push(msg),
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    };

    const { gatewayStatusCommand } = await import("./gateway-status.js");
    await gatewayStatusCommand(
      { timeout: "1000" },
      runtime as unknown as import("../runtime.js").RuntimeEnv,
    );

    expect(runtimeErrors).toHaveLength(0);
    expect(runtimeLogs.join("\n")).toContain("Gateway Status");
    expect(runtimeLogs.join("\n")).toContain("Discovery (this machine)");
    expect(runtimeLogs.join("\n")).toContain("Targets");
  });

  it("prints a structured JSON envelope when --json is set", async () => {
    const runtimeLogs: string[] = [];
    const runtimeErrors: string[] = [];
    const runtime = {
      log: (msg: string) => runtimeLogs.push(msg),
      error: (msg: string) => runtimeErrors.push(msg),
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    };

    const { gatewayStatusCommand } = await import("./gateway-status.js");
    await gatewayStatusCommand(
      { timeout: "1000", json: true },
      runtime as unknown as import("../runtime.js").RuntimeEnv,
    );

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<
      string,
      unknown
    >;
    expect(parsed.ok).toBe(true);
    expect(parsed.targets).toBeTruthy();
    const targets = parsed.targets as Array<Record<string, unknown>>;
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets[0]?.health).toBeTruthy();
    expect(targets[0]?.summary).toBeTruthy();
  });
});
