import { assertAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  resolveGatewayPersonalToolParticipant,
} from "../../agents/tools/gateway-caller-context.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRolePolicyAuthority } from "../../state/user-channel-identity-operations.js";
import { resolveOperatorRolePolicyForAssignment } from "../operator-role-policy.js";
import {
  currentPersonalForgeClient,
  type PersonalForgeAction,
} from "./personal-forge-authorization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** A tool may act for its admitted requester; copied synthetic profile fields grant nothing. */
export async function preparePersonalForgeToolAction(
  options: GatewayRequestHandlerOptions,
  toolName: string,
  scope: "operator.sessions.read" | "operator.sessions.write",
  label: string,
): Promise<PersonalForgeAction> {
  const client = options.client;
  const caller = getGatewayToolCallerIdentity();
  const requester = caller?.operatorAuthority;
  const dispatched = client?.internal?.operatorRunAuthority;
  const assertToolCurrent = captureGatewayToolCallerAssertion();
  const assertToolAllowed = caller?.assertToolAllowed;
  if (
    !caller ||
    !requester?.source ||
    !dispatched ||
    client?.internal?.syntheticClient !== true ||
    !assertToolCurrent ||
    !assertToolAllowed ||
    requester.source !== dispatched.source ||
    requester.profileId !== dispatched.profileId
  ) {
    throw new Error(`${label} requires an admitted signed-in requester, not a System account.`);
  }
  const signal = AbortSignal.any(
    [
      options.signal,
      client.connectionSignal,
      requester.signal,
      dispatched.signal,
      ...(caller.approvalSignals ?? []),
    ].filter((value): value is AbortSignal => value !== undefined),
  );
  const assertRequester = () => {
    signal.throwIfAborted();
    assertAdmittedRunOperatorAuthority(requester);
    assertAdmittedRunOperatorAuthority(dispatched);
    assertToolCurrent();
    assertToolAllowed(toolName);
    // A coalesced multi-person turn cannot choose a colleague's grant implicitly.
    const participant = resolveGatewayPersonalToolParticipant(
      client.internal?.agentRuntimeIdentity,
      {
        requireSingleParticipant: true,
      },
    );
    participant?.assertCurrent();
    if (participant && participant.profileId !== requester.profileId) {
      throw new Error(`${label} requester is ambiguous; ask from your own signed-in turn.`);
    }
    if (
      client.invalidated ||
      client.connectionSignal?.aborted ||
      client.connect.role !== "operator" ||
      client.internal?.operatorRunAuthority !== dispatched ||
      options.hasCurrentClientAuthority?.() === false
    ) {
      throw new Error(`${label} requester authority is no longer current.`);
    }
    options.sessionMutationCommitGuard?.();
    for (const allowedScopes of [
      requester.scopes,
      dispatched.scopes,
      client.connect.scopes ?? [],
    ]) {
      if (!roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes })) {
        throw new Error(`${label} requires current ${scope} permission.`);
      }
    }
  };
  assertRequester();
  const profile = await prepareUserProfileRolePolicyAuthority(requester.profileId);
  assertRequester();
  if (!profile || profile.profileId !== requester.profileId) {
    throw new Error(`${label} requires your current verified profile; sign in again.`);
  }
  const assertCurrent = () => {
    assertRequester();
    if (!profile.isCurrent()) {
      throw new Error(`${label} requester profile changed; sign in again.`);
    }
    const config = options.context.getRuntimeConfig();
    const policy = resolveOperatorRolePolicyForAssignment(
      profile.profileId,
      profile.role ?? null,
      config,
      profile.githubLogin ?? null,
    );
    if (policy && policy.agents !== "*" && !policy.agents.includes(caller.agentId)) {
      throw new Error(`${label} is not authorized for this agent.`);
    }
    currentPersonalForgeClient(options, scope, profile, label);
  };
  assertCurrent();
  return { owner: profile.profileId, signal, assertCurrent };
}
