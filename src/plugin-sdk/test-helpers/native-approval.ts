import { expect } from "vitest";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../../infra/plugin-approvals.js";
import type { ChannelApprovalCapability, ChannelOutboundPayloadHint } from "../channel-contract.js";
import type { OpenClawConfig } from "../config-contracts.js";
import type { ReplyPayload } from "../reply-runtime.js";

type ApprovalTestConfig = {
  channel?: {
    enabled?: boolean;
    allowFrom?: string[];
    defaultAccount?: string;
    accounts?: Record<string, { enabled?: boolean }>;
  };
  approvals?: OpenClawConfig["approvals"];
};
type ApprovalConfigBuilder = (params?: ApprovalTestConfig) => OpenClawConfig;
type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ForwardingParams = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0];

export function createNativeApprovalTestFixture(params: {
  channel: string;
  capability: ChannelApprovalCapability;
  buildConfig: ApprovalConfigBuilder;
}) {
  const { channel, capability, buildConfig } = params;
  const native = capability.nativeAsync ?? capability.native;
  const nativeRuntime = capability.nativeRuntimeAsync ?? capability.nativeRuntime;
  const directTarget = "+15551230000";
  const origin = (to: string) => ({
    agentId: "main",
    turnSourceChannel: channel,
    turnSourceTo: to,
    turnSourceAccountId: "default",
    sessionKey: `agent:main:${channel}:${to}`,
  });
  const envelope = <T extends ApprovalRequest["request"]>(id: string, request: T) => ({
    id,
    request,
    createdAtMs: 0,
    expiresAtMs: 1000,
  });
  const buildExecRequest = (
    to = directTarget,
    overrides: Partial<ExecApprovalRequest["request"]> = {},
  ): ExecApprovalRequest => envelope("exec-1", { command: "echo hi", ...origin(to), ...overrides });
  const buildPluginRequest = (
    to = directTarget,
    overrides: Partial<PluginApprovalRequest["request"]> = {},
  ): PluginApprovalRequest =>
    envelope("plugin:approval-1", {
      title: "Plugin approval",
      description: "Allow plugin action",
      ...origin(to),
      ...overrides,
    });
  function buildTargetModeConfig(
    approvalKind: "exec" | "plugin",
    targets: Array<{ channel: string; to: string; accountId?: string }>,
    options: { mode?: "targets" | "both"; channel?: ApprovalTestConfig["channel"] } = {},
  ) {
    return buildConfig({
      channel: options.channel,
      approvals: { [approvalKind]: { enabled: true, mode: options.mode ?? "targets", targets } },
    });
  }
  const getAvailability = (
    cfg: OpenClawConfig,
    accountId = "default",
    approvalKind: ChannelApprovalKind = "exec",
  ) => capability.getActionAvailabilityState?.({ cfg, accountId, action: "approve", approvalKind });
  const describeDelivery = async (
    cfg: OpenClawConfig,
    request: ApprovalRequest,
    approvalKind: ChannelApprovalKind = "exec",
  ) => native?.describeDeliveryCapabilities({ cfg, accountId: "default", approvalKind, request });
  const nativeShouldHandle = async (input: {
    cfg: OpenClawConfig;
    approvalKind: ChannelApprovalKind;
    request: ApprovalRequest;
    accountId?: string | null;
  }) =>
    nativeRuntime?.availability.shouldHandle({
      ...input,
      accountId: input.accountId ?? "default",
      context: {},
    });
  const resolveExecOrigin = async (cfg: OpenClawConfig, request: ExecApprovalRequest) =>
    native?.resolveOriginTarget?.({ cfg, accountId: "default", approvalKind: "exec", request });
  const suppressForwardingFallback = async (input: ForwardingParams) =>
    (
      capability.delivery?.shouldSuppressForwardingFallbackAsync ??
      capability.delivery?.shouldSuppressForwardingFallback
    )?.(input);
  const suppressTargetForwarding = (
    cfg: OpenClawConfig,
    to: string,
    request = buildExecRequest(),
  ) =>
    suppressForwardingFallback({
      cfg,
      approvalKind: "exec",
      target: { channel, to, source: "target" },
      request,
    });
  const expectHandling = async (
    cfg: OpenClawConfig,
    request: ApprovalRequest,
    expected: boolean,
    approvalKind: ChannelApprovalKind = "exec",
  ) => expect(await nativeShouldHandle({ cfg, approvalKind, request })).toBe(expected);
  const enabledConfig = (
    exec: NonNullable<OpenClawConfig["approvals"]>["exec"] = { enabled: true },
  ) => buildConfig({ approvals: { exec } });
  return {
    buildConfig,
    buildExecRequest,
    buildPluginRequest,
    buildTargetModeConfig,
    describeDelivery,
    nativeShouldHandle,
    resolveExecOrigin,
    checks: {
      systemAgentEvents: () => {
        expect(nativeRuntime?.eventKinds).toContain("system-agent");
      },
      disabledByDefault: async () => {
        const cfg = buildConfig();
        const execRequest = buildExecRequest();
        expect(getAvailability(cfg)).toEqual({ kind: "disabled" });
        expect(getAvailability(cfg, "default", "plugin")).toEqual({ kind: "disabled" });
        expect((await describeDelivery(cfg, execRequest))?.enabled).toBe(false);
        await expectHandling(cfg, execRequest, false);
        await expectHandling(cfg, buildPluginRequest(), false, "plugin");
      },
      sessionDelivery: async () => {
        const cfg = enabledConfig();
        const request = buildExecRequest();
        expect(await describeDelivery(cfg, request)).toEqual({
          enabled: true,
          preferredSurface: "origin",
          supportsOriginSurface: true,
          supportsApproverDmSurface: false,
          notifyOriginWhenDmOnly: true,
        });
        await expectHandling(cfg, request, true);
      },
      independentKinds: async () => {
        const execOnly = enabledConfig();
        const pluginOnly = buildConfig({ approvals: { plugin: { enabled: true } } });
        await expectHandling(execOnly, buildPluginRequest(), false, "plugin");
        await expectHandling(pluginOnly, buildExecRequest(), false);
        await expectHandling(pluginOnly, buildPluginRequest(), true, "plugin");
      },
      foreignOrigin: async () => {
        const cfg = enabledConfig();
        const request = buildExecRequest("", {
          turnSourceChannel: "slack",
          turnSourceTo: "C123",
          sessionKey: "agent:main:slack:channel:c123",
        });
        await expectHandling(cfg, request, false);
        expect((await describeDelivery(cfg, request))?.enabled).toBe(false);
      },
      targetMode: async (cfg = buildTargetModeConfig("exec", [{ channel, to: directTarget }])) => {
        const request = buildExecRequest();
        expect(getAvailability(cfg)).toEqual({ kind: "enabled" });
        expect(
          await nativeRuntime?.availability.isConfigured({
            cfg,
            accountId: "default",
            context: {},
          }),
        ).toBe(false);
        await expectHandling(cfg, request, false);
        expect((await describeDelivery(cfg, request))?.enabled).toBe(false);
      },
      noMatchingTarget: () => {
        const cfg = buildTargetModeConfig("exec", [{ channel: "slack", to: "C123" }]);
        expect(getAvailability(cfg)).toEqual({ kind: "disabled" });
      },
      requestFilters: async () => {
        const request = buildExecRequest();
        const blockedByAgent = enabledConfig({ enabled: true, agentFilter: ["other"] });
        const blockedBySession = enabledConfig({ enabled: true, sessionFilter: ["telegram"] });
        await expectHandling(blockedByAgent, request, false);
        await expectHandling(blockedBySession, request, false);
      },
      accountScopedTargets: () => {
        const cfg = buildTargetModeConfig(
          "exec",
          [{ channel, to: directTarget, accountId: "work" }],
          { channel: { accounts: { work: { enabled: true } } } },
        );
        expect(getAvailability(cfg)).toEqual({ kind: "disabled" });
        expect(getAvailability(cfg, "work")).toEqual({ kind: "enabled" });
      },
      exactSessionTarget: async () => {
        const cfg = enabledConfig();
        const request = buildExecRequest();
        for (const [to, expected] of [
          [directTarget, true],
          ["+15550000000", false],
        ] as const) {
          expect(
            await suppressForwardingFallback({
              cfg,
              approvalKind: "exec",
              target: { channel, to, accountId: "default", source: "session" },
              request,
            }),
          ).toBe(expected);
        }
      },
      targetOnlyFallback: async () => {
        const cfg = buildTargetModeConfig("exec", [{ channel, to: "+15550000000" }]);
        expect(await suppressTargetForwarding(cfg, "+15550000000")).toBe(false);
      },
      unscopedBothTarget: async () => {
        const cfg = buildTargetModeConfig("exec", [{ channel, to: directTarget }], {
          mode: "both",
        });
        expect(await suppressTargetForwarding(cfg, directTarget)).toBe(true);
      },
      defaultAccountBothTarget: async () => {
        const cfg = buildTargetModeConfig("exec", [{ channel, to: directTarget }], {
          mode: "both",
          channel: {
            defaultAccount: "work",
            accounts: { default: { enabled: true }, work: { enabled: true } },
          },
        });
        expect(
          await suppressTargetForwarding(
            cfg,
            directTarget,
            buildExecRequest(directTarget, { turnSourceAccountId: "work" }),
          ),
        ).toBe(true);
      },
    },
  };
}

type LocalSuppressionParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
};

export function createLocalApprovalPromptTestFixture(params: {
  channel: string;
  buildConfig: ApprovalConfigBuilder;
  suppress: (input: LocalSuppressionParams) => boolean;
}) {
  const { channel, buildConfig } = params;
  const activeExecHint = {
    kind: "approval-pending",
    approvalKind: "exec",
    nativeRouteActive: true,
  } as const;
  const localConfig = (exec: NonNullable<OpenClawConfig["approvals"]>["exec"]) =>
    buildConfig({ channel: { allowFrom: ["+15551230000"] }, approvals: { exec } });
  function buildLocalApprovalPayload(
    input: {
      approvalKind?: ChannelApprovalKind;
      agentId?: string | null;
      sessionKey?: string | null;
    } = {},
  ) {
    const approvalId = input.approvalKind === "plugin" ? "plugin:approval-1" : "exec-1";
    return {
      text: "Approval required.",
      channelData: {
        execApproval: {
          approvalId,
          approvalSlug: approvalId,
          approvalKind: input.approvalKind ?? "exec",
          agentId: input.agentId,
          sessionKey: input.sessionKey,
        },
      },
    };
  }
  function suppressLocalPrompt(input: LocalSuppressionParams) {
    return params.suppress({ ...input, hint: input.hint ?? activeExecHint });
  }
  function suppressLocalSessionPrompt(
    cfg: OpenClawConfig,
    sessionKey: string,
    input: { accountId?: string; agentId?: string | null } = {},
  ) {
    return suppressLocalPrompt({
      cfg,
      accountId: input.accountId,
      payload: buildLocalApprovalPayload({
        agentId: input.agentId === undefined ? "main" : input.agentId,
        sessionKey,
      }),
    });
  }
  return {
    suppressLocalSessionPrompt,
    checks: {
      inactiveRoutes: () => {
        const enabledConfig = localConfig({ enabled: true });
        const payload = buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: `agent:main:${channel}:+15551230000`,
        });
        const routes: LocalSuppressionParams[] = [
          { cfg: buildConfig(), payload },
          {
            cfg: localConfig({ enabled: false }),
            payload,
          },
          {
            cfg: localConfig({
              enabled: true,
              mode: "targets",
              targets: [{ channel, to: "+15551230000" }],
            }),
            payload,
          },
          { cfg: enabledConfig, payload, hint: { ...activeExecHint, nativeRouteActive: false } },
          { cfg: enabledConfig, payload: buildLocalApprovalPayload({ approvalKind: "plugin" }) },
          { cfg: enabledConfig, payload: { text: "Approval required." } },
        ];
        for (const route of routes) {
          expect(suppressLocalPrompt(route)).toBe(false);
        }
      },
      sessionFilters: () => {
        const cfg = localConfig({ enabled: true, agentFilter: ["ops"], sessionFilter: [channel] });
        for (const [sessionKey, expected] of [
          [`agent:ops:${channel}:+15551230000`, true],
          [`agent:main:${channel}:+15551230000`, false],
          ["agent:ops:slack:C123", false],
        ] as const) {
          expect(suppressLocalSessionPrompt(cfg, sessionKey, { agentId: null })).toBe(expected);
        }
      },
    },
  };
}
