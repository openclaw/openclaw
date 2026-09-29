import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  listAgentIds,
  tryResolveLegacyCompatibilityAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveSessionStoreCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveSessionRoutingContract } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import { resolvePersistedSessionStoreOwner } from "../../config/sessions/session-store-owner.js";
import { listConfiguredSessionStoreAgentIds } from "../../config/sessions/targets-configured-agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { captureGatewayAuthPolicy, isGatewayAuthPolicyCurrent } from "../auth-policy.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import {
  canResolveOperatorApproval,
  canReviewOperatorApproval,
} from "../operator-approval-authorization.js";
import type { OperatorApprovalStoreGuard } from "../operator-approval-store.types.js";
import {
  onOperatorRolePolicyChanged,
  resolveGatewayOperatorRoleActor,
} from "../operator-role-policy.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Pure policy/locator facts used by approval visibility; no row or registry discovery. */
function captureApprovalConfigPolicy(config: OpenClawConfig) {
  const agents = listAgentIds(config).toSorted();
  const configuredStores = listConfiguredSessionStoreAgentIds(config).toSorted();
  const compatibilityAgent = resolveSessionStoreCompatibilityAgentId(config);
  const storeAgents = [...new Set([...configuredStores, compatibilityAgent])].toSorted();
  return {
    routing: resolveSessionRoutingContract(config),
    storeOwner: resolvePersistedSessionStoreOwner(config),
    compatibilityAgent,
    legacyAgent: tryResolveLegacyCompatibilityAgentId(config),
    agents,
    configuredStores,
    perAgentStore: isPerAgentSessionStoreConfig(config.session?.store),
    stores: storeAgents.map((agentId) => ({
      agentId,
      path: resolveSessionStorePathCore(config.session?.store, { agentId }),
    })),
  };
}

type ApprovalSource = { sessionKey: string | null; agentId: string | null };

/**
 * Commit facts for one resolved approval source: its route and the stores it resolves through.
 * Shared fixed stores select an owner among co-tenants, and unconfigured owners discover
 * through every configured store root, so those keep the matching inventory.
 */
function captureApprovalSourcePolicy(config: OpenClawConfig, source: ApprovalSource) {
  const { agents, configuredStores, stores, ...policy } = captureApprovalConfigPolicy(config);
  const { sessionKey, agentId } = source;
  if (!sessionKey) {
    // Approval visibility resolves no session store without a source session.
    return policy;
  }
  let identity: ReturnType<typeof resolveSessionStoreIdentity> | null;
  try {
    identity = resolveSessionStoreIdentity({
      cfg: config,
      sessionKey,
      ...(agentId ? { agentId } : {}),
    });
  } catch {
    identity = null;
  }
  const owners = new Set(
    [parseAgentSessionKey(sessionKey)?.agentId, agentId, identity?.agentId].flatMap((owner) =>
      owner ? [normalizeAgentId(owner)] : [],
    ),
  );
  return {
    ...policy,
    identity,
    owners: [...owners].toSorted().map((owner) => {
      const path = resolveSessionStorePathCore(config.session?.store, { agentId: owner });
      const configured = configuredStores.includes(owner);
      return {
        agentId: owner,
        listed: agents.includes(owner),
        configured,
        path,
        stores: configured ? stores.filter((store) => store.path === path) : stores,
      };
    }),
  };
}

