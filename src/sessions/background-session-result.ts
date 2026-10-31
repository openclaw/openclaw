// Commits detached background results into an existing conversation generation.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  persistSessionTranscriptTurn,
  type SessionTranscriptTurnPersistOptions,
} from "../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { findTranscriptEvent } from "../config/sessions/session-transcript-match.js";
import type { SessionTranscriptAssistantMessage } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import {
  AUTOMATION_RESULT_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
  type SUBAGENT_COMPLETION_RESULT_KIND,
} from "../shared/transcript-only-openclaw-assistant.js";
import { isSessionControllerWorkActive } from "./session-controller.lifecycle-observation.js";
import { captureSessionTarget, runSessionMutation } from "./session-controller.lifecycle.js";

type BackgroundSessionResultCommit = { ok: true } | { ok: false; reason: string };

/** Identifies which background producer wrote a result row. */
export type BackgroundSessionResultProvenance =
  | { kind: "cron"; jobId: string; runId: string }
  | { kind: typeof SUBAGENT_COMPLETION_RESULT_KIND };

/** Appends a background result without waiting for the target conversation's active turn. */
export async function commitBackgroundResultToSession(params: {
  agentId: string;
  sessionKey: string;
  /** Pins output to the conversation generation that admitted the background run. */
  expectedGeneration: { sessionId: string; lifecycleRevision: string | undefined };
  text: string;
  prepareDisplayContent?: () => Promise<readonly Record<string, unknown>[] | undefined>;
  onMessageCommitted?: SessionTranscriptTurnPersistOptions["onMessageCommitted"];
  idempotencyKey: string;
  provenance?: BackgroundSessionResultProvenance;
  config: OpenClawConfig;
  signal?: AbortSignal;
  /** Revalidate the producer after preparation and inside the transcript commit. */
  assertCurrent?: () => void;
}): Promise<BackgroundSessionResultCommit> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const text = normalizeOptionalString(params.text);
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  if (!sessionKey || !text || !idempotencyKey) {
    return { ok: false, reason: "background session result is missing required data" };
  }

  const storePath = resolveSessionStorePathCore(params.config.session?.store, {
    agentId: params.agentId,
  });
  const expectedSessionId = normalizeOptionalString(params.expectedGeneration.sessionId);
  if (!expectedSessionId) {
    return { ok: false, reason: "background session result has an invalid expected generation" };
  }
  const expectedLifecycleRevision = normalizeOptionalString(
    params.expectedGeneration.lifecycleRevision,
  );
  const identities = [sessionKey, expectedSessionId];

  params.assertCurrent?.();
  return await runSessionMutation({
    diagnosticLabel: "background-result",
    kind: "background-result",
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      aliases: identities,
      incarnation: expectedSessionId,
      agentId: params.agentId,
    }),
    signal: params.signal,
    // The transcript writer orders appends; only destructive mutations need turn settlement.
    policy: "allow-live",
    run: async () => {
      params.assertCurrent?.();
      return withSessionEntryReadOnlyInWorker<BackgroundSessionResultCommit>(
        {
          agentId: params.agentId,
          sessionKey,
          storePath,
          readConsistency: "latest",
        },
        () => {
          params.assertCurrent?.();
          params.signal?.throwIfAborted();
        },
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          const current = read.value;
          if (
            current?.sessionId !== expectedSessionId ||
            normalizeOptionalString(current.lifecycleRevision) !== expectedLifecycleRevision
          ) {
            return { ok: false, reason: `session rebound for sessionKey: ${sessionKey}` };
          }
          const unavailable = resolveSessionWorkStartError(sessionKey, current, {
            expectedSessionId,
            purpose: "accepted-result-settlement",
          });
          if (unavailable) {
            return { ok: false, reason: unavailable };
          }
          const scope = {
            agentId: params.agentId,
            sessionKey,
            sessionId: expectedSessionId,
            storePath,
          };
          // A retry owns the original committed payload, including its managed-media IDs.
          // Restaging media would conflict with the transcript's exact replay contract.
          const prior = await findTranscriptEvent(
            scope,
            { kind: "idempotency", key: idempotencyKey },
            undefined,
            "background-result",
          );
          const priorMessage = prior && readTranscriptEventMessage(prior.event);
          const priorId = prior && readTranscriptEventId(prior.event);
          if (prior && (!priorMessage || !priorId)) {
            return { ok: false, reason: "background result transcript identity is unavailable" };
          }
          const displayContent = priorMessage
            ? undefined
            : (await params.prepareDisplayContent?.())?.map((block) => Object.assign({}, block));
          const message = {
            role: "assistant",
            content: [{ type: "text", text }],
            ...(displayContent ? { [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent } : {}),
            api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
            provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
            model: AUTOMATION_RESULT_MODEL,
            usage: makeZeroUsageSnapshot(),
            stopReason: "stop",
            timestamp: Date.now(),
            idempotencyKey,
            ...(isSessionControllerWorkActive(storePath, identities, params.agentId)
              ? { excludeFromContext: true, openclawModelPlacement: "pending" as const }
              : {}),
            ...(params.provenance ? { openclawAutomation: params.provenance } : {}),
          } satisfies SessionTranscriptAssistantMessage & {
            idempotencyKey: string;
            openclawAutomation?: BackgroundSessionResultProvenance;
            openclawModelPlacement?: "pending";
          };
          owner.assertCurrent();
          params.assertCurrent?.();
          const committed = await persistSessionTranscriptTurn(scope, {
            cwd: current.spawnedCwd,
            expectedSessionId,
            expectedLifecycleRevision: expectedLifecycleRevision ?? null,
            assertCurrent: () => {
              owner.assertCurrent();
              params.assertCurrent?.();
              params.signal?.throwIfAborted();
            },
            messages: [
              {
                message: priorMessage
                  ? {
                      ...priorMessage,
                      content: message.content,
                      ...(params.provenance ? { openclawAutomation: params.provenance } : {}),
                    }
                  : message,
                idempotencyLookup: "scan",
                ...(priorId
                  ? {
                      eventId: priorId,
                      predicate: {
                        kind: "active-entry" as const,
                        entryId: priorId,
                        errorMessage: "background result no longer owns the active transcript",
                      },
                    }
                  : {}),
              },
            ],
            touchSessionEntry: true,
            sessionLifecyclePatch: { lastInteractionAt: message.timestamp },
            updateMode: "inline",
            // A retry can finish media ownership after a committed append failed to publish.
            publishWhen: params.prepareDisplayContent ? "always" : undefined,
            config: params.config,
            onMessageCommitted: params.onMessageCommitted,
          });
          const appended = committed.messages[0];
          return appended
            ? { ok: true }
            : {
                ok: false,
                reason: committed.rejectedReason ?? "background result was not committed",
              };
        },
      );
    },
  });
}
