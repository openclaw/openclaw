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
  const directTarget = "+15551230000";
  function buildExecRequest(
    to = directTarget,
    overrides: Partial<ExecApprovalRequest["request"]> = {},
  ): ExecApprovalRequest {
    return {
      id: "exec-1",
      request: {
        command: "echo hi",
        agentId: "main",
        turnSourceChannel: channel,
        turnSourceTo: to,
        turnSourceAccountId: "default",
        sessionKey: `agent:main:${channel}:${to}`,
        ...overrides,
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };
  }
  function buildPluginRequest(
    to = directTarget,
    overrides: Partial<PluginApprovalRequest["request"]> = {},
  ): PluginApprovalRequest {
    return {
      id: "plugin:approval-1",
      request: {
        title: "Plugin approval",
        description: "Allow plugin action",
        agentId: "main",
        turnSourceChannel: channel,
        turnSourceTo: to,
        turnSourceAccountId: "default",
        sessionKey: `agent:main:${channel}:${to}`,
        ...overrides,
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };
  }
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
  function getAvailability(
    cfg: OpenClawConfig,
    accountId = "default",
    approvalKind: ChannelApprovalKind = "exec",
  ) {
    return capability.getActionAvailabilityState?.({
      cfg,
      accountId,
      action: "approve",
      approvalKind,
    });
  }
  function describeDelivery(
    cfg: OpenClawConfig,
    request: ApprovalRequest,
    approvalKind: ChannelApprovalKind = "exec",
  ) {
    return capability.native?.describeDeliveryCapabilities({
      cfg,
      accountId: "default",
      approvalKind,
      request,
    });
  }
  function nativeShouldHandle(input: {
    cfg: OpenClawConfig;
    approvalKind: ChannelApprovalKind;
    request: ApprovalRequest;
    accountId?: string | null;
  }) {
    return capability.nativeRuntime?.availability.shouldHandle({
      ...input,
      accountId: input.accountId ?? "default",
      context: {},
    });
  }
  function resolveExecOrigin(cfg: OpenClawConfig, request: ExecApprovalRequest) {
    return capability.native?.resolveOriginTarget?.({
      cfg,
      accountId: "default",
      approvalKind: "exec",
      request,
    });
  }
  function suppressForwardingFallback(input: ForwardingParams) {
    return capability.delivery?.shouldSuppressForwardingFallback?.(input);
  }
  function suppressTargetForwarding(cfg: OpenClawConfig, to: string, request = buildExecRequest()) {
    return suppressForwardingFallback({
      cfg,
      approvalKind: "exec",
      target: { channel, to, source: "target" },
      request,
    });
  }
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
        expect(capability.nativeRuntime?.eventKinds).toContain("system-agent");
      },
      disabledByDefault: () => {
        const cfg = buildConfig();
        const execRequest = buildExecRequest();
        const pluginRequest = buildPluginRequest();
        expect(getAvailability(cfg)).toEqual({ kind: "disabled" });
        expect(getAvailability(cfg, "default", "plugin")).toEqual({ kind: "disabled" });
        expect(describeDelivery(cfg, execRequest)?.enabled).toBe(false);
        expect(nativeShouldHandle({ cfg, approvalKind: "exec", request: execRequest })).toBe(false);
        expect(nativeShouldHandle({ cfg, approvalKind: "plugin", request: pluginRequest })).toBe(
          false,
        );
      },
      sessionDelivery: () => {
        const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
        const request = buildExecRequest();
        expect(describeDelivery(cfg, request)).toEqual({
          enabled: true,
          preferredSurface: "origin",
          supportsOriginSurface: true,
          supportsApproverDmSurface: false,
          notifyOriginWhenDmOnly: true,
        });
        expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(true);
      },
      independentKinds: () => {
        const execOnly = buildConfig({ approvals: { exec: { enabled: true } } });
        const pluginOnly = buildConfig({ approvals: { plugin: { enabled: true } } });
        expect(
          nativeShouldHandle({
            cfg: execOnly,
            approvalKind: "plugin",
            request: buildPluginRequest(),
          }),
        ).toBe(false);
        expect(
          nativeShouldHandle({
            cfg: pluginOnly,
            approvalKind: "exec",
            request: buildExecRequest(),
          }),
        ).toBe(false);
        expect(
          nativeShouldHandle({
            cfg: pluginOnly,
            approvalKind: "plugin",
            request: buildPluginRequest(),
          }),
        ).toBe(true);
      },
      foreignOrigin: () => {
        const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
        const request = buildExecRequest("", {
          turnSourceChannel: "slack",
          turnSourceTo: "C123",
          sessionKey: "agent:main:slack:channel:c123",
        });
        expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(false);
        expect(describeDelivery(cfg, request)?.enabled).toBe(false);
      },
      targetMode: (cfg = buildTargetModeConfig("exec", [{ channel, to: directTarget }])) => {
        const request = buildExecRequest();
        expect(getAvailability(cfg)).toEqual({ kind: "enabled" });
        expect(
          capability.nativeRuntime?.availability.isConfigured({
            cfg,
            accountId: "default",
            context: {},
          }),
        ).toBe(false);
        expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(false);
        expect(describeDelivery(cfg, request)?.enabled).toBe(false);
      },
      noMatchingTarget: () => {
        const cfg = buildTargetModeConfig("exec", [{ channel: "slack", to: "C123" }]);
        expect(getAvailability(cfg)).toEqual({ kind: "disabled" });
      },
      requestFilters: () => {
        const request = buildExecRequest(directTarget, {
          agentId: "main",
          sessionKey: `agent:main:${channel}:+15551230000`,
        });
        const blockedByAgent = buildConfig({
          approvals: { exec: { enabled: true, agentFilter: ["other"] } },
        });
        const blockedBySession = buildConfig({
          approvals: { exec: { enabled: true, sessionFilter: ["telegram"] } },
        });
        expect(nativeShouldHandle({ cfg: blockedByAgent, approvalKind: "exec", request })).toBe(
          false,
        );
        expect(nativeShouldHandle({ cfg: blockedBySession, approvalKind: "exec", request })).toBe(
          false,
        );
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
      exactSessionTarget: () => {
        const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
        const request = buildExecRequest();
        for (const [to, expected] of [
          [directTarget, true],
          ["+15550000000", false],
        ] as const) {
          expect(
            suppressForwardingFallback({
              cfg,
              approvalKind: "exec",
              target: { channel, to, accountId: "default", source: "session" },
              request,
            }),
          ).toBe(expected);
        }
      },
      targetOnlyFallback: () => {
        const cfg = buildTargetModeConfig("exec", [{ channel, to: "+15550000000" }]);
        expect(suppressTargetForwarding(cfg, "+15550000000")).toBe(false);
      },
      unscopedBothTarget: () => {
        const cfg = buildTargetModeConfig("exec", [{ channel, to: directTarget }], {
          mode: "both",
        });
        expect(suppressTargetForwarding(cfg, directTarget)).toBe(true);
      },
      defaultAccountBothTarget: () => {
        const cfg = buildTargetModeConfig("exec", [{ channel, to: directTarget }], {
          mode: "both",
          channel: {
            defaultAccount: "work",
            accounts: { default: { enabled: true }, work: { enabled: true } },
          },
        });
        expect(
          suppressTargetForwarding(
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
  function buildLocalApprovalPayload(
    input: {
      approvalKind?: ChannelApprovalKind;
      agentId?: string | null;
      sessionKey?: string | null;
    } = {},
  ) {
    return {
      text: "Approval required.",
      channelData: {
        execApproval: {
          approvalId: input.approvalKind === "plugin" ? "plugin:approval-1" : "exec-1",
          approvalSlug: input.approvalKind === "plugin" ? "plugin:approval-1" : "exec-1",
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
      eligibleSession: () => {
        const cfg = buildConfig({
          channel: { allowFrom: ["+15551230000"] },
          approvals: { exec: { enabled: true, agentFilter: ["main"] } },
        });
        expect(
          suppressLocalSessionPrompt(cfg, `agent:main:${channel}:+15551230000`, {
            accountId: "default",
            agentId: null,
          }),
        ).toBe(true);
      },
      inactiveRoutes: () => {
        const enabledConfig = buildConfig({
          channel: { allowFrom: ["+15551230000"] },
          approvals: { exec: { enabled: true } },
        });
        const payload = buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: `agent:main:${channel}:+15551230000`,
        });
        const routes: LocalSuppressionParams[] = [
          { cfg: buildConfig(), payload },
          {
            cfg: buildConfig({
              channel: { allowFrom: ["+15551230000"] },
              approvals: { exec: { enabled: false } },
            }),
            payload,
          },
          {
            cfg: buildConfig({
              channel: { allowFrom: ["+15551230000"] },
              approvals: {
                exec: {
                  enabled: true,
                  mode: "targets",
                  targets: [{ channel, to: "+15551230000" }],
                },
              },
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
        const cfg = buildConfig({
          channel: { allowFrom: ["+15551230000"] },
          approvals: { exec: { enabled: true, agentFilter: ["ops"], sessionFilter: [channel] } },
        });
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
