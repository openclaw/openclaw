import { isDeepStrictEqual } from "node:util";
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
import { resolveGatewayAuthPolicyGeneration } from "../auth-policy.js";
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
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Pure policy/locator facts used by approval visibility; no row or registry discovery. */
function captureApprovalConfigPolicy(config: OpenClawConfig) {
  const agents = listAgentIds(config).toSorted();
  const configuredStores = listConfiguredSessionStoreAgentIds(config).toSorted();
  const compatibilityAgent = resolveSessionStoreCompatibilityAgentId(config);
  const storeAgents = [...new Set([...configuredStores, compatibilityAgent])].toSorted();
  return {
    authentication: resolveGatewayAuthPolicyGeneration(config),
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
  const configPolicy = captureApprovalConfigPolicy(getConfig());
  const accessRevision = readGatewayAccessRevision();
  let configRevoked = false;
  let closed = false;
  const releaseConfig = onOperatorRolePolicyChanged((change) => {
    if (change.kind !== "config" || change.context !== gatewayContext || configRevoked) {
      return;
    }
    try {
      // Observe every committed transition, including revoke/restore between two checks.
      configRevoked = !isDeepStrictEqual(configPolicy, captureApprovalConfigPolicy(getConfig()));
    } catch {
      configRevoked = true;
    }
  });
  const assertPolicyCurrent = () => {
    client?.internal?.operatorRunAuthority?.assertCurrent();
    if (
      runtimeIdentity &&
      options.context.validateAgentRuntimeApprovalAuthority?.(runtimeIdentity) !== true
    ) {
      throw new Error("Approval requester runtime authority changed");
    }
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
