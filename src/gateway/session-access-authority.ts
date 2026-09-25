import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { parseAgentSessionKey, isIncognitoSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import type { GatewayMethodSessionAccess } from "./methods/descriptor.js";
import {
  onOperatorRolePolicyChanged,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicy,
} from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveSessionResourceToolPolicy } from "./session-resource-tool-policy.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { authorizeOwnSessionMutation } from "./session-sharing-policy.js";
import { prepareSessionSharing } from "./session-sharing-read.js";

type RetainedGatewaySessionAccess = {
  readonly signal: AbortSignal;
  assertCurrent: () => void;
  release: () => void;
};

export type GatewaySessionAccessAuthority = {
  readonly target: Readonly<{
    agentId: string;
    sessionKey: string;
    sessionId: string;
    lifecycleRevision?: string;
  }>;
  readonly sandboxRequired: boolean;
  /** Invocation guard, including the admitted model turn when applicable. */
  assertCurrent: () => void;
  /** Retain original actor, grant, sharing and tool policy for a viewer or accepted operation. */
  retain: () => RetainedGatewaySessionAccess;
  /** Session resource lifetime only. Revoking one collaborator must not destroy shared state. */
  retainSession: () => RetainedGatewaySessionAccess;
  /** Router-owned preparation hold; each service borrow has its own release. */
  release: () => void;
};

function denied(message = "Session access changed; reopen the session before continuing."): never {
  throw new SessionMutationAuthorizationChangedError(
    errorShape(ErrorCodes.FORBIDDEN, message, {
      details: { code: "SESSION_ACCESS_CHANGED" },
    }),
  );
}

class SessionAccessPreparationPendingError extends SessionMutationAuthorizationChangedError {
  constructor() {
    super(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Session access is refreshing; retry the operation shortly.",
        {
          retryable: true,
          details: { code: "SESSION_ACCESS_REFRESHING" },
        },
      ),
    );
  }
}

