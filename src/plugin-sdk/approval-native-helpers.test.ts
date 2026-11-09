import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createChannelApproverDmTargetResolver,
  createChannelApproverDmTargetResolverAsync,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalForwardingFallbackSuppressor,
  createNativeApprovalMessagingTargetResolvers,
  type NativeApprovalTarget,
  nativeApprovalTargetsMatch,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "./approval-native-helpers.js";
import type { OpenClawConfig } from "./config-contracts.js";

const EMPTY_SESSION_CFG = {
  session: { store: ".artifacts/test/approval-native-helpers-empty-sessions.json" },
} satisfies OpenClawConfig;

function createMatrixRouteGates(options?: {
  enabledAccounts?: readonly string[];
  accountIds?: readonly string[];
  defaultAccountId?: string;
}) {
  const enabledAccounts = new Set(options?.enabledAccounts ?? ["default"]);
  return createNativeApprovalChannelRouteGates<NativeApprovalTarget>({
    channel: "matrix",
    defaultForwardingMode: "session",
    isTransportEnabled: ({ accountId }) => enabledAccounts.has(accountId ?? "default"),
    listAccountIds: () => options?.accountIds ?? ["default"],
    resolveDefaultAccountId: () => options?.defaultAccountId ?? "default",
    normalizeForwardTarget: (target) =>
      target.channel === "matrix"
        ? {
            to: target.to,
            accountId: target.accountId ?? undefined,
            threadId: target.threadId ?? undefined,
          }
        : null,
    resolveTurnSourceTarget: (request) =>
      request.request.turnSourceChannel === "matrix" && request.request.turnSourceTo
        ? {
            to: request.request.turnSourceTo,
            accountId: request.request.turnSourceAccountId ?? undefined,
            threadId: request.request.turnSourceThreadId ?? undefined,
          }
        : null,
  });
}

const matrixRoute = {
  agentId: "agent-a",
  sessionKey: "agent:agent-a:matrix:room-1",
  turnSourceAccountId: "default",
  turnSourceChannel: "matrix",
  turnSourceTo: "room-1",
};
const matrixExecRequest = {
  id: "req-1",
  request: { ...matrixRoute, command: "echo hi" },
  createdAtMs: 0,
  expiresAtMs: 1000,
} as const;

const matrixPluginRequest = {
  ...matrixExecRequest,
  id: "plugin:req-1",
  request: { ...matrixRoute, description: "Allow access", title: "Plugin approval" },
} as const;

function execRequest(request: Partial<ExecApprovalRequest["request"]>) {
  return { ...matrixExecRequest, request: { command: "echo hi", ...request } };
}

const matrixTarget = { channel: "matrix", to: "room-1", source: "target" } as const;
const targetsConfig = {
  approvals: {
    exec: { enabled: true, mode: "targets", targets: [{ channel: "matrix", to: "room-1" }] },
  },
} satisfies OpenClawConfig;

describe("createNativeApprovalMessagingTargetResolvers", () => {
  const resolvers = createNativeApprovalMessagingTargetResolvers({
    channel: "signal",
    normalizeTo: (to) => to.trim().toLowerCase() || null,
  });

  it("normalizes forwarding, turn-source, session, and resolved targets", () => {
    expect(
      resolvers.normalizeForwardTarget({
        channel: " SIGNAL ",
        to: " OWNER ",
        accountId: " work ",
        threadId: 42,
        source: "target",
      }),
    ).toEqual({ to: "owner", accountId: "work", threadId: 42 });
    expect(
      resolvers.resolveTurnSourceTarget(
        execRequest({
          ...matrixExecRequest.request,
          turnSourceChannel: " SIGNAL ",
          turnSourceTo: " OWNER ",
          turnSourceAccountId: " work ",
        }),
      ),
    ).toEqual({ to: "owner", accountId: "work" });
    expect(
      resolvers.resolveSessionTarget({ channel: "signal", to: " OWNER ", accountId: " work " }),
    ).toEqual({ to: "owner", accountId: "work" });
    expect(resolvers.normalizeTarget({ to: " OWNER ", threadId: 42 })).toEqual({
      to: "owner",
      threadId: 42,
    });
  });

  it("rejects other channels and invalid destinations", () => {
    expect(
      resolvers.normalizeForwardTarget({ channel: "slack", to: "owner", source: "target" }),
    ).toBeNull();
    expect(
      resolvers.resolveTurnSourceTarget(
        execRequest({
          ...matrixExecRequest.request,
          turnSourceChannel: "signal",
          turnSourceTo: " ",
        }),
      ),
    ).toBeNull();
    expect(resolvers.resolveSessionTarget({ channel: "signal", to: " " })).toBeNull();
    expect(resolvers.normalizeTarget({ to: " " })).toBeNull();
  });
});

