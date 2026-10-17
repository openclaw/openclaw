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
import { makeDirectPlugin } from "../test-utils/channel-plugin-test-fixtures.js";
import { channelsStatusCommand } from "./channels/status.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const {
  callGateway,
  resolveCommandConfigWithSecrets,
  readConfigFileSnapshot,
  requireValidConfig,
  listChannelPlugins,
  listConfiguredAnnounceChannelIdsForConfig,
  missingOfficialExternalChannels,
  repairHintChannelIdCalls,
} = vi.hoisted(() => ({
  callGateway: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
  readConfigFileSnapshot: vi.fn(async () => ({ path: "/tmp/openclaw.json" })),
  requireValidConfig: vi.fn(),
  listChannelPlugins: vi.fn(),
  listConfiguredAnnounceChannelIdsForConfig: vi.fn((_params: unknown) => ["discord"]),
  missingOfficialExternalChannels: new Set<string>(),
  repairHintChannelIdCalls: [] as string[][],
}));

vi.mock("../gateway/call.js", () => ({ callGateway }));

vi.mock("../cli/command-config-resolution.js", () => ({ resolveCommandConfigWithSecrets }));

vi.mock("../config/config.js", () => ({ readConfigFileSnapshot }));

vi.mock("./config-validation.js", () => ({ requireValidConfig }));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: (config: { channels?: Record<string, unknown> }) =>
    Object.keys(config.channels ?? {}),
  listConfiguredAnnounceChannelIdsForConfig,
}));

vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints: ({
    channelIds,
  }: {
    channelIds: string[];
  }) => {
    repairHintChannelIdCalls.push([...channelIds]);
    return channelIds
      .filter((id) => missingOfficialExternalChannels.has(id))
      .map(() => ({
        label: "Feishu",
        repairHint:
          "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
      }));
  },
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: (channel: string) =>
    channel === "clickclack" ? undefined : channel === "imsg" ? "imessage" : channel,
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => listChannelPlugins(),
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getConfiguredChannelsCommandSecretTargetIds: () => [],
}));

vi.mock("../infra/channels-status-issues.js", () => ({
  collectChannelStatusIssues: () => [],
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: async (_opts: unknown, run: () => Promise<unknown>) => await run(),
}));