/** Prepare session/profile facts through resident owners; retain the original source authority. */
export async function prepareGatewaySessionAccessAuthority(request: {
  policy: GatewayMethodSessionAccess;
  requestParams: unknown;
  client: GatewayClient | null;
  context: GatewayRequestContext;
  ownSessionOnly: boolean;
  hasCurrentClientAuthority?: () => boolean;
  assertInvocationCurrent?: () => void;
}): Promise<GatewaySessionAccessAuthority> {
  const params = { ...request, policy: { ...request.policy } };
  const assertInvocationCurrent = params.assertInvocationCurrent;
  assertInvocationCurrent?.();
  const input = params.requestParams;
  const sessionKey =
    isRecord(input) && typeof input.sessionKey === "string" ? input.sessionKey : "";
  const parsed = parseAgentSessionKey(sessionKey);
  if (
    !parsed ||
    sessionKey !== sessionKey.trim() ||
    isIncognitoSessionKey(sessionKey) ||
    (isRecord(input) && input.agentId !== undefined && input.agentId !== parsed.agentId)
  ) {
    denied(
      "This operation requires a canonical, non-incognito sessionKey and its matching agentId.",
    );
  }
  // Capture ingress facts before preparation yields. A newly selected profile or renewed grant
  // cannot authorize an invocation admitted under a different source.
  const client = params.client;
  const initialActor = resolveGatewayOperatorRoleActor(client);
  const actor = initialActor ? { ...initialActor } : undefined;
  const profileId =
    actor?.kind === "operator" ? actor.profileId : client?.authenticatedUserProfile?.profileId;
  const originalGrant = client?.internal?.operatorAccessAuthority;
  const originalRun = client?.internal?.operatorRunAuthority;
  const originalScopes = [...(client?.connect.scopes ?? [])];
  const tool = client?.internal?.agentToolCaller;
  const runtime = client?.internal?.agentRuntimeIdentity;
  const ambient = client?.internal?.syntheticClient ? getGatewayToolCallerIdentity() : undefined;
  const assertAmbient = ambient ? captureGatewayToolCallerAssertion() : undefined;
  const owner = tool ?? runtime ?? (assertAmbient ? ambient : undefined);
  const inherited = runtime?.sessionSpawnContext?.inheritedToolPolicy;
  const inheritedPolicy = inherited
    ? { allow: [...inherited.allow], deny: [...inherited.deny] }
    : undefined;
  if (!client || (client.internal?.syntheticClient && !owner) || (tool && !tool.assertCurrent)) {
    denied("Session resources require an authenticated operator or an admitted agent run.");
  }
  if (owner && (owner.sessionKey !== sessionKey || owner.agentId !== parsed.agentId)) {
    denied("An agent can only access resources in its own conversation.");
  }
  const assertRun = () => {
    tool?.assertCurrent?.();
    if (ambient) {
      if (
        !assertAmbient ||
        ambient.agentId !== parsed.agentId ||
        ambient.sessionKey !== sessionKey ||
        (ambient.gatewayContextResolver && ambient.gatewayContextResolver() !== params.context)
      ) {
        denied();
      }
      assertAmbient();
    }
    if (runtime && params.context.validateAgentRuntimeApprovalAuthority?.(runtime) !== true) {
      denied();
    }
    const requiredTool = params.policy.requiredTool;
    if (requiredTool && owner) {
      if (ambient) {
        if (
          !ambient.assertToolAllowed ||
          !ambient.operationalRunInstance ||
          (runtime &&
            (runtime.operationalRunInstance.instanceId !==
              ambient.operationalRunInstance.instanceId ||
              runtime.operationalRunInstance.runId !== ambient.operationalRunInstance.runId))
        ) {
          denied();
        }
        ambient.assertToolAllowed(requiredTool);
      } else if (!inheritedPolicy) {
        denied();
      }
      if (
        inheritedPolicy &&
        (!isRuntimeToolAllowed(requiredTool, inheritedPolicy.allow) ||
          !isToolAllowedByPolicyName(requiredTool, { deny: inheritedPolicy.deny }))
      ) {
        denied();
      }
    }
  };
  assertRun();
  originalGrant?.assertCurrent();
  originalRun?.assertCurrent();
  const projection = getSessionRowProjection(params.context);
  if (!projection) {
    denied("Session access is unavailable during Gateway startup; retry when it is ready.");
  }
  const assertIngress = () => {
    assertInvocationCurrent?.();
    assertRun();
    originalGrant?.assertCurrent();
    originalRun?.assertCurrent();
    const currentActor = resolveGatewayOperatorRoleActor(client);
    if (
      params.hasCurrentClientAuthority?.() === false ||
      currentActor?.kind !== actor?.kind ||
      (currentActor?.kind === "operator" && currentActor.profileId !== profileId) ||
      JSON.stringify(client.connect.scopes ?? []) !== JSON.stringify(originalScopes) ||
      client.internal?.operatorAccessAuthority !== originalGrant ||
      client.internal?.operatorRunAuthority !== originalRun
    ) {
      denied();
    }
  };
  const captured = await captureGatewayOperatorRunAuthority({
    client,
    context: params.context,
    hasCurrentClientAuthority: params.hasCurrentClientAuthority,
    sourceAuthority: originalGrant ?? null,
  });
  try {
    assertIngress();
    const profile = profileId ? await prepareUserProfileRoleAuthority(profileId) : undefined;
    assertIngress();
    captured?.authority.assertCurrent();
    if (actor?.kind !== "system" && (!profile || profile.profileId !== profileId)) {
      denied("This operation requires a current authenticated profile.");
    }
    await projection.prepareMembership();
    assertIngress();
    captured?.authority.assertCurrent();
    const query = { agentId: parsed.agentId, key: sessionKey };
    const original = projection.sharingTarget(query);
    if (!original?.entry.sessionId || original.canonicalKey !== sessionKey) {
      denied("The requested session is unavailable; open an existing session first.");
    }
    const target = Object.freeze({
      agentId: original.agentId,
      sessionKey: original.canonicalKey,
      sessionId: original.entry.sessionId,
      ...(original.entry.lifecycleRevision
        ? { lifecycleRevision: original.entry.lifecycleRevision }
        : {}),
    });
    const policyClient: GatewayClient = {
      ...client,
      connect: { ...client.connect, scopes: originalScopes },
      internal: {
        ...client.internal,
        operatorRoleActor: actor,
        ...(captured ? { operatorRunAuthority: captured.authority } : {}),
      },
    };
    const resolveToolPolicy = (current: typeof original) =>
      params.policy.requiredTool
        ? resolveSessionResourceToolPolicy({
            config: params.context.getRuntimeConfig(),
            client: policyClient,
            current,
            readPreparedSessionEntry: (sourceQuery) => projection.sharingTarget(sourceQuery)?.entry,
            toolName: params.policy.requiredTool,
          })
        : undefined;
    const toolPolicy = resolveToolPolicy(original);
    const currentRole = () =>
      actor?.kind === "system" || profileId === GATEWAY_OWNER_PROFILE_ID
        ? undefined
        : resolveOperatorRolePolicy(policyClient, params.context.getRuntimeConfig());
    const sandboxRequired =
      currentRole()?.sandbox === "required" || toolPolicy?.sandboxRequired === true;
    let sessionRetired = false;
    let actorRetired = false;
    let invocationClosed = false;
    const assertSession = () => {
      if (sessionRetired) {
        denied();
      }
      if (getSessionRowProjection(params.context) !== projection) {
        sessionRetired = true;
        denied();
      }
      const state = projection.sharingTargetState(query);
      if (state.status === "pending") {
        throw new SessionAccessPreparationPendingError();
      }
      const current = state.status === "ready" ? state.target : undefined;
      if (
        !current ||
        current.storePath !== original.storePath ||
        current.generation !== original.generation ||
        current.entry.sessionId !== target.sessionId ||
        current.entry.lifecycleRevision !== target.lifecycleRevision
      ) {
        sessionRetired = true;
        denied();
      }
      return current;
    };
    const assertActor = () => {
      if (actorRetired) {
        denied();
      }
      try {
        captured?.authority.assertCurrent();
        originalGrant?.assertCurrent();
        if (profile && !profile.isCurrent()) {
          denied();
        }
        const role = currentRole();
        if (role && role.agents !== "*" && !role.agents.includes(target.agentId)) {
          denied();
        }
        const current = assertSession();
        const currentToolPolicy = resolveToolPolicy(current);
        if (
          currentToolPolicy?.sandboxRequired !== toolPolicy?.sandboxRequired ||
          currentToolPolicy?.sandboxed !== toolPolicy?.sandboxed
        ) {
          denied("The session's current tool policy does not allow this operation.");
        }
        const sharing = prepareSessionSharing(
          { cfg: params.context.getRuntimeConfig(), client: policyClient },
          {
            aliases: new Set(profile?.aliases ?? []),
            sessionCap: role?.sessions.others,
            isMember: (row, identity) =>
              projection.hasMembership(row.storePath, row.storeKey, identity),
          },
        );
        if (
          (params.ownSessionOnly &&
            authorizeOwnSessionMutation({
              client: policyClient,
              target: current,
              expectedProfileId: profileId,
              isCreator: sharing.isCreator,
            })) ||
          sharing.authorizeTarget(current)
        ) {
          denied();
        }
      } catch (error) {
        if (error instanceof SessionAccessPreparationPendingError) {
          throw error;
        }
        // Restoring membership, role or an invitation later must not revive an old capture.
        actorRetired = true;
        throw error;
      }
    };
    const assertCurrent = () => {
      if (invocationClosed) {
        denied();
      }
      assertInvocationCurrent?.();
      assertRun();
      assertActor();
    };
    const retain = (sessionOnly: boolean): RetainedGatewaySessionAccess => {
      assertCurrent();
      const assert = sessionOnly ? assertSession : assertActor;
      assert();
      const releaseSource = sessionOnly ? undefined : captured?.authority.retain?.();
      const controller = new AbortController();
      const releases: Array<() => void> = [];
      let released = false;
      let preparing = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        for (const unsubscribe of releases.splice(0)) {
          unsubscribe();
        }
        releaseSource?.();
        controller.abort(new Error("Session access borrow released"));
      };
      const check = () => {
        if (released) {
          return;
        }
        try {
          assert();
        } catch (error) {
          if (error instanceof SessionAccessPreparationPendingError) {
            if (!preparing) {
              preparing = true;
              // Use the projection's existing preparation owner. Failure stays fenced until
              // a later publication/request retries; it must not create a refresh loop.
              void Promise.resolve()
                .then(async () => {
                  if (released) {
                    return;
                  }
                  await projection.prepareMembership();
                  // A publication can invalidate facts between promise settlement and
                  // this continuation. Let that fresh pending state schedule its successor.
                  preparing = false;
                  if (!released) {
                    check();
                  }
                })
                .catch(() => {
                  preparing = false;
                });
            }
            return;
          }
          controller.abort(error);
          release();
        }
      };
      releases.push(
        sessionChanges.subscribe(check),
        onSessionIdentityMutation((change) => {
          if (
            change.agentId === target.agentId &&
            change.previous.sessionId === target.sessionId &&
            change.previous.sessionKeys.includes(target.sessionKey)
          ) {
            sessionRetired = true;
          }
          check();
        }),
      );
      if (!sessionOnly) {
        releases.push(onUserProfilesChanged(check), onOperatorRolePolicyChanged(check));
        const sourceSignal = captured?.authority.signal ?? originalGrant?.signal;
        if (sourceSignal) {
          sourceSignal.addEventListener("abort", check, { once: true });
          releases.push(() => sourceSignal.removeEventListener("abort", check));
        }
      }
      check();
      return {
        signal: controller.signal,
        assertCurrent: () => {
          controller.signal.throwIfAborted();
          assert();
        },
        release,
      };
    };
    assertCurrent();
    return {
      target,
      sandboxRequired,
      assertCurrent,
      retain: () => retain(false),
      retainSession: () => retain(true),
      release: () => {
        invocationClosed = true;
        captured?.release();
      },
    };
  } catch (error) {
    captured?.release();
    throw error;
  }
}
