import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  appendTranscriptMessage,
  publishTranscriptUpdate,
} from "../config/sessions/session-accessor.js";
import { appendExpectedSessionTranscriptTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import type { SessionTranscriptWriteScope } from "../config/sessions/session-accessor.types.js";
import { isNativeSessionEntryRead } from "../config/sessions/session-entry-read-request.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  type ClientVoiceConfirmationUtteranceContext,
  noteClientVoiceConfirmationUtterance,
  prepareClientVoiceConfirmationTranscript,
  recordClientVoiceConfirmationTranscriptAppend,
} from "./client-voice-confirmation.js";
import {
  withClientVoiceSessionResources,
  withClientVoiceSessionSettlement,
} from "./client-voice-session-lifecycle.js";
import { operationKey, type ClientVoiceSessionRecord } from "./client-voice-session-store.js";
import {
  captureClientVoiceSessionWriter,
  type ClientVoiceSessionWriter,
} from "./client-voice-session-write.js";
import {
  buildPersistedVoiceMessage,
  normalizeVoiceTranscriptText,
  voiceTranscriptEventId,
  type VoiceTranscriptOperationRegistry,
} from "./voice-transcript.js";

export function appendVoiceTranscript(
  params: {
    agentId: string;
    sessionKey: string;
    sessionTarget: { sessionKey: string; storePath?: string };
    voiceSessionId: string;
    origin: "client" | "relay";
    entryId: string;
    role: "user" | "assistant";
    text: string;
    timestamp?: number;
    config?: OpenClawConfig;
    confirmation?: ClientVoiceConfirmationUtteranceContext | null;
  },
  operations: VoiceTranscriptOperationRegistry,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  // Normalize before admission so the queued task retains only bounded text.
  const normalized = {
    ...params,
    sessionTarget: { ...params.sessionTarget },
    text: normalizeVoiceTranscriptText(params.text),
  };
  if (!normalized.text) {
    return Promise.resolve();
  }
  const incognito = captureIncognitoSessionSource({
    agentId: normalized.agentId,
    ...normalized.sessionTarget,
  });
  const confirmation =
    normalized.role === "user"
      ? prepareClientVoiceConfirmationTranscript({
          agentId: normalized.agentId,
          voiceSessionId: normalized.voiceSessionId,
          entryId: normalized.entryId,
          confirmation: normalized.confirmation,
        })
      : null;
  return withClientVoiceSessionSettlement(
    async () => {
      const writer = retainedWriter ?? captureClientVoiceSessionWriter(normalized);
      const resources = retainedWriter ? [] : [writer];
      return withClientVoiceSessionResources(resources, async () => {
        await operations.run(
          operationKey(normalized.agentId, normalized.voiceSessionId),
          async () => {
            const sessionTarget = {
              ...normalized.sessionTarget,
              agentId: normalized.agentId,
              env: writer.options.env,
            };
            const failureKey = sha256Hex(normalized.entryId);
            const timestamp = normalized.timestamp ?? Date.now();
            const reservation = {
              agentId: normalized.agentId,
              sessionKey: normalized.sessionKey,
              voiceSessionId: normalized.voiceSessionId,
              origin: normalized.origin,
              kind: "reserve" as const,
              failureKey,
              now: Date.now(),
            };
            const appendReserved = async (
              record: ClientVoiceSessionRecord | undefined,
              entry: InternalSessionEntry | undefined,
              target: SessionTranscriptWriteScope,
              assertFresh: () => void,
              workerTranscript = false,
            ) => {
              if (!record) {
                throw new Error("voice session not found");
              }
              if (!entry?.sessionId) {
                throw new Error(`agent session not found (${normalized.sessionKey})`);
              }
              const transcriptTarget = { ...target, sessionId: entry.sessionId };
              const messageOptions = {
                ...(normalized.config ? { config: normalized.config } : {}),
                eventId: voiceTranscriptEventId(normalized.voiceSessionId, normalized.entryId),
                message: buildPersistedVoiceMessage({
                  role: normalized.role,
                  text: normalized.text,
                  timestamp,
                  provider: record.provider ?? "realtime",
                }),
                now: timestamp,
              };
              const turn = workerTranscript
                ? await appendExpectedSessionTranscriptTurn(transcriptTarget, {
                    config: normalized.config,
                    keyFormat: "agent-qualified",
                    expectedSessionId: entry.sessionId,
                    selectedSessionId: entry.sessionId,
                    selectedLifecycleRevision: entry.lifecycleRevision,
                    sessionFile: normalized.sessionTarget.sessionKey,
                    assertCurrent: assertFresh,
                    messages: [messageOptions],
                    voiceTranscript: {
                      agentId: normalized.agentId,
                      sessionKey: normalized.sessionKey,
                      voiceSessionId: normalized.voiceSessionId,
                      failureKey,
                      role: normalized.role,
                    },
                  })
                : undefined;
              const appended = workerTranscript
                ? turn?.appendedMessages[0]
                : await appendTranscriptMessage(transcriptTarget, {
                    ...messageOptions,
                    preparation: { source: composeSessionSourceAssertion([assertFresh]) },
                  });
              if (!appended) {
                throw new Error("agent session changed before voice transcript append");
              }
              // The worker publishes the transcript and its bookkeeping only after their shared commit.
              if (confirmation) {
                recordClientVoiceConfirmationTranscriptAppend({
                  confirmation,
                  entryId: normalized.entryId,
                  text: normalized.text,
                  appended: appended.appended,
                });
              }
              if (appended.appended) {
                await publishTranscriptUpdate(transcriptTarget, {
                  message: appended.message,
                  messageId: appended.messageId,
                });
                assertFresh();
              }

              const confirmed = workerTranscript
                ? turn?.voiceSession
                : await writer.mutate({
                    agentId: normalized.agentId,
                    sessionKey: normalized.sessionKey,
                    voiceSessionId: normalized.voiceSessionId,
                    kind: "confirm",
                    role: normalized.role,
                    failureKey,
                    now: Date.now(),
                  });
              if (normalized.role === "user" && confirmation) {
                if (!confirmed?.hasUserTranscript) {
                  throw new Error("voice transcript confirmation was not committed");
                }
                noteClientVoiceConfirmationUtterance({
                  agentId: normalized.agentId,
                  voiceSessionId: normalized.voiceSessionId,
                  timestamp: Date.now(),
                  confirmation,
                });
              }
            };
            if (incognito) {
              if ("kind" in incognito) {
                incognito.assertCurrent();
                throw new IncognitoSessionMissingError();
              }
              await incognito.actor.sessions.withSharedState(() =>
                withIncognitoSessionBinding(incognito, async () => {
                  const read = await incognito.actor.sessions.read(
                    { assertCurrent: writer.assertCurrent },
                    { sessionKey: sessionTarget.sessionKey },
                    incognito.admissionSignal,
                  );
                  if (!read.entry) {
                    throw new IncognitoSessionMissingError();
                  }
                  const assertCurrent = () => {
                    writer.assertCurrent();
                    incognito.admissionSignal?.throwIfAborted();
                    read.claim.assertCurrent();
                  };
                  const record = await writer.mutate(reservation);
                  assertCurrent();
                  await appendReserved(
                    record,
                    read.entry,
                    { ...sessionTarget, storePath: incognito.actor.path },
                    assertCurrent,
                  );
                }),
              );
              return;
            }
            const nativeTranscript = isNativeSessionEntryRead(sessionTarget, normalized.agentId);
            const transcriptStore = resolveUnsuffixedSqliteTargetFromSessionStorePath(
              sessionTarget.storePath ||
                resolveOpenClawAgentSqlitePath({
                  agentId: normalized.agentId,
                  env: writer.options.env,
                }),
            );
            const sharesVoiceStore =
              !nativeTranscript &&
              (transcriptStore.agentId || transcriptStore.shared) &&
              transcriptStore.path === writer.options.path;
            if (sharesVoiceStore) {
              // Entry preparation and failure reservation share their authoritative transaction.
              const prepared = await writer.mutate(
                { ...reservation, transcriptSessionKey: sessionTarget.sessionKey },
                (record, entry) => ({ record, entry }),
              );
              await appendReserved(
                prepared.record,
                prepared.entry,
                {
                  ...sessionTarget,
                  storePath: writer.options.path,
                },
                writer.assertCurrent,
                true,
              );
            } else {
              // Custom and native incognito transcripts keep their separately selected source.
              await withSessionEntryReadOnlyInWorker(
                sessionTarget,
                writer.assertCurrent,
                async (read, source) => {
                  if (!read.ok) {
                    throw read.error;
                  }
                  if (!read.value?.sessionId) {
                    throw new Error(`agent session not found (${normalized.sessionKey})`);
                  }
                  const physicalSource = source.scope?.storePath
                    ? readDatabasePathIdentitySync(source.scope.storePath)
                    : undefined;
                  const record = await writer.mutate(reservation);
                  source.assertCurrent();
                  await appendReserved(
                    record,
                    read.value,
                    { ...sessionTarget, ...source.scope },
                    () => {
                      writer.assertCurrent();
                      // Canonical reader continuations cannot enter the append's transaction.
                      if (physicalSource) {
                        assertExistingDatabaseIdentity(
                          physicalSource.canonicalPath,
                          physicalSource.key,
                          physicalSource.birthtime,
                        );
                      }
                    },
                    !nativeTranscript &&
                      physicalSource?.key === writer.identity.key &&
                      physicalSource.birthtime === writer.identity.birthtime,
                  );
                },
              );
            }
          },
          { weight: normalized.text.length },
        );
      });
    },
    undefined,
    retainedWriter?.settlementContext,
  );
}
