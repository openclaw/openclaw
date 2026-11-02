import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, expect, it } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import {
  claimAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  consumeCronCreatorAuthorityGrant,
  mintCronCreatorAuthorityGrant,
} from "../cron-creator-authority-grant.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import {
  isDirectGatewayChatUserTurn,
  resolveGatewayChatCronCreatorAuthorityAdmission,
  resolveGatewayCronCreatorAuthorityAdmission,
} from "./cron-creator-authority-admission.js";
import type { GatewayClient } from "./shared-types.js";

const operationalRunInstance = createOperationalRunInstanceRef("run-local-operator-runtime");
const agentRuntimeIdentity: AgentRuntimeIdentity = {
  kind: "agentRuntime",
  agentId: "main",
  sessionKey: "agent:main:worker",
  operationalRunInstance,
  delegatedAuthority: { kind: "local", ...claimAgentRunDelegatedAuthority(operationalRunInstance) },
};

afterAll(resetAgentRunRegistryForTest);

function createClient(
  overrides: Partial<NonNullable<GatewayClient["internal"]>> = {},
  scopes = ["operator.admin"],
) {
  return {
    connect: { scopes },
    internal: { isLocalClient: true, ...overrides },
  } as unknown as GatewayClient;
}

function admitAgent({
  request,
  ...overrides
}: Partial<Omit<Parameters<typeof resolveGatewayCronCreatorAuthorityAdmission>[0], "request">> & {
  request?: Partial<AgentRunRequest>;
} = {}) {
  return resolveGatewayCronCreatorAuthorityAdmission({
    runId: "run-local-operator",
    resolvedSessionKey: "agent:main:main",
    client: createClient(),
    hasRestoredCronContinuation: false,
    isOneShotModelRun: false,
    ...overrides,
    request: { message: "create an automation", idempotencyKey: "run-local-operator", ...request },
  });
}

it.each([
  ["missing Gateway client", { client: null }],
  ["read-only client", { client: createClient({}, ["operator.read"]) }],
  ["ephemeral run", { resolvedSessionKey: "" }],
  ["spawned run", { spawnedBy: "agent:main:parent" }],
  ["external provenance", { inputProvenance: { kind: "external_user" } }],
  ["cron continuation", { hasRestoredCronContinuation: true }],
  ["model run", { isOneShotModelRun: true }],
  ["internal handoff", { request: { internalRuntimeHandoffId: "handoff-1" } }],
  ["model-run request", { request: { modelRun: true } }],
  ["exec approval followup", { request: { execApprovalFollowupExpectedSessionId: "session-1" } }],
  ["internal session effects", { request: { sessionEffects: "internal" } }],
  ["suppressed prompt persistence", { request: { suppressPromptPersistence: true } }],
  ["swarm collector", { request: { swarmCollector: true } }],
  ["completion event", { request: { internalEvents: [{ type: "task_completion" }] } }],
  ["ACP spawn", { request: { acpTurnSource: "manual_spawn" } }],
  ["subagent lane", { request: { lane: "subagent" } }],
  ["plugin run", { client: createClient({ pluginRuntimeOwnerId: "memory-core" }) }],
  ["synthetic run", { client: createClient({ syntheticClient: true }) }],
  ["delegated run", { client: createClient({ delegatedToolPolicyHandoffId: "handoff-1" }) }],
  ["approval runtime", { client: createClient({ approvalRuntime: true }) }],
  ["sender attribution", { client: createClient({ senderAttribution: { id: "sender-1" } }) }],
  ["tracked agent run", { client: createClient({ agentRunTracking: "plugin_subagent" }) }],
  ["plugin subagent requester", { client: createClient({ pluginSubagentRequester: {} as never }) }],
  ["runtime plugin grant", { client: createClient({ runtimePluginToolGrant: {} as never }) }],
  ["worker runtime", { client: createClient({ agentRuntimeIdentity }) }],
] as const)("rejects agent ingress from %s", (_label, override) => {
  expect(admitAgent(override as Parameters<typeof admitAgent>[0])).toBeUndefined();
});
type ChatParams = Parameters<typeof resolveGatewayChatCronCreatorAuthorityAdmission>[0];
function createChatParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    runId: "run-local-chat",
    resolvedSessionKey: "agent:main:main",
    client: createClient(),
    hasExplicitOrigin: false,
    hasRestoredCronContinuation: false,
    isIncognito: false,
    isReconnectResume: false,
    isSystemGenerated: false,
    turnKind: "main",
    isDirectExternalUser: true,
    ...overrides,
  };
}

function admitChat(overrides: Parameters<typeof createChatParams>[0] = {}) {
  return resolveGatewayChatCronCreatorAuthorityAdmission(createChatParams(overrides));
}

