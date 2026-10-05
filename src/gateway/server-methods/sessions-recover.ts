import { isDeepStrictEqual } from "node:util";
import {
  validateSessionsRecoverParams,
  ErrorCodes,
  errorShape,
  type SessionsRecoverParams,
  type SessionsRecoverResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunActive } from "../../agents/embedded-agent.js";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { withSessionPendingInputQueue } from "../../config/sessions/session-accessor.pending-inputs.js";
import {
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { recoverGatewaySession } from "../session-recovery-service.js";
import { prepareRecoverySource } from "../session-recovery-source.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { resolveSessionWorkerPlacementContext } from "../session-worker-placement-context.js";
import { prepareSessionWorkerPlacementMutationCheck } from "../worker-environments/session-placement-lifecycle.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { recoverAcceptedSessionInput } from "./session-recovery-accepted-input.js";
import { launchSessionRecoveryContinuation } from "./session-recovery-continuation.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** The recover adapter commits a reviewed disposition; it never enters a dispatch owner. */
async function acknowledgeUnknownOutcome(
  options: GatewayRequestHandlerOptions,
  params: SessionsRecoverParams,
  commitGuard?: () => void,
): Promise<SessionsRecoverResult> {
  const decision = params.acknowledgeUnknownOutcome!;
  const { client, context } = options;
  const assertCaller = () => {
    commitGuard?.();
    options.sessionMutationCommitGuard?.();
    if (
      !client?.connId ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      client.connect.role !== "operator" ||
      client.internal?.authenticatedOperator !== true ||
      client.internal.syntheticClient ||
      client.internal.agentRuntimeIdentity ||
      client.internal.agentToolCaller ||
      options.hasCurrentClientAuthority?.() === false ||
      context.isConnectionActive?.(client.connId) === false
    ) {
      throw new Error("Review requires a current authenticated original-user decision.");
    }
  };
  assertCaller();
  const captured = await captureGatewayOperatorRunAuthority({
    client,
    context,
    hasCurrentClientAuthority: options.hasCurrentClientAuthority,
    invocationAuthority: { assertCurrent: assertCaller },
  });
  if (!captured) {
    throw new Error("Original-user authority is unavailable; the interrupted action remains held.");
  }
  try {
    const assertAuthority = () => {
      assertCaller();
      captured.authority.assertCurrent();
    };
    assertAuthority();
    const issuer = captured.authority.captureRestartRecoveryIssuer?.();
    if (!issuer) {
      throw new Error("Verified original-user authority is unavailable.");
    }
    const target = await resolveGatewaySessionStoreTargetInWorker({
      cfg: context.getRuntimeConfig(),
      key: params.key,
      agentId: params.agentId,
      assertActive: assertAuthority,
    });
    assertAuthority();
    using source = await prepareRecoverySource({
      cfg: context.getRuntimeConfig(),
      target,
      commitGuard: assertAuthority,
    });
    const initial = await source.refresh();
    if (!initial || initial.sessionId !== decision.sessionId) {
      throw new Error("The reviewed session changed; refresh the interrupted action.");
    }
    let assertPlacement: (() => void) | undefined;
    const assertCurrent = () => {
      assertAuthority();
      assertPlacement?.();
      const current = source.current();
      if (
        !isDeepStrictEqual(current, initial) ||
        isEmbeddedAgentRunActive(initial.sessionId) ||
        isSessionWorkAdmissionActive(target.storePath, [...target.storeKeys, initial.sessionId])
      ) {
        throw new Error("Session work or the reviewed action changed; review it again.");
      }
      const ownership = resolvePluginSessionOwnershipError({
        action: "recover",
        entry: initial,
        key: target.canonicalKey,
        pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
      });
      if (ownership) {
        throw new Error(ownership.message);
      }
      const turn = initial.mainRestartRecovery?.turnIntent;
      if (
        !turn ||
        turn.sessionKey !== target.canonicalKey ||
        turn.issuer.profileId !== issuer.profileId ||
        !isDeepStrictEqual(turn.issuer.factoryActor, issuer.factoryActor)
      ) {
        throw new Error("Only the verified original input issuer can acknowledge this outcome.");
      }
    };
    const result = await runExclusiveSessionLifecycleMutation("recover", {
      scope: target.storePath,
      identities: [...target.storeKeys, initial.sessionId],
      run: async () => {
        await source.refresh();
        assertPlacement = prepareSessionWorkerPlacementMutationCheck({
          context: resolveSessionWorkerPlacementContext(context),
          sessionId: initial.sessionId,
        });
        assertCurrent();
        await withSessionPendingInputQueue(
          {
            agentId: target.agentId,
            storePath: target.storePath,
            sessionKey: target.canonicalKey,
            sessionId: initial.sessionId,
          },
          assertCurrent,
          async (queue) => {
            const pending = await queue.read();
            assertCurrent();
            if (!pending.current || pending.rows.length) {
              throw new Error(
                "Pending accepted inputs retain custody; this decision cannot replay or discard them.",
              );
            }
          },
        );
        assertCurrent();
        return await commitMainSessionRecovery({
          target: { ...target, sessionKey: target.canonicalKey },
          expectedSessionId: initial.sessionId,
          requireWriteSuccess: true,
          assertCommitAllowed: assertCurrent,
          command: {
            kind: "acknowledge_pause",
            now: Date.now(),
            observation: {
              sessionId: decision.sessionId,
              cycleId: decision.cycleId,
              revision: decision.revision,
            },
            noReplay: {
              ...decision,
              profileId: issuer.profileId,
              factoryActor: issuer.factoryActor,
            },
          },
        });
      },
    });
    assertAuthority();
    if (!result.entry || !["applied", "no_change"].includes(result.transition.kind)) {
      throw new Error("The reviewed hold changed or retains an owner; review it again.");
    }
    return {
      ok: true,
      key: target.canonicalKey,
      sessionId: initial.sessionId,
      continuation: { status: "idle" },
    };
  } finally {
    captured.release();
  }
}

export const sessionRecoverHandlers: GatewayRequestHandlers = {
  "sessions.recover": async (options) => {
    const {
      req,
      params,
      respond,
      client,
      context,
      hasCurrentClientAuthority,
      sessionMutationAuthorization,
    } = options;
    if (!assertValidParams(params, validateSessionsRecoverParams, "sessions.recover", respond)) {
      return;
    }
    const authority = createAgentRuntimeAuthorityGuard(client, context, respond);
    const commitGuard =
      authority.commitGuard || sessionMutationAuthorization
        ? () => {
            authority.commitGuard?.();
            sessionMutationAuthorization?.assertCurrent();
          }
        : undefined;
    const creation = resolveOperatorSessionCreation(client);
    if (params.acknowledgeUnknownOutcome) {
      try {
        const acknowledged = await acknowledgeUnknownOutcome(options, params, commitGuard);
        emitSessionsChanged(context, { sessionKey: acknowledged.key, reason: "recovery" });
        respond(true, acknowledged, undefined);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            error instanceof Error ? error.message : "The interrupted action remains held.",
          ),
        );
      }
      return;
    }
    let acceptedRecoveryFailed = false;
    const accepted = await recoverAcceptedSessionInput(options, params, commitGuard).catch(
      (error: unknown) => {
        acceptedRecoveryFailed = true;
        return authority.handleClosedError(error);
      },
    );
    if (acceptedRecoveryFailed) {
      return;
    }
    if (accepted) {
      emitSessionsChanged(context, { sessionKey: accepted.key, reason: "recovery" });
      respond(true, accepted, undefined);
      return;
    }
    const recovered = await recoverGatewaySession({
      cfg: context.getRuntimeConfig(),
      key: params.key,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(creation.actor ? { actor: creation.actor } : {}),
      ...(client?.authenticatedUserProfile
        ? { requestingOperatorProfileId: client.authenticatedUserProfile.profileId }
        : {}),
      ...(client?.internal?.operatorRoleActor
        ? { operatorRoleActor: client.internal.operatorRoleActor }
        : {}),
      authorizedPluginId: client?.internal?.pluginRuntimeOwnerId,
      ...(commitGuard ? { commitGuard } : {}),
      workerPlacementContext: resolveSessionWorkerPlacementContext(context),
      launchContinuation: async (continuation) =>
        await launchSessionRecoveryContinuation({
          ...continuation,
          client,
          ...(commitGuard ? { commitGuard } : {}),
          context,
          ...(hasCurrentClientAuthority ? { hasCurrentClientAuthority } : {}),
          req,
          sessionScope: readGatewayRequestMutationAuthority(options).sessionScope,
        }),
    }).catch((error: unknown) => authority.handleClosedError(error));
    if (!recovered) {
      return;
    }
    if (!recovered.ok) {
      respond(false, undefined, recovered.error);
      return;
    }

    if (recovered.sourceKey && recovered.sourceKey !== recovered.successorKey) {
      emitSessionsChanged(context, {
        sessionKey: recovered.sourceKey,
        ...(recovered.sourceKey === "global" && recovered.agentId
          ? { agentId: recovered.agentId }
          : {}),
        reason: "archive",
      });
    }
    emitSessionsChanged(context, {
      sessionKey: recovered.successorKey,
      reason: recovered.created ? "create" : "recovery",
      ...(recovered.successorKey === "global" ? { agentId: recovered.agentId } : {}),
    });
    const result: SessionsRecoverResult = {
      ok: true,
      key: recovered.successorKey,
      sessionId: recovered.successorEntry.sessionId,
      continuation: recovered.continuation,
    };
    respond(true, result, undefined);
  },
};
