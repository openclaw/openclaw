import { createHash } from "node:crypto";
import type { HumanMention } from "@openclaw/gateway-protocol";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runAgentHarnessBeforeMessageWriteHook } from "../../../agents/harness/hook-helpers.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../../../sessions/user-turn-transcript.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import { buildCollectPrompt } from "../../../utils/queue-helpers.js";
import type { FollowupRun } from "./types.js";

// Prompt and transcript projection for a collected followup batch.

export function renderCollectItem(item: FollowupRun, idx: number): string {
  return renderCollectItemPrompt(
    item,
    idx,
    resolveCollectedSourceText(
      item.userTurnTranscriptRecorder?.getPendingInputMessage?.(),
      item.prompt,
    ),
  );
}

function resolveCollectedSourceText(
  message: PersistedUserTurnMessage | undefined,
  fallback: string,
): string {
  return message
    ? (extractTextFromChatContent(message.content, {
        normalizeText: (text) => text,
        joinWith: "\n",
      }) ?? "")
    : fallback;
}

function buildCollectItemPrefix(item: FollowupRun, idx: number): string {
  const senderLabel =
    item.run.senderName ?? item.run.senderUsername ?? item.run.senderId ?? item.run.senderE164;
  const senderSuffix = senderLabel ? ` (from ${senderLabel})` : "";
  return `---\nQueued #${idx + 1}${senderSuffix}\n`;
}

function renderCollectItemPrompt(item: FollowupRun, idx: number, prompt: string): string {
  return `${buildCollectItemPrefix(item, idx)}${prompt}`.trim();
}

export function buildCollectTranscriptInput(
  items: FollowupRun[],
  messages?: (PersistedUserTurnMessage | undefined)[],
): { text: string; mentions: HumanMention[] } {
  const title = "[Queued messages while agent was busy]";
  const mentions: HumanMention[] = [];
  let offset = title.length;
  const text = buildCollectPrompt({
    title,
    items,
    renderItem: (item, index) => {
      const message = messages?.[index] ?? item.userTurnTranscriptRecorder?.message;
      // Staging may redact or rewrite a source. Collection must never restore
      // its pre-approval text from the queue's display/runtime projection.
      const sourceText = resolveCollectedSourceText(message, item.transcriptPrompt ?? item.prompt);
      const block = renderCollectItemPrompt(item, index, sourceText);
      const sourceOffset = offset + 2 + buildCollectItemPrefix(item, index).length;
      const sourceEnd = sourceText.trimEnd().length;
      for (const mention of message?.["__openclaw"]?.humanMentions ?? []) {
        if (mention.end <= sourceEnd) {
          mentions.push({
            ...mention,
            start: sourceOffset + mention.start,
            end: sourceOffset + mention.end,
          });
        }
      }
      offset += 2 + block.length;
      return block;
    },
  });
  return { text, mentions };
}

export function resolveFollowupTranscriptTarget(source: FollowupRun) {
  const sessionKey = normalizeOptionalString(source.run.sessionKey) ?? source.run.sessionId;
  const storePath = resolveSessionStorePathCore(source.run.config.session?.store, {
    agentId: source.run.agentId,
  });
  const sessionEntry = loadSessionEntryReadOnly({
    storePath,
    sessionKey,
    clone: false,
  });
  return {
    sessionId: sessionEntry?.sessionId ?? source.run.sessionId,
    sessionKey,
    sessionEntry,
    storePath,
    agentId: source.run.agentId,
    cwd: source.run.cwd ?? source.run.workspaceDir,
    config: source.run.config,
  };
}

export function createCollectUserTurnTranscriptRecorder(items: FollowupRun[]) {
  const transcriptSources = items.filter((item) => item.userTurnTranscriptRecorder);
  const source = transcriptSources.at(-1);
  if (!source) {
    return undefined;
  }
  const buildInput = async () => {
    const messages = await Promise.all(
      transcriptSources.map(
        async (item) => await item.userTurnTranscriptRecorder?.resolveMessage(),
      ),
    );
    const media = messages.flatMap((message) =>
      buildPersistedUserTurnMediaInputsFromFields(message),
    );
    const timestamp = messages.reduce<number | undefined>((latest, message) => {
      const candidate = message?.timestamp;
      return typeof candidate === "number" && (latest === undefined || candidate > latest)
        ? candidate
        : latest;
    }, undefined);
    const transcriptInput = buildCollectTranscriptInput(transcriptSources, messages);
    const identityHash = createHash("sha256")
      .update(
        JSON.stringify(
          transcriptSources.map((item) => [
            item.messageId ?? "",
            item.enqueuedAt,
            item.transcriptPrompt,
          ]),
        ),
      )
      .digest("hex");
    return {
      ...transcriptInput,
      senderIsOwner: source.run.senderIsOwner,
      provenance: source.run.inputProvenance,
      idempotencyKey: `followup-collect:${source.run.sessionId}:${identityHash}`,
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(media.length === 0 ? {} : { media }),
    };
  };
  const initialTranscriptInput = buildCollectTranscriptInput(transcriptSources);
  return createUserTurnTranscriptRecorder({
    input: {
      ...initialTranscriptInput,
      senderIsOwner: source.run.senderIsOwner,
      provenance: source.run.inputProvenance,
    },
    resolveInput: buildInput,
    pendingInputSources: transcriptSources.flatMap((item) => item.userTurnTranscriptRecorder ?? []),
    target: () => resolveFollowupTranscriptTarget(source),
    errorContext: "collected followup user turn transcript",
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
  });
}