function createTokenAccountSnapshot(cfg: OpenClawConfig & { secretResolved?: boolean }) {
  return {
    enabled: true,
    configured: true,
    tokenSource: "config",
    tokenStatus: cfg.secretResolved ? "available" : "configured_unavailable",
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

function fallbackConfig(config: OpenClawConfig & { secretResolved?: boolean }, resolved = config) {
  requireValidConfig.mockResolvedValue(config);
  resolveCommandConfigWithSecrets.mockResolvedValue({ resolvedConfig: resolved });
}

describe("channelsStatusCommand SecretRef fallback flow", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    callGateway.mockReset();
    resolveCommandConfigWithSecrets.mockReset();
    requireValidConfig.mockReset();
    missingOfficialExternalChannels.clear();
    repairHintChannelIdCalls.length = 0;
    listConfiguredAnnounceChannelIdsForConfig.mockClear();
    listConfiguredAnnounceChannelIdsForConfig.mockReturnValue(["discord"]);
    listChannelPlugins.mockReset().mockReturnValue([
      makeDirectPlugin({
        id: "discord",
        label: "Discord",
        docsPath: "/channels/discord",
        config: {
          listAccountIds: () => ["default"],
          inspectAccount: createTokenAccountSnapshot,
          resolveAccount: createTokenAccountSnapshot,
        },
      }),
    ]);
  });

  it("preserves a Gateway rejection instead of reporting it unreachable", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "unknown channel: missing-channel",
    });
    retainGatewayResponsePayload(error, undefined);
    callGateway.mockRejectedValueOnce(error);

    await expect(
      channelsStatusCommand({ channel: "missing-channel", json: false }, runtime),
    ).rejects.toBe(error);

    expect(requireValidConfig).not.toHaveBeenCalled();
    expect(resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

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
    callGateway.mockResolvedValueOnce({});

    await channelsStatusCommand(
      { channel: "imsg", probe: true, json: true, timeout: "5000" },
      runtime,
    );

    expect(callGateway).toHaveBeenCalledOnce();
    const request = callGateway.mock.calls[0]?.[0];
    expect(validateChannelsStatusParams(request?.params)).toBe(true);
    expect(request).toMatchObject({
      params: { channel: "imsg", timeoutMs: 3750 },
      timeoutMs: 3750,
      sharedStateMode: "read-only",
    });
  });

  afterEach(() => vi.restoreAllMocks());

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
    expect(callGateway).not.toHaveBeenCalled();
    expect(requireValidConfig).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps read-only SecretRef fallback output (auth unavailable=%s)",
    async (auth) => {
      callGateway.mockRejectedValue(
        auth
          ? new GatewaySecretRefUnavailableError("gateway.auth.password")
          : createGatewayTransportError(),
      );
      const [notice, absent] = auth
        ? ["Gateway auth unavailable", "Gateway not reachable"]
        : ["Gateway not reachable", "Gateway auth unavailable"];
      const stderr = auth ? notice : "Couldn't connect to OpenClaw.";
      fallbackConfig({ secretResolved: false, channels: {} });
      const { runtime, logs, errors } = createCapturingTestRuntime();
      await channelsStatusCommand({ probe: false }, runtime);
      expect(errors.join("\n")).toContain(stderr);
      expect(errors.join("\n")).not.toContain(absent);
      expect(resolveCommandConfigWithSecrets).toHaveBeenCalledOnce();
      expect(resolveCommandConfigWithSecrets.mock.calls[0]?.[0]).toMatchObject({
        commandName: "channels status",
        mode: "read_only_status",
      });
      const joined = logs.join("\n");
      expect(joined).toContain(notice + "; showing config-only status.");
      expect(joined).not.toContain(absent + "; showing config-only status.");
      expect(joined).toContain("configured, secret unavailable in this command path");
      if (auth) {
        const { runtime: jsonRuntime, logs: jsonLogs } = createCapturingTestRuntime();
        await channelsStatusCommand({ json: true, probe: false }, jsonRuntime);
        expect(JSON.parse(jsonLogs.at(-1) ?? "{}").gatewayAuthUnavailable).toBe(true);
      } else {
        expect(joined).toContain("token:config (unavailable)");
      }
    },
  );

  it("resolves config-only repair hints only for the requested channel", async () => {
    callGateway.mockRejectedValue(new Error("gateway closed"));
    const config = { channels: { feishu: { appId: "cli_xxx" }, matrix: { enabled: true } } };
    fallbackConfig(config);

    missingOfficialExternalChannels.add("feishu");
    missingOfficialExternalChannels.add("matrix");
    listChannelPlugins.mockReturnValue([]);
    const { runtime } = createCapturingTestRuntime();

    await channelsStatusCommand({ channel: "feishu", probe: false }, runtime);

    expect(repairHintChannelIdCalls).toEqual([["feishu"]]);
  });

  it("keeps JSON fallback structured without rendering config-only text", async () => {
    callGateway.mockRejectedValue(
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

    expect(listChannelPlugins).not.toHaveBeenCalled();
    expect(listConfiguredAnnounceChannelIdsForConfig).toHaveBeenCalledOnce();
    expect(listConfiguredAnnounceChannelIdsForConfig.mock.calls[0]?.[0]).toMatchObject({
      config: { secretResolved: true },
      activationSourceConfig: { secretResolved: false },
    });
    const payload = JSON.parse(logs.at(-1) ?? "{}");
    expect(errors).toEqual([]);
    expect(payload.error).toContain("Gateway target:");
    for (const secret of [
      "user:pass",
      "secret-token",
      "fallback-user:fallback-pass",
      "fallback-secret",
    ]) {
      expect(payload.error).not.toContain(secret);
    }
    expect(payload).toMatchObject({
      gatewayReachable: false,
      gatewayAuthUnavailable: false,
      configOnly: true,
    });
    expect(payload.configuredChannels).toStrictEqual([]);
  });

  it.each([
    { channel: "all", channels: { clickclack: { enabled: true } }, configured: ["clickclack"] },
    {
      channel: "clickclack",
      channels: { clickclack: { enabled: true }, telegram: { enabled: true } },
      configured: ["clickclack", "telegram"],
    },
  ])("filters $channel JSON config-only fallback", async ({ channel, channels, configured }) => {
    callGateway.mockRejectedValue(new Error("gateway closed"));
    fallbackConfig({ channels });
    listConfiguredAnnounceChannelIdsForConfig.mockReturnValue(configured);
    const { runtime, logs } = createCapturingTestRuntime();
    await channelsStatusCommand({ channel, json: true, probe: false }, runtime);
    const payload = JSON.parse(logs.at(-1) ?? "{}");
    expect(payload).toMatchObject({ gatewayReachable: false, configOnly: true });
    expect(payload.configuredChannels).toStrictEqual(["clickclack"]);
  });
});
