import { describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn(() => ({
  gateway: {
    mode: "remote",
    remote: { url: "wss://remote.example:18789", token: "rtok" },
    auth: { token: "ltok" },
  },
}));
const resolveGatewayPort = vi.fn((_cfg?: unknown) => 18789);
const discoverGatewayBeacons = vi.fn(
  async (_opts?: unknown): Promise<Array<{ tailnetDns: string }>> => [],
);
const pickPrimaryTailnetIPv4 = vi.fn(() => "100.64.0.10");
const sshStop = vi.fn(async () => {});
const resolveSshConfig = vi.fn(
  async (
    _opts?: unknown,
  ): Promise<{
    user: string;
    host: string;
    port: number;
    identityFiles: string[];
  } | null> => null,
);
const startSshPortForward = vi.fn(async (_opts?: unknown) => ({
  parsedTarget: { user: "me", host: "studio", port: 22 },
  localPort: 18789,
  remotePort: 18789,
  pid: 123,
  stderr: [],
  stop: sshStop,
}));
const probeGateway = vi.fn(async (opts: { url: string }) => {
  const { url } = opts;
  if (url.includes("127.0.0.1")) {
    return {
      ok: true,
      url,
      connectLatencyMs: 12,
      error: null,
      close: null,
      health: { ok: true },
      status: {
        linkChannel: {
          id: "whatsapp",
          label: "WhatsApp",
          linked: false,
          authAgeMs: null,
        },
        sessions: { count: 0 },
      },
      presence: [{ mode: "gateway", reason: "self", host: "local", ip: "127.0.0.1" }],
      configSnapshot: {
        path: "/tmp/cfg.json",
        exists: true,
        valid: true,
        config: {
          gateway: { mode: "local" },
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
    status: {
      linkChannel: {
        id: "whatsapp",
        label: "WhatsApp",
        linked: true,
        authAgeMs: 5_000,
      },
      sessions: { count: 2 },
    },
    presence: [{ mode: "gateway", reason: "self", host: "remote", ip: "100.64.0.2" }],
    configSnapshot: {
      path: "/tmp/remote.json",
      exists: true,
      valid: true,
      config: { gateway: { mode: "remote" } },
      issues: [],
      legacyIssues: [],
    },
  };
});

vi.mock("../config/config.js", () => ({
  loadConfig,
  resolveGatewayPort,
}));

vi.mock("../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4,
}));

vi.mock("../infra/ssh-tunnel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/ssh-tunnel.js")>();
  return {
    ...actual,
    startSshPortForward,
  };
});

vi.mock("../infra/ssh-config.js", () => ({
  resolveSshConfig,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway,
}));

function createRuntimeCapture() {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const runtime = {
    log: (msg: string) => runtimeLogs.push(msg),
    error: (msg: string) => runtimeErrors.push(msg),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  };
  return { runtime, runtimeLogs, runtimeErrors };
}

async function withUserEnv(user: string, fn: () => Promise<void>) {
  const originalUser = process.env.USER;
  try {
    process.env.USER = user;
    await fn();
  } finally {
    process.env.USER = originalUser;
  }
}

