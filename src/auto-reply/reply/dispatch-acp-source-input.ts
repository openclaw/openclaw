import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { normalizeMediaFacts } from "../../media/media-facts.js";
import {
  assertAcpSourceTurnDatabaseCurrent,
  captureAcpSourceTurnDatabaseIdentity,
  prepareAcpSourceTurnInput,
  type AcpSourceTurnInputIdentity,
} from "../../sessions/acp-source-turn.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { buildChannelUserTurnSender } from "../../sessions/user-turn-transcript.metadata.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { buildPersistedMediaImageLayout } from "./get-reply-run-helpers.js";
import { normalizeMessageTimestampMs } from "./message-timestamp.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

export function resolveAcpRequestId(ctx: FinalizedRuntimeMsgContext): string {
  const id = ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const normalizedId = normalizeOptionalString(id);
  if (normalizedId) {
    return normalizedId;
  }
  return typeof id === "number" || typeof id === "bigint" ? String(id) : generateSecureUuid();
}

/** Core owns the optional ingress recorder; source metadata never grants runtime admission. */
export function createAcpSourceTurnInputOwner(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedRuntimeMsgContext;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  abortSignal?: AbortSignal;
}) {
  let recorder = params.userTurnTranscriptRecorder;
  let sourceIdentity: AcpSourceTurnInputIdentity | undefined;
  let admittedSourceIdentity: AcpSourceTurnInputIdentity | undefined;
  const assertSourceDatabaseCurrent = () => {
    assertAcpSourceTurnDatabaseCurrent(sourceIdentity, recorder?.getAdmissionReceipt());
    assertAcpSourceTurnDatabaseCurrent(admittedSourceIdentity, recorder?.getAdmissionReceipt());
  };
  const assertCurrent = () => {
    params.abortSignal?.throwIfAborted();
    recorder?.withPendingInput?.(() => {});
    assertSourceDatabaseCurrent();
  };
  return {
    get recorder() {
      return recorder;
    },
    assertCurrent,
    // Settlement retains the physical source after producer custody has completed.
    assertSourceDatabaseCurrent,
    async prepare(
      target: Parameters<typeof prepareAcpSourceTurnInput>[1],
      runId: string,
      assertAdmittedCurrent: () => void,
      assertRouteCurrent: () => Promise<void>,
      assertRuntimeAuthority: () => void,
    ) {
      assertAdmittedCurrent();
      const captured = await captureCanonicalSource(params, assertAdmittedCurrent);
      sourceIdentity = captured?.source;
      const createsRecorder = !recorder && captured !== undefined;
      const assertSourceCurrent = () => {
        assertAdmittedCurrent();
        assertCurrent();
        if (createsRecorder) {
          assertRuntimeAuthority();
        }
      };
      if (!recorder && captured) {
        recorder = createCanonicalSourceRecorder(params, captured, assertSourceCurrent);
      }
      await prepareAcpSourceTurnInput(
        recorder,
        target,
        runId,
        assertSourceCurrent,
        assertRouteCurrent,
        {
          identity: captured?.source,
          onSourceCaptured: (identity) => {
            admittedSourceIdentity = identity;
          },
        },
      );
    },
  };
}

async function captureCanonicalSource(
  { cfg, ctx }: { cfg: OpenClawConfig; ctx: FinalizedRuntimeMsgContext },
  assertCurrent: () => void,
) {
  const sessionKey = normalizeOptionalString(ctx.SessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg, fallbackAgentId: ctx.AgentId });
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  // An actual absent row keeps transcript-only legacy dispatch supported. Read errors propagate.
  const captured = await withSessionEntryReadOnlyInWorker(
    { agentId, sessionKey, storePath, readConsistency: "latest" },
    assertCurrent,
    async (read, owner) => {
      if (!read.ok) {
        throw read.error;
      }
      return {
        entry: read.value,
        database: read.value
          ? captureAcpSourceTurnDatabaseIdentity(owner.selectedStore, owner.source)
          : undefined,
      };
    },
  );
  assertCurrent();
  const { entry, database } = captured;
  if (!entry) {
    return undefined;
  }
  const source: AcpSourceTurnInputIdentity = {
    agentId,
    sessionKey,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    ...(database ? { database } : {}),
  };
  return { source, entry, storePath };
}

function createCanonicalSourceRecorder(
  { cfg, ctx }: { cfg: OpenClawConfig; ctx: FinalizedRuntimeMsgContext },
  { source, entry, storePath }: NonNullable<Awaited<ReturnType<typeof captureCanonicalSource>>>,
  assertCurrent: () => void,
) {
  const { agentId } = source;
  const media = normalizeMediaFacts(ctx.media);
  const conversation = conversationIdentityFromMsgContext({ ctx });
  const messageId =
    normalizeOptionalString(ctx.MessageSidFull) ?? normalizeOptionalString(ctx.MessageSid);
  const replyToId =
    normalizeOptionalString(ctx.ReplyToIdFull) ?? normalizeOptionalString(ctx.ReplyToId);
  const threadId = ctx.MessageThreadId == null ? undefined : String(ctx.MessageThreadId);
  const sourceTurnId = readChannelSourceTurnId(ctx);
  const persistSender =
    ctx.ChatType === "group" ||
    ctx.ChatType === "channel" ||
    (ctx.ChatType === "direct" &&
      ctx.InboundAccessAuthorized === true &&
      ctx.SenderIsSelf !== true);
  return createUserTurnTranscriptRecorder({
    input: {
      text: ctx.rawText,
      media,
      mediaImageLayout: buildPersistedMediaImageLayout({ ctx, media, ctxMediaCount: media.length }),
      timestamp: normalizeMessageTimestampMs(ctx.Timestamp),
      ...(sourceTurnId ? { idempotencyKey: sourceTurnId } : {}),
      ...(ctx.InputProvenance ? { provenance: ctx.InputProvenance } : {}),
      sender: persistSender ? buildChannelUserTurnSender(ctx) : undefined,
      transport: {
        channel: conversation?.channel ?? ctx.OriginatingChannel ?? ctx.Provider,
        conversationRef: conversation?.conversationRef,
        messageId,
        replyToId,
        threadId,
      },
    },
    target: {
      ...source,
      sessionEntry: entry,
      expectedSessionId: entry.sessionId,
      storePath,
      agentId,
      threadId: ctx.MessageThreadId,
      cwd: resolveAgentWorkspaceDir(cfg, agentId),
      config: cfg,
    },
    expectedLifecycleRevision: entry.lifecycleRevision ?? null,
    expectedSessionState: buildRestartRecoveryExpectedState(entry),
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    errorContext: "ACP source user turn transcript",
    assertOriginalInputCommit: assertCurrent,
  });
}
