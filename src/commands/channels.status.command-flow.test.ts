// Channels status command-flow tests cover gateway calls, config fallback, and timeout validation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retainGatewayResponsePayload } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";

vi.mock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: vi.fn(async () => undefined),
}));
import { validateChannelsStatusParams } from "../../packages/gateway-protocol/src/index.js";
import { waitForGatewayDiagnosticReadiness } from "../cli/daemon-cli/diagnostic-readiness.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { channelsStatusCommand } from "./channels/status.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const resolveDefaultAccountId = () => DEFAULT_ACCOUNT_ID;

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
  readConfigFileSnapshot: vi.fn(async () => ({ path: "/tmp/openclaw.json" })),
  requireValidConfig: vi.fn(),
  listChannelPlugins: vi.fn(),
  listConfiguredAnnounceChannelIdsForConfig: vi.fn((_params: unknown) => ["discord"]),
  missingOfficialExternalChannels: new Set<string>(),
  repairHintChannelIdCalls: [] as string[][],
  withProgress: vi.fn(async (_opts: unknown, run: () => Promise<unknown>) => await run()),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.callGateway(opts),
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: async (opts: {
    runtime?: { log: (message: string) => void };
  }) => {
    const result = await mocks.resolveCommandConfigWithSecrets(opts);
    for (const entry of result?.diagnostics ?? []) {
      opts.runtime?.log(`[secrets] ${entry}`);
    }
    return result;
  },
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: () => mocks.readConfigFileSnapshot(),
}));

vi.mock("./config-validation.js", () => ({
  requireValidConfig: (runtime: unknown) => mocks.requireValidConfig(runtime),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: (config: { channels?: Record<string, unknown> }) =>
    Object.keys(config.channels ?? {}),
  listConfiguredAnnounceChannelIdsForConfig: (params: unknown) =>
    mocks.listConfiguredAnnounceChannelIdsForConfig(params),
}));

vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints: ({
    channelIds,
  }: {
    channelIds: string[];
  }) => {
    mocks.repairHintChannelIdCalls.push([...channelIds]);
    return channelIds.flatMap((channelId) =>
      mocks.missingOfficialExternalChannels.has(channelId)
        ? [
            {
              pluginId: channelId,
              channelId,
              label: "Feishu",
              installSpec: "@openclaw/feishu",
              installCommand: "openclaw plugins install @openclaw/feishu",
              doctorFixCommand: "openclaw doctor --fix",
              repairHint:
                "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
            },
          ]
        : [],
    );
  },
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => mocks.listChannelPlugins(),
  getChannelPlugin: (channel: string) =>
    (mocks.listChannelPlugins() as Array<{ id: string }>).find((plugin) => plugin.id === channel),
  normalizeChannelId: (channel: string) =>
    channel === "clickclack" ? undefined : channel === "imsg" ? "imessage" : channel,
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => mocks.listChannelPlugins(),
}));

vi.mock("../channels/plugins/status.js", () => ({
  buildReadOnlySourceChannelAccountSnapshot: async ({
    plugin,
    cfg,
    accountId,
  }: {
    plugin: ReturnType<typeof createTokenOnlyPlugin>;
    cfg: { secretResolved?: boolean };
    accountId: string;
  }) => ({
    accountId,
    ...plugin.config.inspectAccount(cfg),
  }),
  resolveChannelAccountSnapshot: async ({
    plugin,
    cfg,
    accountId,
  }: {
    plugin: ReturnType<typeof createTokenOnlyPlugin>;
    cfg: { secretResolved?: boolean };
    accountId: string;
  }) => ({
    accountId,
    ...plugin.config.resolveAccount(cfg),
  }),
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getConfiguredChannelsCommandSecretTargetIds: () => [],
}));

vi.mock("../infra/channels-status-issues.js", () => ({
  collectChannelStatusIssues: () => [],
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: (opts: unknown, run: () => Promise<unknown>) => mocks.withProgress(opts, run),
}));

function createTokenAccountSnapshot(cfg: { secretResolved?: boolean }) {
  return {
    name: "Primary",
    enabled: true,
    configured: true,
    token: cfg.secretResolved ? "resolved-discord-token" : "",
    tokenSource: "config",
    tokenStatus: cfg.secretResolved ? "available" : "configured_unavailable",
  };
}

function createTokenOnlyPlugin() {
  return {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      defaultAccountId: resolveDefaultAccountId,
      inspectAccount: createTokenAccountSnapshot,
      resolveAccount: createTokenAccountSnapshot,
      isConfigured: () => true,
      isEnabled: () => true,
    },
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
  };
}

function createGatewayTransportError(message = "Gateway not reachable (ECONNREFUSED).") {
  return new GatewayTransportError({
    kind: "closed",
    message,
    connectionDetails: {
      url: "ws://127.0.0.1:18997",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18997",
    },
  });
}

function fallbackConfig(
  config: OpenClawConfig & { secretResolved?: boolean },
  resolved = config,
  diagnostics: string[] = [],
) {
  mocks.requireValidConfig.mockResolvedValue(config);
  mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
    resolvedConfig: resolved,
    effectiveConfig: resolved,
    diagnostics,
  });
}

