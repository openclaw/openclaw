import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { captureSessionEntryCurrentRead } from "../../config/sessions/session-entry-current-runtime.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentFacts,
} from "../../config/sessions/session-entry-current.types.js";
import { captureSessionExecutionPolicy } from "../../config/sessions/session-entry-execution-policy.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import type { CronCallerScope } from "./cron-caller-scope.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Retains creator-session facts and their live checks across the durable write. */
export async function prepareCronCreatorSession(
  params: Pick<
    GatewayRequestHandlerOptions,
    "context" | "client" | "sessionMutationCommitGuard" | "hasCurrentClientAuthority"
  > & { callerScope: CronCallerScope | undefined; retainExecutionPolicy?: boolean },
) {
  const { context, client, callerScope, sessionMutationCommitGuard, hasCurrentClientAuthority } =
    params;
  const operatorActor = callerScope ? undefined : resolveOperatorSessionCreation(client).actor;
  const creatorConfig = context.getRuntimeConfig();
  const creatorStore = creatorConfig.session?.store;
  const assertCreatorStoreCurrent = () => {
    if (context.getRuntimeConfig().session?.store !== creatorStore) {
      throw new Error(
        "Creator session store changed before scheduling; retry from the current turn.",
      );
    }
  };
  const assertCreatorReadCurrent = () => {
    assertActiveAgentRuntimeAuthority(client, context, sessionMutationCommitGuard);
    assertCreatorStoreCurrent();
    if (hasCurrentClientAuthority?.() === false) {
      throw new TypeError("Gateway caller authority is no longer active.");
    }
  };
  const creatorTarget = callerScope?.sessionKey
    ? await resolveGatewaySessionStoreTargetInWorker({
        cfg: creatorConfig,
        key: callerScope.sessionKey,
        agentId: callerScope.agentId,
        assertActive: assertCreatorReadCurrent,
      })
    : undefined;
  const creatorScope = creatorTarget
    ? {
        sessionKey: creatorTarget.canonicalKey,
        agentId: creatorTarget.agentId,
        storePath: creatorTarget.storePath,
      }
    : undefined;
  const creator = creatorScope
    ? await withSessionEntryReadOnlyInWorker(
        creatorScope,
        assertCreatorReadCurrent,
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          return {
            entry: read.value,
            current: read.value ? captureSessionEntryCurrentRead(creatorScope, owner) : undefined,
          };
        },
      )
    : undefined;
  const creatorSession = creator?.entry;
  // Agent-tool clients own one exact signed session. Read that session's creator instead of
  // reclassifying spawn context as the automation creator; params never carry this provenance.
  const actor = operatorActor ?? creatorSession?.createdActor;
  const actorId = normalizeOptionalString(actor?.id);
  const createdActor = actor ? { ...actor, ...(actorId ? { id: actorId } : {}) } : undefined;
  const selectionIdentity = JSON.stringify(creatorSession?.skillLibrarySelections);
  const executionPolicy = params.retainExecutionPolicy
    ? captureSessionExecutionPolicy(creatorSession)
    : undefined;
  const assertCreatorSessionCurrent = (latest: SessionEntryCurrentFacts | undefined) => {
    if (
      latest?.sessionId !== creatorSession?.sessionId ||
      latest?.lifecycleRevision !== creatorSession?.lifecycleRevision ||
      JSON.stringify(latest?.skillLibrarySelections) !== selectionIdentity ||
      (params.retainExecutionPolicy && !isDeepStrictEqual(latest?.executionPolicy, executionPolicy))
    ) {
      throw new Error("Creator session changed before scheduling; retry from the current turn.");
    }
  };
  const sessionEntryCurrent: SessionEntryCurrentCheck | undefined =
    creator?.current?.kind === "file"
      ? { source: creator.current.source, assertCurrent: assertCreatorSessionCurrent }
      : undefined;
  const assertCurrent = () => {
    if (creatorSession) {
      assertCreatorStoreCurrent();
    }
    creator?.current?.assertSourceCurrent();
    if (creator?.current && creator.current.kind !== "file") {
      assertCreatorSessionCurrent(creator.current.readCurrent());
    }
  };
  return {
    session:
      creatorSession && creatorScope
        ? {
            entry: creatorSession,
            agentId: creatorScope.agentId,
            sessionKey: creatorScope.sessionKey,
          }
        : undefined,
    createdActor,
    skillLibrarySelections: creatorSession?.skillLibrarySelections,
    sessionEntryCurrent,
    assertCurrent,
  };
}