describe("createNativeApprovalChannelRouteGates", () => {
  it("separates session-native and explicit target routing by approval family", () => {
    const gates = createMatrixRouteGates();
    const cfg = {
      approvals: {
        ...targetsConfig.approvals,
        plugin: { enabled: true, mode: "session" },
      },
    } satisfies OpenClawConfig;

    expect(gates.canApprovalPotentiallyRouteToChannel({ cfg, approvalKind: "exec" })).toBe(true);
    expect(
      gates.canApprovalPotentiallyRouteToChannel({
        cfg,
        approvalKind: "exec",
        nativeSessionOnly: true,
      }),
    ).toBe(false);
    expect(
      gates.canApprovalPotentiallyRouteToChannel({
        cfg,
        approvalKind: "plugin",
        nativeSessionOnly: true,
      }),
    ).toBe(true);
    expect(gates.isNativeApprovalHandlerConfigured({ cfg })).toBe(true);

    expect(gates.shouldHandleApprovalRequest({ cfg, request: matrixExecRequest })).toBe(false);
    expect(gates.shouldHandleApprovalRequest({ cfg, request: matrixPluginRequest })).toBe(true);
    expect(
      gates.isExplicitTargetEligible({
        cfg,
        approvalKind: "exec",
        request: matrixExecRequest,
        target: matrixTarget,
      }),
    ).toBe(true);
  });

  it("applies forwarding filters before accepting a session route", () => {
    const gates = createMatrixRouteGates();
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          agentFilter: ["agent-a"],
          sessionFilter: ["matrix:room"],
        },
      },
    } satisfies OpenClawConfig;

    const eligible = (request: ExecApprovalRequest) =>
      gates.isSessionApprovalEligible({ cfg, approvalKind: "exec", request });
    expect(eligible(matrixExecRequest)).toBe(true);
    expect(
      eligible(
        execRequest({
          ...matrixRoute,
          agentId: "agent-b",
          sessionKey: "agent:agent-b:matrix:room-1",
        }),
      ),
    ).toBe(false);
  });

  it("maps unscoped targets only to the default account", () => {
    const input = {
      cfg: targetsConfig,
      approvalKind: "exec",
      request: matrixExecRequest,
      target: matrixTarget,
    } as const;
    const eligible = (accountId: string, enabledAccounts = ["default", "work"]) =>
      createMatrixRouteGates({
        accountIds: ["default", "work"],
        enabledAccounts,
      }).isExplicitTargetEligible({ ...input, accountId });

    expect(eligible("default")).toBe(true);
    expect(eligible("work", ["work"])).toBe(false);
    expect(eligible("work")).toBe(false);
  });
});