describe("channelsStatusCommand SecretRef fallback flow", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.callGateway.mockReset();
    mocks.resolveCommandConfigWithSecrets.mockReset();
    mocks.readConfigFileSnapshot.mockClear();
    mocks.requireValidConfig.mockReset();
    mocks.listChannelPlugins.mockReset();
    mocks.missingOfficialExternalChannels.clear();
    mocks.repairHintChannelIdCalls.length = 0;
    mocks.listConfiguredAnnounceChannelIdsForConfig.mockClear();
    mocks.listConfiguredAnnounceChannelIdsForConfig.mockReturnValue(["discord"]);
    mocks.withProgress.mockClear();
    mocks.listChannelPlugins.mockReturnValue([createTokenOnlyPlugin()]);
  });

  it.each([false])(
    "preserves a Gateway rejection instead of reporting it unreachable (json=%s)",
    async (json) => {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const error = new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown channel: missing-channel",
      });
      retainGatewayResponsePayload(error, undefined);
      mocks.callGateway.mockRejectedValueOnce(error);

      await expect(
        channelsStatusCommand({ channel: "missing-channel", json }, runtime),
      ).rejects.toBe(error);

      expect(mocks.requireValidConfig).not.toHaveBeenCalled();
      expect(mocks.resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it("sends valid channel RPC parameters after fractional startup timing", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    vi.mocked(waitForGatewayDiagnosticReadiness).mockImplementationOnce(async () => {
      vi.spyOn(performance, "now").mockReturnValue(1250.25);
      return {
        healthy: true,
        waitOutcome: "healthy",
        elapsedMs: 1250.25,
        runtime: { status: "running", pid: 42 },
        portUsage: { port: 18789, status: "busy", listeners: [{ pid: 42 }], hints: [] },
        staleGatewayPids: [],
      };
    });
    mocks.callGateway.mockResolvedValueOnce({});

    await channelsStatusCommand(
      { channel: "imsg", probe: true, json: true, timeout: "5000" },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    const request = mocks.callGateway.mock.calls[0]?.[0];
    expect(validateChannelsStatusParams(request?.params)).toBe(true);
    expect(request?.params.channel).toBe("imsg");
    expect(request?.params.timeoutMs).toBe(3750);
    expect(request?.timeoutMs).toBe(3750);
    expect(request?.sharedStateMode).toBe("read-only");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports pending startup in JSON without falling back to a Gateway error", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    vi.mocked(waitForGatewayDiagnosticReadiness).mockResolvedValueOnce({
      healthy: false,
      waitOutcome: "still-starting",
      startupPhase: "startup-sidecars",
      elapsedMs: 60_000,
      runtime: { status: "running", pid: 42 },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
      staleGatewayPids: [],
    });
    await channelsStatusCommand({ probe: true, json: true }, runtime);
    expect(runtime.log.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { status: "starting", startupPhase: "startup-sidecars" },
    ]);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.requireValidConfig).not.toHaveBeenCalled();
  });

  it("keeps read-only fallback output when SecretRefs are unresolved", async () => {
    mocks.callGateway.mockRejectedValue(createGatewayTransportError());
    fallbackConfig({ secretResolved: false, channels: {} }, undefined, [
      "channels status: channels.discord.token is unavailable in this command path; continuing with degraded read-only config.",
    ]);
    const { runtime, logs, errors } = createCapturingTestRuntime();

    await channelsStatusCommand({ probe: false }, runtime);

    expect(errors.join("\n")).toContain("Couldn't connect to OpenClaw.");
    expect(errors.join("\n")).not.toContain("Gateway auth unavailable");
    expect(mocks.resolveCommandConfigWithSecrets).toHaveBeenCalledOnce();
    const configResolutionRequest = mocks.resolveCommandConfigWithSecrets.mock.calls[0]?.[0];
    expect(configResolutionRequest?.commandName).toBe("channels status");
    expect(configResolutionRequest?.mode).toBe("read_only_status");
    expect(
      logs.some((line) =>
        line.includes("[secrets] channels status: channels.discord.token is unavailable"),
      ),
    ).toBe(true);
    const joined = logs.join("\n");
    expect(joined).toContain("Gateway not reachable; showing config-only status.");
    expect(joined).not.toContain("Gateway auth unavailable; showing config-only status.");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("token:config (unavailable)");
  });

  it("labels config-only fallback as auth-unavailable when gateway auth SecretRefs are unresolved", async () => {
    mocks.callGateway.mockRejectedValue(
      new GatewaySecretRefUnavailableError("gateway.auth.password"),
    );
    fallbackConfig({ secretResolved: false, channels: {} });

    const { runtime, logs, errors } = createCapturingTestRuntime();

    await channelsStatusCommand({ probe: false }, runtime);

    const errorOutput = errors.join("\n");
    expect(errorOutput).toContain("Gateway auth unavailable");
    expect(errorOutput).not.toContain("Gateway not reachable");
    const joined = logs.join("\n");
    expect(joined).toContain("Gateway auth unavailable; showing config-only status.");
    expect(joined).not.toContain("Gateway not reachable; showing config-only status.");
    expect(joined).toContain("configured, secret unavailable in this command path");

    const { runtime: jsonRuntime, logs: jsonLogs } = createCapturingTestRuntime();
    await channelsStatusCommand({ json: true, probe: false }, jsonRuntime);
    expect(JSON.parse(jsonLogs.at(-1) ?? "{}").gatewayAuthUnavailable).toBe(true);
  });

  it("resolves config-only repair hints only for the requested channel", async () => {
    mocks.callGateway.mockRejectedValue(new Error("gateway closed"));
    const config = { channels: { feishu: { appId: "cli_xxx" }, matrix: { enabled: true } } };
    fallbackConfig(config);

    mocks.missingOfficialExternalChannels.add("feishu");
    mocks.missingOfficialExternalChannels.add("matrix");
    mocks.listChannelPlugins.mockReturnValue([]);
    const { runtime } = createCapturingTestRuntime();

    await channelsStatusCommand({ channel: "feishu", probe: false }, runtime);

    expect(mocks.repairHintChannelIdCalls).toEqual([["feishu"]]);
  });

  it("keeps JSON fallback structured without rendering config-only text", async () => {
    mocks.callGateway.mockRejectedValue(
      createGatewayTransportError(
        [
          "gateway timeout after 3000ms",
          "Gateway target: wss://user:pass@gateway.example.com/socket?token=secret-token&keep=visible",
          "Gateway fallback: (wss://fallback-user:fallback-pass@[bad-host/socket?token=fallback-secret&keep=visible)",
          "Source: env OPENCLAW_GATEWAY_URL",
        ].join("\n"),
      ),
    );
    fallbackConfig({ secretResolved: false, channels: {} }, { secretResolved: true, channels: {} });

    const { runtime, logs, errors } = createCapturingTestRuntime();

    await channelsStatusCommand({ channel: "imsg", json: true, probe: false }, runtime);

    expect(mocks.listChannelPlugins).not.toHaveBeenCalled();
    expect(mocks.listConfiguredAnnounceChannelIdsForConfig).toHaveBeenCalledOnce();
    const announceRequest = mocks.listConfiguredAnnounceChannelIdsForConfig.mock.calls[0]?.[0] as
      | {
          config?: { secretResolved?: unknown };
          activationSourceConfig?: { secretResolved?: unknown };
        }
      | undefined;
    expect(announceRequest?.config?.secretResolved).toBe(true);
    expect(announceRequest?.activationSourceConfig?.secretResolved).toBe(false);
    const payload = JSON.parse(logs.at(-1) ?? "{}");
    expect(errors).toEqual([]);
    expect(errors.join("\n")).not.toContain("user:pass");
    expect(errors.join("\n")).not.toContain("secret-token");
    expect(errors.join("\n")).not.toContain("fallback-user:fallback-pass");
    expect(errors.join("\n")).not.toContain("fallback-secret");
    expect(payload.error).toContain("Gateway target:");
    expect(payload.error).not.toContain("user:pass");
    expect(payload.error).not.toContain("secret-token");
    expect(payload.error).not.toContain("fallback-user:fallback-pass");
    expect(payload.error).not.toContain("fallback-secret");
    expect(payload.gatewayReachable).toBe(false);
    expect(payload.gatewayAuthUnavailable).toBe(false);
    expect(payload.configOnly).toBe(true);
    expect(payload.configuredChannels).toStrictEqual([]);
  });

  it("treats all as no filter in JSON config-only fallback", async () => {
    mocks.callGateway.mockRejectedValue(new Error("gateway closed"));
    fallbackConfig({ channels: { clickclack: { enabled: true } } });

    mocks.listConfiguredAnnounceChannelIdsForConfig.mockReturnValue(["clickclack"]);
    const { runtime, logs } = createCapturingTestRuntime();

    await channelsStatusCommand({ channel: "all", json: true, probe: false }, runtime);

    const payload = JSON.parse(logs.at(-1) ?? "{}");
    expect(payload.gatewayReachable).toBe(false);
    expect(payload.configOnly).toBe(true);
    expect(payload.configuredChannels).toStrictEqual(["clickclack"]);
  });

  it("filters explicitly configured channels in JSON config-only fallback", async () => {
    mocks.callGateway.mockRejectedValue(new Error("gateway closed"));
    fallbackConfig({ channels: { clickclack: { enabled: true }, telegram: { enabled: true } } });

    mocks.listConfiguredAnnounceChannelIdsForConfig.mockReturnValue(["clickclack", "telegram"]);
    const { runtime, logs } = createCapturingTestRuntime();

    await channelsStatusCommand({ channel: "clickclack", json: true, probe: false }, runtime);

    const payload = JSON.parse(logs.at(-1) ?? "{}");
    expect(payload.configuredChannels).toStrictEqual(["clickclack"]);
  });
});
