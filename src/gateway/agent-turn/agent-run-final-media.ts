import { selectSourceDeliverablePayloads } from "../../agents/command/delivery-result.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import { getRuntimeConfig } from "../../config/io.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import {
  attachManagedOutgoingMediaToMessage,
  removeManagedOutgoingMediaBlocks,
} from "../managed-image-attachments.js";
import { hasAssistantDisplayMediaContent } from "../server-methods/chat-assistant-content.js";
import {
  prepareWebchatReplyMediaForDisplay,
  webchatReplyMediaAuthority,
} from "../server-methods/chat-reply-media.js";
import type { createAssistantCommentaryMediaCustody } from "../server-methods/chat-send-commentary-media.js";
import {
  enrichAssistantTranscriptMediaForRun,
  publishAssistantTranscriptRewrite,
} from "../server-methods/chat-transcript-persistence.js";
import { withGatewaySessionEntry } from "../session-utils-store.js";
import { prepareSessionPlacementRead } from "../worker-environments/placement-turn-authority.js";

/** Materialize one visible agent final before its Gateway run releases custody. */
export async function finalizeAgentRunMedia(
  params: Parameters<typeof createAssistantCommentaryMediaCustody>[0] & {
    options: AgentCommandGatewayIngressOpts;
  },
  reply: NonNullable<
    Parameters<NonNullable<AgentCommandGatewayIngressOpts["beforeTerminalDelivery"]>>[0]
  >,
  candidates: OutboundPayloadPlan[],
): Promise<void> {
  const { options, session } = params;
  const visible = new Set(
    selectSourceDeliverablePayloads(
      candidates.map((entry) => entry.payload),
      options,
    ),
  );
  const plan = candidates.filter((entry) => visible.has(entry.payload));
  if (!plan.some(({ parts }) => parts.mediaUrls.length > 0)) {
    return;
  }
  const runId = params.getRunId();
  const assertCurrent = () => {
    params.abortSignal?.throwIfAborted();
    if (!params.isCurrent() || params.getRunId() !== runId) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };
  assertCurrent();
  let active = true;
  let predicate: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let releaseSource: (() => void) | undefined;
  let releasePlacement: (() => void) | undefined;
  let work: Promise<void> | undefined;
  try {
    const state = captureOpenClawStateWorkerContext();
    const placement = await prepareSessionPlacementRead(
      state.admission.databasePath,
      reply.sessionId,
      async () => {
        const records = await executeOpenClawStateWorker(state, {
          type: "workerPlacements.read",
          input: { sessionIds: [reply.sessionId] },
        });
        return records[0];
      },
    );
    releasePlacement = placement.release;
    assertCurrent();
    const initialPlacement = placement.current();
    const prepared = await withGatewaySessionEntry(
      session.sessionKey,
      { agentId: session.agentId },
      (selected) => {
        assertCurrent();
        const source = selected.capturedReadSource;
        if (
          selected.storePath !== reply.storePath ||
          selected.entry?.sessionId !== reply.sessionId ||
          selected.entry.lifecycleRevision !== reply.lifecycleRevision ||
          !source ||
          typeof source.databaseIdentity !== "string"
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        const databaseIdentity = `file:${source.databaseIdentity}`;
        const scope = {
          ...session,
          sessionEntry: selected.entry,
          requesterContext: params.requesterContext,
          accountId: params.accountId,
        };
        const expected = webchatReplyMediaAuthority(scope, initialPlacement);
        predicate = retainPreparedSessionEntryPredicate({
          databaseIdentity,
          sessionKey: selected.legacyKey ?? selected.canonicalKey,
          entry: selected.entry,
          matches: (_before, after) =>
            webchatReplyMediaAuthority({ ...scope, sessionEntry: after }, initialPlacement).key ===
            expected.key,
        });
        releaseSource = registerOpenClawAgentDatabaseAsyncResource({
          agentId: source.agentId,
          path: source.path,
          revoke: () => {
            active = false;
          },
          close: async () => {
            active = false;
            await Promise.allSettled(work ? [work] : []);
          },
        });
        return {
          ...scope,
          readSource: source,
          workspace: expected.workspace,
          assertCurrent: () => {
            assertCurrent();
            assertExistingDatabaseIdentity(source.path, databaseIdentity, source.databaseBirthtime);
            if (
              !active ||
              !predicate?.isCurrent() ||
              webchatReplyMediaAuthority({ ...scope, cfg: getRuntimeConfig() }, placement.current())
                .key !== expected.key
            ) {
              throw new SessionTranscriptWriterClaimReboundError();
            }
          },
        };
      },
      session.cfg,
    );
    work = (async () => {
      const scope = {
        sessionKey: session.sessionKey,
        agentId: session.agentId,
        sessionId: reply.sessionId,
        storePath: reply.storePath,
      };
      const { persistedAssistantContent: content } = await prepareWebchatReplyMediaForDisplay({
        scope: prepared,
        storePath: scope.storePath,
        inputs: plan.map((entry) => ({ kind: "prepared", plan: entry })),
        abortSignal: params.abortSignal,
        includeSensitiveMedia: false,
        includeSensitiveDisplay: false,
      });
      if (!content || !hasAssistantDisplayMediaContent(content)) {
        throw new Error("WebChat final media could not be prepared");
      }
      let retained = false;
      try {
        const rewritten = await withSessionTranscriptWriteAssertion(
          scope,
          prepared.assertCurrent,
          () =>
            enrichAssistantTranscriptMediaForRun({
              scope,
              readSource: prepared.readSource,
              runId,
              expectedLifecycleRevision: reply.lifecycleRevision ?? null,
              content,
              mediaUrls: plan.flatMap((entry) => entry.parts.mediaUrls),
            }),
        );
        if (!rewritten) {
          throw new Error("WebChat final media has no owning assistant transcript message");
        }
        // Committed transcript references own their artifacts even if this run is then revoked.
        retained = true;
        if (
          content.some(
            (block) =>
              block.type === "image" ||
              block.type === "audio" ||
              block.type === "video" ||
              block.type === "attachment",
          ) &&
          !(await attachManagedOutgoingMediaToMessage({
            messageId: rewritten.messageId,
            blocks: content,
          }))
        ) {
          throw new Error("WebChat final media ownership could not be persisted");
        }
        await publishAssistantTranscriptRewrite({
          scope,
          readSource: prepared.readSource,
          rewritten: [rewritten],
        });
      } catch (error) {
        retained ||= hasSqliteWorkerOutcomeUnknown(error);
        throw error;
      } finally {
        if (!retained) {
          await removeManagedOutgoingMediaBlocks({ blocks: content, messageId: null });
        }
      }
    })();
    await work;
  } finally {
    active = false;
    predicate?.release();
    releaseSource?.();
    releasePlacement?.();
  }
}