describe("createChannelNativeOriginTargetResolver", () => {
  it("reuses shared turn-source routing and respects shouldHandle gating", () => {
    const resolveOriginTarget = createChannelNativeOriginTargetResolver<NativeApprovalTarget>({
      channel: "matrix",
      shouldHandleRequest: ({ accountId }) => accountId === "ops",
      resolveTurnSourceTarget: (request) => ({
        to: String(request.request.turnSourceTo),
        threadId: request.request.turnSourceThreadId ?? undefined,
      }),
      resolveSessionTarget: (sessionTarget) => ({
        to: sessionTarget.to,
        threadId: sessionTarget.threadId,
      }),
    });
    const input = {
      cfg: EMPTY_SESSION_CFG,
      request: {
        ...matrixPluginRequest,
        request: {
          title: "Plugin approval",
          description: "Allow access",
          turnSourceChannel: "matrix",
          turnSourceTo: "room:!room:example.org",
          turnSourceThreadId: "t1",
          turnSourceAccountId: "ops",
        },
      },
    };

    expect(resolveOriginTarget({ ...input, accountId: "ops" })).toEqual({
      to: "room:!room:example.org",
      threadId: "t1",
    });
    expect(resolveOriginTarget({ ...input, accountId: "other" })).toBeNull();
  });

  it("uses shared route semantics for the default target matcher", () => {
    const origin = { to: "-100123", threadId: 42.9 };
    const session = { to: "-100123", threadId: "42" };
    expect(nativeApprovalTargetsMatch({ channel: "telegram", left: origin, right: session })).toBe(
      true,
    );
    expect(
      nativeApprovalTargetsMatch({
        channel: "telegram",
        left: { to: "-100123", accountId: "work" },
        right: { to: "-100123" },
      }),
    ).toBe(false);

    const resolveOriginTarget = createChannelNativeOriginTargetResolver<NativeApprovalTarget>({
      channel: "telegram",
      resolveTurnSourceTarget: () => origin,
      resolveSessionTarget: () => session,
    });

    expect(
      resolveOriginTarget({
        cfg: EMPTY_SESSION_CFG,
        request: execRequest({
          turnSourceChannel: "telegram",
          turnSourceTo: "-100123",
          turnSourceThreadId: 42.9,
          turnSourceAccountId: "default",
        }),
      }),
    ).toEqual({ to: "-100123", threadId: 42.9 });
  });

  it("normalizes custom target shapes before invoking a custom matcher", () => {
    type ProviderTarget = { id: string; shard?: string };

    const resolveOriginTarget = createChannelNativeOriginTargetResolver<ProviderTarget>({
      channel: "custom",
      resolveTurnSourceTarget: () => ({ id: "ROOM-1", shard: "a" }),
      resolveSessionTarget: () => ({ id: "room-1", shard: "b" }),
      normalizeTarget: (target) => ({ ...target, id: target.id.toLowerCase() }),
      targetsMatch: (left, right) => left.id === right.id,
    });

    expect(
      resolveOriginTarget({
        cfg: EMPTY_SESSION_CFG,
        request: execRequest({
          sessionKey: "agent:main:custom:room-1",
          turnSourceChannel: "custom",
          turnSourceTo: "ROOM-1",
        }),
      }),
    ).toEqual({ id: "room-1", shard: "a" });
  });
});

describe("createChannelApproverDmTargetResolver", () => {
  it("warns once for the legacy factory and keeps awaited target preparation warning-free", async () => {
    using warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const params = {
      resolveApprovers: () => ["owner-1"],
      mapApprover: (approver: string) => ({ to: `user:${approver}` }),
    };
    const input = { cfg: {}, request: matrixExecRequest };
    await withPluginRuntimePluginScope({ pluginId: "approval-dm-compat-proof" }, async () => {
      const resolveAsync = createChannelApproverDmTargetResolverAsync(params);
      expect(await resolveAsync(input)).toEqual([{ to: "user:owner-1" }]);
      expect(warning).not.toHaveBeenCalled();
      const resolveSync = createChannelApproverDmTargetResolver(params);
      expect(resolveSync(input)).toEqual([{ to: "user:owner-1" }]);
      createChannelApproverDmTargetResolver(params);
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "createChannelApproverDmTargetResolver is deprecated; use createChannelApproverDmTargetResolverAsync",
      ),
      { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
    );
  });

  it("filters null targets and skips delivery when shouldHandle rejects the request", () => {
    const resolveApproverDmTargets = createChannelApproverDmTargetResolver({
      shouldHandleRequest: ({ approvalKind }) => approvalKind === "exec",
      resolveApprovers: () => ["owner-1", "owner-2", "skip-me"],
      mapApprover: (approver) => (approver === "skip-me" ? null : { to: `user:${approver}` }),
    });

    expect(
      resolveApproverDmTargets({
        cfg: {},
        accountId: "default",
        approvalKind: "exec",
        request: execRequest({}),
      }),
    ).toEqual([{ to: "user:owner-1" }, { to: "user:owner-2" }]);

    expect(
      resolveApproverDmTargets({
        cfg: {},
        accountId: "default",
        approvalKind: "plugin",
        request: {
          ...matrixPluginRequest,
          request: { title: "Plugin approval", description: "Allow access" },
        },
      }),
    ).toStrictEqual([]);
  });
});

describe("createNativeApprovalForwardingFallbackSuppressor", () => {
  const request = execRequest({
    turnSourceChannel: "matrix",
    turnSourceTo: "room-1",
    turnSourceAccountId: "default",
  });
  const input = { cfg: {}, approvalKind: "exec", request } as const;

  function createSuppressor(
    overrides: Partial<Parameters<typeof createNativeApprovalForwardingFallbackSuppressor>[0]> = {},
  ) {
    return createNativeApprovalForwardingFallbackSuppressor({
      channel: "matrix",
      normalizeForwardTarget: (target) =>
        target.channel === "matrix"
          ? { to: target.to, accountId: target.accountId ?? undefined }
          : null,
      resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
        ...forwardingTarget,
        accountId,
      }),
      isSessionRouteEligible: ({ approvalKind }) => approvalKind === "exec",
      resolveOriginTarget: () => ({ to: "room-1", accountId: "default" }),
      resolveApproverDmTargets: () => [{ to: "user-1", accountId: "default" }],
      ...overrides,
    });
  }

  it("suppresses session forwarding only when a native origin or approver DM matches", () => {
    const shouldSuppress = createSuppressor();
    const suppress = (to: string) =>
      shouldSuppress({ ...input, target: { channel: "matrix", to, source: "session" } });
    expect(suppress("room-1")).toBe(true);
    expect(suppress("user-1")).toBe(true);
    expect(suppress("other-room")).toBe(false);
  });

  it("requires explicit-target eligibility before suppressing target forwarding", () => {
    const targetInput = {
      ...input,
      target: { channel: "matrix", to: "room-1", source: "target" },
    } as const;
    expect(createSuppressor()(targetInput)).toBe(false);
    expect(createSuppressor({ isExplicitTargetEligible: () => true })(targetInput)).toBe(true);
  });
});

