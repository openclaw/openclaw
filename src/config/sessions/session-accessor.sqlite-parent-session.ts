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
  resolveParentForkLimitDecision,
  type ParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import {
  formatLegacySqliteSessionMarkerForScope,
  prepareSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import {
  forkMemorySessionEntryFromParent,
  readMemoryParentForkSource,
} from "./session-parent-fork-memory.js";
import { forkParentEntryInWorker, forkParentTranscriptInWorker } from "./session-parent-fork.js";
import type { ParentForkEntryPatch, ParentForkEntryParams } from "./session-parent-fork.types.js";
import { loadSessionTranscriptEvents } from "./session-transcript-events.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

/** Prepare one source snapshot; the creation owner commits its copy with the child entry. */
export async function prepareSessionForkTranscript(
  input: ForkSessionFromParentTranscriptParams & { sessionActor?: SessionActorStorageBinding },
): Promise<
  | { status: "missing-parent" }
  | { status: "failed" }
  | { status: "too-large"; decision: Extract<SessionParentForkDecision, { status: "skip" }> }
  | {
      status: "prepared";
      transcript: { sessionId: string; sessionFile: string };
      events: ReturnType<typeof buildForkedChildTranscriptEvents>;
    }
> {
  const memory = getSessionActorStorageBinding({ sessionActor: input.sessionActor });
  const assertCurrent = () => input.commitGuard?.();
  const authority = { assertCurrent, authorize() {} };
  const scope = { ...input, sessionKey: input.parentSessionKey };
  if (!memory && captureSessionActorStorageOwner(scope, authority)) {
    return (
      (await withSessionActorStorage(
        scope,
        {
          authority,
          lifetime: { assertCurrent, assertReadable: assertCurrent },
        },
        (selected) => prepareSessionForkTranscript({ ...input, sessionActor: selected }),
      )) ?? { status: "missing-parent" as const }
    );
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
  const resolved =
    memorySource?.scope ??
    (await prepareSqliteScope({
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
): Promise<ForkSessionFromParentTranscriptResult> {
  const assertCurrent = () => params.commitGuard?.();
  const authority = { assertCurrent, authorize() {} };
  const scope = { ...params, sessionKey: params.parentSessionKey };
  if (captureSessionActorStorageOwner(scope, authority)) {
    const prepared = await prepareSessionForkTranscript(params);
    if (prepared.status !== "prepared") {
      return prepared;
    }
    const target = {
      sessionKey: params.sessionKey,
      storePath: params.targetStorePath ?? params.storePath,
    };
    return (
      (await withSessionActorStorage(
        target,
        {
          authority,
          lifetime: { assertCurrent, assertReadable: assertCurrent },
          create: true,
        },
        async (memory) =>
          readSessionActorStorageResult(
            await memory.actor.storage.mutate(
              {
                type: "session.parentFork.transcript",
                input: { sessionId: prepared.transcript.sessionId, events: prepared.events },
              },
              memory.authority,
            ),
          ),
      )) ?? { status: "failed" }
    );
  }
  return forkParentTranscriptInWorker(params);
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
): Promise<ForkSessionEntryFromParentTargetResult> {
  const memory = forkMemorySessionEntryFromParent(params, patch);
  if (memory) {
    return memory;
  }
  return forkParentEntryInWorker(params, patch);
}

export async function resolveSessionParentForkDecision(params: {
  parentEntry: SessionEntry;
  parentSessionKey?: string;
  storePath: string;
}): Promise<SessionParentForkDecision> {
  const parentSessionId =
    typeof params.parentEntry.sessionId === "string" ? params.parentEntry.sessionId : "";
  if (parentSessionId.length === 0) {
    return planParentForkDecision(params.parentEntry);
  }
  const parentEntry = structuredClone(params.parentEntry);
  const authority = { assertCurrent() {}, authorize() {} };
  const scope = { ...params, sessionKey: params.parentSessionKey, sessionId: parentSessionId };
  const captured = captureSessionActorStorageOwner(scope, authority);
  const source = captured
    ? ((await withSessionActorStorage(
        scope,
        {
          authority,
          lifetime: {
            assertCurrent: () => authority.assertCurrent(),
            assertReadable: () => authority.assertCurrent(),
          },
        },
        (memory) =>
          memory.actor.storage.read(
            {
              type: "session.parentFork.source",
              input: { sessionId: parentSessionId },
            },
            memory.authority,
          ),
      )) ?? null)
    : resolveParentForkSourceTranscript(
        await loadSessionTranscriptEvents({
          storePath: params.storePath,
          sessionId: parentSessionId,
        }),
      );
  return planParentForkDecision(parentEntry, estimateParentForkPromptTokens(source));
}