describe("gateway-status command", () => {
  it("prints human output by default", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();

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
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();

    const { gatewayStatusCommand } = await import("./gateway-status.js");
    await gatewayStatusCommand(
      { timeout: "1000", json: true },
      runtime as unknown as import("../runtime.js").RuntimeEnv,
    );

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.targets).toBeTruthy();
    const targets = parsed.targets as Array<Record<string, unknown>>;
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets[0]?.health).toBeTruthy();
    expect(targets[0]?.summary).toBeTruthy();
  });

  it("supports SSH tunnel targets", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();

    startSshPortForward.mockClear();
    sshStop.mockClear();
    probeGateway.mockClear();

    const { gatewayStatusCommand } = await import("./gateway-status.js");
    await gatewayStatusCommand(
      { timeout: "1000", json: true, ssh: "me@studio" },
      runtime as unknown as import("../runtime.js").RuntimeEnv,
    );

    expect(startSshPortForward).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalled();
    const tunnelCall = probeGateway.mock.calls.find(
      (call) => typeof call?.[0]?.url === "string" && call[0].url.startsWith("ws://127.0.0.1:"),
    )?.[0] as { auth?: { token?: string } } | undefined;
    expect(tunnelCall?.auth?.token).toBe("rtok");
    expect(sshStop).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    const targets = parsed.targets as Array<Record<string, unknown>>;
    expect(targets.some((t) => t.kind === "sshTunnel")).toBe(true);
  });

  it("skips invalid ssh-auto discovery targets", async () => {
    const { runtime } = createRuntimeCapture();
    await withUserEnv("steipete", async () => {
      loadConfig.mockReturnValueOnce({
        gateway: {
          mode: "remote",
          remote: { url: "", token: "" },
          auth: { token: "ltok" },
        },
      });
      discoverGatewayBeacons.mockResolvedValueOnce([
        { tailnetDns: "-V" },
        { tailnetDns: "goodhost" },
      ]);

      startSshPortForward.mockClear();
      const { gatewayStatusCommand } = await import("./gateway-status.js");
      await gatewayStatusCommand(
        { timeout: "1000", json: true, sshAuto: true },
        runtime as unknown as import("../runtime.js").RuntimeEnv,
      );

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      const call = startSshPortForward.mock.calls[0]?.[0] as { target: string };
      expect(call.target).toBe("steipete@goodhost");
    });
  });

  it("infers SSH target from gateway.remote.url and ssh config", async () => {
    const { runtime } = createRuntimeCapture();
    await withUserEnv("steipete", async () => {
      loadConfig.mockReturnValueOnce({
        gateway: {
          mode: "remote",
          remote: { url: "ws://peters-mac-studio-1.sheep-coho.ts.net:18789", token: "rtok" },
          auth: { token: "ltok" },
        },
      });
      resolveSshConfig.mockResolvedValueOnce({
        user: "steipete",
        host: "peters-mac-studio-1.sheep-coho.ts.net",
        port: 2222,
        identityFiles: ["/tmp/id_ed25519"],
      });

      startSshPortForward.mockClear();
      const { gatewayStatusCommand } = await import("./gateway-status.js");
      await gatewayStatusCommand(
        { timeout: "1000", json: true },
        runtime as unknown as import("../runtime.js").RuntimeEnv,
      );

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      const call = startSshPortForward.mock.calls[0]?.[0] as {
        target: string;
        identity?: string;
      };
      expect(call.target).toBe("steipete@peters-mac-studio-1.sheep-coho.ts.net:2222");
      expect(call.identity).toBe("/tmp/id_ed25519");
    });
  });

  it("falls back to host-only when USER is missing and ssh config is unavailable", async () => {
    const { runtime } = createRuntimeCapture();
    await withUserEnv("", async () => {
      loadConfig.mockReturnValueOnce({
        gateway: {
          mode: "remote",
          remote: { url: "wss://studio.example:18789", token: "rtok" },
          auth: { token: "ltok" },
        },
      });
      resolveSshConfig.mockResolvedValueOnce(null);

      startSshPortForward.mockClear();
      const { gatewayStatusCommand } = await import("./gateway-status.js");
      await gatewayStatusCommand(
        { timeout: "1000", json: true },
        runtime as unknown as import("../runtime.js").RuntimeEnv,
      );

      const call = startSshPortForward.mock.calls[0]?.[0] as {
        target: string;
      };
      expect(call.target).toBe("studio.example");
    });
  });

  it("keeps explicit SSH identity even when ssh config provides one", async () => {
    const { runtime } = createRuntimeCapture();

    loadConfig.mockReturnValueOnce({
      gateway: {
        mode: "remote",
        remote: { url: "wss://studio.example:18789", token: "rtok" },
        auth: { token: "ltok" },
      },
    });
    resolveSshConfig.mockResolvedValueOnce({
      user: "me",
      host: "studio.example",
      port: 22,
      identityFiles: ["/tmp/id_from_config"],
    });

    startSshPortForward.mockClear();
    const { gatewayStatusCommand } = await import("./gateway-status.js");
    await gatewayStatusCommand(
      { timeout: "1000", json: true, sshIdentity: "/tmp/explicit_id" },
      runtime as unknown as import("../runtime.js").RuntimeEnv,
    );

    const call = startSshPortForward.mock.calls[0]?.[0] as {
      identity?: string;
    };
    expect(call.identity).toBe("/tmp/explicit_id");
  });
});