describe("shouldSuppressLocalNativeExecApprovalPrompt", () => {
  const payload = {
    text: "Approval required.",
    channelData: {
      execApproval: {
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        approvalKind: "exec",
        agentId: "main",
        sessionKey: "agent:main:discord:direct:123",
      },
    },
  };
  const activeExecHint = {
    kind: "approval-pending",
    approvalKind: "exec",
    nativeRouteActive: true,
  } as const;

  it("supports strict top-level native exec suppression", () => {
    const suppress = (agent: string) =>
      shouldSuppressLocalNativeExecApprovalPrompt({
        cfg: { approvals: { exec: { enabled: true, agentFilter: [agent] } } },
        payload,
        hint: activeExecHint,
        isTransportEnabled: () => true,
      });
    expect(suppress("main")).toBe(true);
    expect(suppress("other")).toBe(false);
  });

  it("supports channel-specific native exec client gates", () => {
    const suppress = (enabled: boolean) =>
      shouldSuppressLocalNativeExecApprovalPrompt({
        cfg: {},
        payload,
        hint: activeExecHint,
        isNativeDeliveryEnabled: () => enabled,
        resolveApprovalConfig: () => ({ enabled: true, sessionFilter: ["discord:direct"] }),
        enforceForwardingMode: false,
        fallbackAgentIdFromSessionKey: false,
      });
    expect(suppress(true)).toBe(true);
    expect(suppress(false)).toBe(false);
  });

  it("uses the plugin forwarding config and requires a matching native approval kind", () => {
    const pluginPayload = {
      ...payload,
      channelData: {
        execApproval: { ...payload.channelData.execApproval, approvalKind: "plugin" },
      },
    };
    const hint = { ...activeExecHint, approvalKind: "plugin" as const };
    const cfg = {
      approvals: {
        exec: { enabled: false },
        plugin: { enabled: true, agentFilter: ["main"] },
      },
    };
    const params = { cfg, payload: pluginPayload, hint, isTransportEnabled: () => true };

    expect(shouldSuppressLocalNativeExecApprovalPrompt(params)).toBe(true);
    expect(shouldSuppressLocalNativeExecApprovalPrompt({ ...params, hint: activeExecHint })).toBe(
      false,
    );
    expect(shouldSuppressLocalNativeExecApprovalPrompt({ ...params, payload })).toBe(false);
    expect(
      shouldSuppressLocalNativeExecApprovalPrompt({
        ...params,
        cfg: { approvals: { exec: { enabled: true }, plugin: { enabled: false } } },
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalNativeExecApprovalPrompt({
        ...params,
        cfg: { approvals: { plugin: { enabled: true, agentFilter: ["other"] } } },
      }),
    ).toBe(false);
  });
});