it.each([
  ["agent", admitAgent, "run-local-operator"],
  ["chat", admitChat, "run-local-chat"],
] as const)("mints for a direct local-admin %s turn", (_entry, admit, runId) => {
  expect(admit()).toEqual({ runId, callerOrigin: { kind: "local" } });
});

it.each(["agent", "chat"] as const)(
  "keeps %s creator grants bound to the original caller after request completion",
  async (entry) => {
    const context = {};
    const caller = captureGatewayDeviceRevocation(
      context,
      { deviceId: "original-device", role: "operator" },
      () => true,
    );
    const admission = expectDefined(
      entry === "agent"
        ? admitAgent({ isCurrent: caller.isCurrent })
        : admitChat({ isCurrent: caller.isCurrent }),
      "expected direct operator admission",
    );
    const release = retainGatewayDeviceRevocation(admission.isCurrent);
    caller.release();
    const capability = expectDefined(
      createCronCreatorAuthorityCapability(
        admission.runId,
        admission.callerOrigin,
        admission.managementEntitlement,
        admission.isCurrent,
      ),
      "expected creator capability",
    );
    try {
      await runWithCronCreatorAuthorityCapability(capability, async () => {
        const grant = mintCronCreatorAuthorityGrant(capability);
        invalidateGatewayDeviceRevocation(context, "original-device", "operator");
        expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow(
          "cron authority is no longer active",
        );
      });
    } finally {
      caller.release();
      release?.();
    }
  },
);

it.each([
  ["Incognito", { isIncognito: true }],
  ["fresh message after reconnect", { isReconnectResume: true }],
] as const)("keeps %s dashboard input separate from cron authority", (_label, mode) => {
  const params = createChatParams({
    client: createClient({ isLocalClient: undefined, controlUiAdmin: true }),
    ...mode,
  });
  expect(isDirectGatewayChatUserTurn(params)).toBe(true);
  expect(resolveGatewayChatCronCreatorAuthorityAdmission(params)).toBeUndefined();
  expect(isDirectGatewayChatUserTurn({ ...params, isDirectExternalUser: false })).toBe(false);
});

it.each([true, undefined] as const)(
  "retains host-attested Control UI admin authority with locality %s",
  (isLocalClient) => {
    const client = createClient({ isLocalClient, controlUiAdmin: true });
    expect(admitChat({ client })).toEqual({
      runId: "run-local-chat",
      callerOrigin: { kind: isLocalClient ? "local" : "unknown" },
      ...(!isLocalClient ? { callerScopedCreation: true } : {}),
      managementEntitlement: { source: "control-ui-admin" },
    });
  },
);

it("does not derive Control UI authority from a claimed client name or session route", () => {
  const client = createClient({ isLocalClient: undefined });
  client.connect.client = {
    id: "openclaw-control-ui",
    mode: "webchat",
    version: "test",
    platform: "web",
  };
  expect(admitChat({ client, resolvedSessionKey: "agent:main:telegram:direct:operator" })).toEqual({
    runId: "run-local-chat",
    callerOrigin: { kind: "unknown" },
    callerScopedCreation: true,
  });
});

it.each(["operator.read", "operator.sessions.write"])(
  "rejects a Control UI connection narrowed to %s",
  (scope) => {
    expect(admitChat({ client: createClient({ controlUiAdmin: true }, [scope]) })).toBeUndefined();
  },
);

it.each([
  ["channel-origin turn", { hasExplicitOrigin: true }],
  ["reconnect", { isReconnectResume: true }],
  ["spawned turn", { spawnedBy: "agent:main:parent" }],
  ["cron continuation", { hasRestoredCronContinuation: true }],
  ["internal entry", { isDirectExternalUser: false }],
] as const)("does not promote Control UI admin authority for %s", (_label, overrides) => {
  expect(
    admitChat({ client: createClient({ controlUiAdmin: true }), ...overrides }),
  ).toBeUndefined();
});

it.each([
  ["internal re-entry", { isDirectExternalUser: false }],
  ["explicit origin", { hasExplicitOrigin: true }],
  ["reconnect", { isReconnectResume: true }],
  ["system-generated", { isSystemGenerated: true }],
  ["BTW turn", { turnKind: "btw" }],
  ["incognito", { isIncognito: true }],
  ["persisted cron continuation", { hasRestoredCronContinuation: true }],
  ["spawned lineage", { spawnedBy: "agent:main:parent" }],
  ["input provenance", { inputProvenance: { kind: "external_user" } }],
  ["read-only client", { client: createClient({}, ["operator.read"]) }],
  ["cron continuation client", { client: createClient({ cronRunContinuation: true }) }],
] as const)("rejects chat ingress from %s", (_label, overrides) => {
  expect(admitChat(overrides)).toBeUndefined();
});
