import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import {
  claimAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { ensureCanonicalGatewayOwnerProfile } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  consumeCronCreatorAuthorityGrant,
  mintCronCreatorAuthorityGrant,
} from "../cron-creator-authority-grant.js";
import type { CronCreatorAuthorityGrant } from "../cron-creator-authority-grant.types.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { decideTurnGrant } from "../operator-admission.js";
import { prepareGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import {
  isDirectGatewayChatUserTurn,
  resolveGatewayChatCronCreatorAuthorityAdmission,
  resolveGatewayTemplateSetupCronAuthorityAdmission,
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

// The admitted grant of a socket with these connect scopes; transport facts never change it.
const grantFor = (client: GatewayClient | null | undefined) =>
  decideTurnGrant(client?.connect.scopes ?? []);

function admitAgent({
  request,
  ...overrides
}: Partial<Omit<Parameters<typeof resolveGatewayCronCreatorAuthorityAdmission>[0], "request">> & {
  request?: Partial<AgentRunRequest>;
} = {}) {
  const client = "client" in overrides ? overrides.client : createClient();
  return resolveGatewayCronCreatorAuthorityAdmission({
    runId: "run-local-operator",
    resolvedSessionKey: "agent:main:main",
    client,
    grant: grantFor(client),
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
  ["model run", { isOneShotModelRun: true }],
  ["internal handoff", { request: { internalRuntimeHandoffId: "handoff-1" } }],
  ["model-run request", { request: { modelRun: true } }],
  ["exec approval followup", { request: { execApprovalFollowupExpectedSessionId: "session-1" } }],
  ["internal session effects", { request: { sessionEffects: "internal" } }],
  ["suppressed prompt persistence", { request: { suppressPromptPersistence: true } }],
  ["swarm collector", { request: { swarmCollector: true } }],
  ["completion event", { request: { internalEvents: [{ type: "task_completion" }] } }],
  ["ACP spawn", { request: { acpTurnSource: "manual_spawn" } }],
  ["subagent lane without an admitted grant", { request: { lane: "subagent" }, grant: undefined }],
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
  const client = "client" in overrides ? overrides.client : createClient();
  return {
    runId: "run-local-chat",
    resolvedSessionKey: "agent:main:main",
    client,
    grant: grantFor(client),
    hasExplicitOrigin: false,
    hasRestoredCronContinuation: false,
    isIncognito: false,
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
  expect(admit()).toEqual({
    runId,
    callerOrigin: { kind: "local" },
    managementEntitlement: { source: "operator" },
  });
});

it.each([
  ["owner", ["operator.admin"], { managementEntitlement: { source: "operator" } }],
  ["writer", ["operator.write"], {}],
] as const)("gives a subagent child its parent's %s automations grant", (_label, scopes, rest) => {
  const grant = decideTurnGrant(scopes);
  expect(
    admitAgent({
      client: createClient({ syntheticClient: true }),
      grant,
      request: { lane: "subagent" },
    }),
  ).toEqual({
    runId: "run-local-operator",
    callerOrigin: { kind: "unknown" },
    callerScopedCreation: true,
    ...rest,
  });
});

it.each(["agent", "chat"] as const)(
  "keeps %s creator grants after the issuing device is revoked mid-run, until the run closes",
  async (entry) => {
    const context = {};
    const caller = captureGatewayDeviceRevocation(
      context,
      { deviceId: "original-device", role: "operator" },
      () => true,
    );
    const admission = expectDefined(
      entry === "agent" ? admitAgent() : admitChat(),
      "expected direct operator admission",
    );
    const capability = expectDefined(
      createCronCreatorAuthorityCapability(
        admission.runId,
        admission.callerOrigin,
        admission.managementEntitlement,
      ),
      "expected creator capability",
    );
    let unspent: CronCreatorAuthorityGrant | undefined;
    try {
      await runWithCronCreatorAuthorityCapability(capability, async () => {
        const grant = mintCronCreatorAuthorityGrant(capability);
        invalidateGatewayDeviceRevocation(context, "original-device", "operator");
        expect(consumeCronCreatorAuthorityGrant(grant).assertCurrent).not.toThrow();
        unspent = mintCronCreatorAuthorityGrant(capability);
      });
    } finally {
      caller.release();
    }
    expect(() => consumeCronCreatorAuthorityGrant(unspent!)).toThrow("cron access has ended");
  },
);

it("keeps Incognito dashboard input separate from cron authority", () => {
  const params = createChatParams({
    client: createClient({ isLocalClient: undefined, controlUiAdmin: true }),
    isIncognito: true,
  });
  expect(isDirectGatewayChatUserTurn(params)).toBe(true);
  expect(resolveGatewayChatCronCreatorAuthorityAdmission(params)).toBeUndefined();
  expect(isDirectGatewayChatUserTurn({ ...params, isDirectExternalUser: false })).toBe(false);
});

it.each([
  ["channel origin", { hasExplicitOrigin: true }],
  ["channel ingress", { isDirectExternalUser: false }],
  ["non-WebChat client", { client: createClient() }],
  ["supervised child", { isUncontrolledDashboardChild: false }],
  ["internal input", { isSystemGenerated: true }],
  ["incognito", { isIncognito: true }],
] as const)("keeps %s outside the dashboard handoff exception", (_label, overrides) => {
  const params = createChatParams({
    spawnedBy: "agent:main:parent",
    isUncontrolledDashboardChild: true,
    client: createClient({ authenticatedControlUi: true }),
    ...overrides,
  });
  expect(isDirectGatewayChatUserTurn(params)).toBe(false);
  expect(resolveGatewayChatCronCreatorAuthorityAdmission(params)).toBeUndefined();
});

it.each([
  ["remote Control UI", { controlUiAdmin: true as const }, "openclaw-control-ui", "webchat"],
  ["remote native app", { authenticatedOperator: true as const }, "openclaw-macos", "ui"],
  ["remote CLI", {}, "cli", "cli"],
] as const)(
  "gives an owner on a %s the grant's management, not a transport's",
  (_label, internal, id, mode) => {
    const client = createClient({ isLocalClient: undefined, ...internal });
    client.connect.client = { id, mode, version: "test", platform: "test" } as never;
    expect(admitChat({ client })).toEqual({
      runId: "run-local-chat",
      callerOrigin: { kind: "unknown" },
      callerScopedCreation: true,
      managementEntitlement: { source: "operator" },
    });
    client.connect.scopes = ["operator.write"];
    expect(admitChat({ client })).toEqual({
      runId: "run-local-chat",
      callerOrigin: { kind: "unknown" },
      callerScopedCreation: true,
    });
  },
);

it.each(["operator.read", "operator.sessions.write"])(
  "rejects a Control UI connection narrowed to %s",
  (scope) => {
    expect(admitChat({ client: createClient({ controlUiAdmin: true }, [scope]) })).toBeUndefined();
  },
);

it.each([
  ["channel-origin turn", { hasExplicitOrigin: true }],
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
  ["system-generated", { isSystemGenerated: true }],
  ["BTW turn", { turnKind: "btw" }],
  ["incognito", { isIncognito: true }],
  ["persisted cron continuation", { hasRestoredCronContinuation: true }],
  ["spawned lineage", { spawnedBy: "agent:main:parent" }],
  ["input provenance", { inputProvenance: { kind: "external_user" } }],
  ["read-only client", { client: createClient({}, ["operator.read"]) }],
] as const)("rejects chat ingress from %s", (_label, overrides) => {
  expect(admitChat(overrides)).toBeUndefined();
});

it.each(["setup", "ordinary internal", "non-admin", "synthetic"] as const)(
  "admits automation creation only for an owner's Template setup: %s",
  (kind) => {
    const client = createClient(
      { isLocalClient: undefined, ...(kind === "synthetic" ? { syntheticClient: true } : {}) },
      kind === "non-admin" ? ["operator.write"] : ["operator.admin"],
    );
    const admission = resolveGatewayTemplateSetupCronAuthorityAdmission({
      ...createChatParams({ client }),
      isIncognitoEntry: false,
      isSystemGenerated: true,
      inputProvenance: {
        kind: "internal_system",
        sourceTool:
          kind === "ordinary internal" ? "agents_create_onboarding" : "template_add_setup",
      },
    });
    if (kind === "setup") {
      expect(admission).toMatchObject({
        callerScopedCreation: true,
        managementEntitlement: { source: "operator" },
      });
    } else {
      expect(admission).toBeUndefined();
    }
  },
);

it("keeps the request's invocation lifetime when it admits an authless local socket", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    await ensureCanonicalGatewayOwnerProfile("Owner");
    const invocation = new AbortController();
    const release = vi.fn();
    const admitted = expectDefined(
      await prepareGatewayOperatorRunAuthority({
        client: {
          connect: { role: "operator", scopes: ["operator.admin"] },
          authPolicy: { authMethod: "none" },
          internal: { isLocalClient: true },
        } as never,
        context: { getRuntimeConfig: () => ({}) },
        invocationAuthority: {
          assertCurrent: () => invocation.signal.throwIfAborted(),
          signal: invocation.signal,
          release,
        },
      }),
      "local-host admission",
    );
    expect(admitted.authority).toMatchObject({
      profileId: "gateway-owner",
      grant: { automations: "manage" },
    });
    invocation.abort();
    expect(admitted.authority.signal?.aborted).toBe(true);
    admitted.release();
    expect(release).toHaveBeenCalledOnce();
  });
});