/** Retain the original invocation; copying options loses its request-owner binding. */
export function createApprovalRequestAuthority(options: GatewayRequestHandlerOptions) {
  const authority = readGatewayRequestMutationAuthority(options);
  const { client } = options;
  const method = options.req.method;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const role = client?.connect.role;
  const deviceId = client?.connect.device?.id;
  const approvalRuntime = client?.internal?.approvalRuntime;
  const runtimeIdentity = client?.internal?.agentRuntimeIdentity;
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorKind = actor?.kind;
  const actorProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const readRuntimeConfig = options.context.getRuntimeConfig;
  const readCommittedConfig = options.context.getCommittedRuntimeConfig;
  const resolveGatewayContext = options.context.resolveGatewayContext;
  const gatewayContext = resolveGatewayContext?.() ?? options.context;
  const getConfig = readCommittedConfig ?? readRuntimeConfig;
  const config = getConfig();
  const authPolicy = client?.authPolicy ?? captureGatewayAuthPolicy(config, null);
  let captureConfigPolicy: (current: OpenClawConfig) => unknown = captureApprovalConfigPolicy;
  let configPolicy = captureConfigPolicy(config);
  let boundSource: ApprovalSource | undefined;
  const accessRevision = readGatewayAccessRevision();
  let configRevoked = false;
  let closed = false;
  const observeConfig = () => {
    try {
      const current = getConfig();
      configRevoked =
        !isGatewayAuthPolicyCurrent(authPolicy, current) ||
        !isDeepStrictEqual(configPolicy, captureConfigPolicy(current));
    } catch {
      configRevoked = true;
    }
  };
  const releaseConfig = onOperatorRolePolicyChanged((change) => {
    if (change.kind !== "config" || change.context !== gatewayContext || configRevoked) {
      return;
    }
    // Observe every committed transition, including revoke/restore between two checks.
    observeConfig();
  });
  // Until the approval source is known, any roster or store edit can change what a lookup
  // may reach. Once bound, only that source's route and stores stay part of the fence.
  const bindSource = (record: { sessionKey?: string | null; agentId?: string | null }) => {
    const source = {
      sessionKey: normalizeOptionalString(record.sessionKey) ?? null,
      agentId: normalizeOptionalString(record.agentId) ?? null,
    };
    if (boundSource) {
      configRevoked ||= !isDeepStrictEqual(boundSource, source);
      return;
    }
    if (configRevoked) {
      return;
    }
    // A commit whose publication has not arrived yet must not become the narrowed baseline.
    observeConfig();
    if (configRevoked) {
      return;
    }
    boundSource = source;
    captureConfigPolicy = (current) => captureApprovalSourcePolicy(current, source);
    try {
      configPolicy = captureConfigPolicy(getConfig());
    } catch {
      configRevoked = true;
    }
  };
  const assertPolicyCurrent = () => {
    const currentActor = resolveGatewayOperatorRoleActor(client);
    const legacy = method.startsWith("exec.approval.") || method.startsWith("plugin.approval.");
    const allowed = legacy
      ? authority.family === "native-compatibility" ||
        authorizeOperatorScopesForMethod(method, client?.connect.scopes ?? []).allowed
      : method === "approval.resolve"
        ? canResolveOperatorApproval(client)
        : method === "approval.history"
          ? authorizeOperatorScopesForMethod(method, client?.connect.scopes ?? []).allowed
          : canReviewOperatorApproval(client);
    if (
      closed ||
      !allowed ||
      client?.invalidated ||
      client?.connect.role !== role ||
      client?.connect.device?.id !== deviceId ||
      client?.internal?.approvalRuntime !== approvalRuntime ||
      client?.internal?.agentRuntimeIdentity !== runtimeIdentity ||
      currentActor?.kind !== actorKind ||
      (currentActor?.kind === "operator" ? currentActor.profileId : undefined) !== actorProfileId ||
      client?.authenticatedUserProfile?.profileId !== profileId ||
      client?.authenticatedUserId !== userId ||
      options.context.getRuntimeConfig !== readRuntimeConfig ||
      options.context.getCommittedRuntimeConfig !== readCommittedConfig ||
      options.context.resolveGatewayContext !== resolveGatewayContext ||
      (resolveGatewayContext?.() ?? options.context) !== gatewayContext ||
      configRevoked ||
      readGatewayAccessRevision() !== accessRevision
    ) {
      throw new Error("Approval requester authority changed");
    }
  };
  const assertCurrent = () => {
    authority.assertCurrent();
    authority.expectedProfileBinding?.assertCurrent();
    assertPolicyCurrent();
  };
  const guard: OperatorApprovalStoreGuard = {
    family: authority.family,
    assertCurrent:
      authority.family === "native-compatibility"
        ? assertCurrent
        : () => {
            authority.assertWorkerCurrent();
            authority.expectedProfileBinding?.assertCurrent();
            assertPolicyCurrent();
          },
  };
  return {
    guard,
    bindSource,
    assertCurrent,
    assertCommitCurrent: guard.assertCurrent,
    isCurrent: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    [Symbol.dispose]() {
      closed = true;
      releaseConfig();
    },
  };
}

export type ApprovalRequestAuthority = ReturnType<typeof createApprovalRequestAuthority>;
