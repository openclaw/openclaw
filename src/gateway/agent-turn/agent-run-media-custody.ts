import { selectSourceDeliverablePayloads } from "../../agents/command/delivery-result.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import { getRuntimeConfig } from "../../config/io.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import { createOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  attachManagedOutgoingMediaToMessage,
  removeManagedOutgoingMediaBlocks,
} from "../managed-image-attachments.js";
import { hasAssistantDisplayMediaContent } from "../server-methods/chat-assistant-content.js";
import {
  prepareWebchatReplyMediaForDisplay,
  webchatReplyMediaAuthority,
} from "../server-methods/chat-reply-media.js";
import { createAssistantCommentaryMediaCustody } from "../server-methods/chat-send-commentary-media.js";
import {
  enrichAssistantTranscriptMediaForRun,
  publishAssistantTranscriptRewrite,
} from "../server-methods/chat-transcript-persistence.js";
import { withGatewaySessionEntry } from "../session-utils-store.js";

/** Keep final payload media under the same Gateway run that owns its progress media. */
export function createAgentRunMediaCustody(
  params: Parameters<typeof createAssistantCommentaryMediaCustody>[0] & {
    options: AgentCommandGatewayIngressOpts;
    incognito: boolean;
  },
) {
  const { options, session } = params;
  const commentary = createAssistantCommentaryMediaCustody(params);
  const finalize: NonNullable<AgentCommandGatewayIngressOpts["beforeTerminalDelivery"]> = async (
    reply,
  ) => {
    if (
      !reply ||
      params.incognito ||
      options.privateCompletion ||
      options.sessionEffects === "internal" ||
      options.deliver === true ||
      options.internalDeliveryMediaUrls !== undefined ||
      !isInternalMessageChannel(options.channel ?? options.messageChannel)
    ) {
      return;
    }
    const plan = createOutboundPayloadPlan(
      selectSourceDeliverablePayloads(reply.payloads, options),
    ).filter(({ payload, parts }) => payload.sensitiveMedia !== true && parts.mediaUrls.length > 0);
    if (plan.length === 0) {
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
    let work: Promise<void> | undefined;
    try {
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
          const scope = {
            ...session,
            sessionEntry: selected.entry,
            requesterContext: params.requesterContext,
            accountId: params.accountId,
          };
          const expected = webchatReplyMediaAuthority(scope);
          predicate = retainPreparedSessionEntryPredicate({
            databaseIdentity: `file:${source.databaseIdentity}`,
            sessionKey: selected.legacyKey ?? selected.canonicalKey,
            entry: selected.entry,
            matches: (_before, after) =>
              webchatReplyMediaAuthority({ ...scope, sessionEntry: after }) === expected,
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
            assertCurrent: () => {
              assertCurrent();
              assertExistingDatabaseIdentity(
                source.path,
                `file:${source.databaseIdentity}`,
                source.databaseBirthtime,
              );
              if (
                !active ||
                !predicate?.isCurrent() ||
                webchatReplyMediaAuthority({ ...scope, cfg: getRuntimeConfig() }) !== expected
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
          await publishAssistantTranscriptRewrite({ scope, rewritten: [rewritten] });
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
    }
  };
  return {
    run: commentary.run,
    prepareAssistantTranscriptMessage: commentary.prepareAssistantTranscriptMessage,
    finalize,
  };
}
