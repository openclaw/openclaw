import { randomUUID } from "node:crypto";
import type {
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
  SessionParentForkDecision,
} from "./session-accessor.sqlite-contract.js";
import {
  buildForkedChildTranscriptEvents,
  estimateParentForkPromptTokens,
  planParentForkDecision,
  resolveParentForkSourceTranscript,
  type ParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import {
  formatLegacySqliteSessionMarkerForScope,
  prepareSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import {
  getSessionActorStorageBinding,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import {
  captureIncognitoSessionOperation,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import { readMemoryParentForkSource } from "./session-parent-fork-memory.js";
import {
  forkParentEntryInWorker,
  forkParentTranscriptInWorker,
  readIncognitoParentForkSource,
  type IncognitoParentForkBinding,
} from "./session-parent-fork.js";
import type { ParentForkEntryPatch, ParentForkEntryParams } from "./session-parent-fork.types.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

function captureParentForkBinding(scope: {
  storePath: string;
  sessionKey?: string;
  agentId?: string;
}) {
  const source = captureIncognitoSessionSource(scope);
  if (source && "kind" in source) {
    return source;
  }
  const binding = captureIncognitoSessionOperation(scope);
  if (!binding) {
    return undefined;
  }
  if (!scope.sessionKey) {
    throw new Error("Incognito parent fork requires its captured parent session key");
  }
  return { source: { ...binding, sessionKey: scope.sessionKey } };
}

/** Prepare one source snapshot; the creation owner commits its copy with the child entry. */
export async function prepareSessionForkTranscript(
  input: ForkSessionFromParentTranscriptParams & { sessionActor?: SessionActorStorageBinding },
  incognito?: IncognitoParentForkBinding,
) {
  const memory = getSessionActorStorageBinding({ sessionActor: input.sessionActor });
  const binding = memory
    ? undefined
    : (incognito ?? captureParentForkBinding({ ...input, sessionKey: input.parentSessionKey }));
  if (binding && "kind" in binding) {
    input.commitGuard?.();
    binding.assertCurrent();
    return { status: "missing-parent" as const };
  }
  if (!input.parentEntry.sessionId) {
    return { status: "missing-parent" as const };
  }
  const { commitGuard, sessionActor: _sessionActor, ...data } = input;
  const params = { ...structuredClone(data), commitGuard };
  params.commitGuard?.();
  const memorySource = memory ? await readMemoryParentForkSource(params, memory) : undefined;
  if (memory && !memorySource) {
    return { status: "missing-parent" as const };
  }
  const actor = binding?.source.actor;
  const resolved =
    memorySource?.scope ??
    (actor
      ? { agentId: actor.agentId, path: actor.path }
      : await prepareSqliteScope({
          agentId: params.agentId,
          sessionKey: params.parentSessionKey,
          storePath: params.storePath,
        }));
  const sourceScope = {
    ...resolved,
    sessionKey: normalizeStoreSessionKey(params.parentSessionKey),
    sessionId: params.parentEntry.sessionId,
    storePath: resolved.path ?? params.storePath,
  };
  let source: ParentForkSourceTranscript | null;
  if (memorySource) {
    source = memorySource.source;
  } else if (actor && binding) {
    source = await readIncognitoParentForkSource(
      { ...params, sessionId: sourceScope.sessionId },
      binding,
    );
  } else {
    if (params.targetStorePath) {
      await prepareSqliteScope({
        sessionKey: params.sessionKey,
        storePath: params.targetStorePath,
      });
    }
    const hydration = prepareSessionTranscriptHydration(sourceScope);
    const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
    const snapshot = await readRestoredSessionTranscript(sourceScope, hydration.read, {
      assertCurrent: params.commitGuard,
    });
    hydration.assertCurrent();
    if (snapshot.kind !== "full") {
      throw new Error("Parent fork requires its complete transcript snapshot");
    }
    source = resolveParentForkSourceTranscript(snapshot.snapshot.events, params.forkFrom);
  }
  params.commitGuard?.();
  if (!source) {
    return { status: "failed" as const };
  }
  const decision = resolveParentForkLimitDecision(params, source);
  if (decision) {
    return { status: "too-large" as const, decision };
  }
  const sessionId = params.targetSessionId ?? randomUUID();
  return {
    status: "prepared" as const,
    transcript: {
      sessionId,
      sessionFile: params.sessionKey,
    },
    events: buildForkedChildTranscriptEvents({
      parentSessionFile: formatLegacySqliteSessionMarkerForScope({ ...resolved, ...sourceScope }),
      source,
      targetSessionId: sessionId,
    }),
  };
}

export async function forkSessionTranscriptFromParent(
  params: ForkSessionFromParentTranscriptParams,
  incognito?: IncognitoParentForkBinding,
): Promise<ForkSessionFromParentTranscriptResult> {
  const binding =
    incognito ?? captureParentForkBinding({ ...params, sessionKey: params.parentSessionKey });
  if (binding && "kind" in binding) {
    params.commitGuard?.();
    binding.assertCurrent();
    return { status: "missing-parent" };
  }
  return forkParentTranscriptInWorker(params, binding);
}

/** Fork parent context and commit the child through its worker-owned store. */
export async function forkSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  return forkSessionEntryFromParentTargetWithPatch(params);
}

export async function forkSessionEntryFromParentTargetWithPatch(
  params: ParentForkEntryParams & { commitGuard?: () => void },
  patch?: ParentForkEntryPatch,
  incognito?: IncognitoParentForkBinding,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const binding =
    incognito ??
    captureParentForkBinding({
      ...params,
      sessionKey: params.parentTarget.canonicalKey,
    });
  if (binding && "kind" in binding) {
    params.commitGuard?.();
    binding.assertCurrent();
    return { status: "missing-parent" };
  }
  return forkParentEntryInWorker(params, patch, binding);
}

export async function resolveSessionParentForkDecision(
  params: {
    parentEntry: SessionEntry;
    parentSessionKey?: string;
    storePath: string;
  },
  incognito?: IncognitoParentForkBinding,
): Promise<SessionParentForkDecision> {
  const binding =
    incognito ?? captureParentForkBinding({ ...params, sessionKey: params.parentSessionKey });
  if (binding && "kind" in binding) {
    return planParentForkDecision(params.parentEntry);
  }
  const parentSessionId =
    typeof params.parentEntry.sessionId === "string" ? params.parentEntry.sessionId : "";
  if (parentSessionId.length === 0) {
    return planParentForkDecision(params.parentEntry);
  }
  const parentEntry = structuredClone(params.parentEntry);
  const source = binding
    ? await readIncognitoParentForkSource(
        { storePath: params.storePath, sessionId: parentSessionId },
        binding,
      )
    : resolveParentForkSourceTranscript(
        await loadTranscriptEvents({ storePath: params.storePath, sessionId: parentSessionId }),
      );
  return planParentForkDecision(parentEntry, estimateParentForkPromptTokens(source));
}

function resolveParentForkLimitDecision(
  params: Pick<
    ForkSessionFromParentTranscriptParams,
    "enforceTokenLimit" | "forkFrom" | "maxTokens" | "parentEntry"
  >,
  source: ParentForkSourceTranscript,
): Extract<SessionParentForkDecision, { status: "skip" }> | undefined {
  if (!params.enforceTokenLimit) {
    return undefined;
  }
  const decision = planParentForkDecision(
    params.parentEntry,
    estimateParentForkPromptTokens(source),
    {
      maxTokens: params.maxTokens,
      preferTranscriptEstimate: params.forkFrom === "last-completed",
    },
  );
  return decision.status === "skip" ? decision : undefined;
}
