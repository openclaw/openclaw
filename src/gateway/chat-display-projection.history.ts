import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../agents/internal-runtime-context.js";
import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { createCronJobNameResolver, prepareCronJobNameResolver } from "../cron/store/job-name.js";
import {
  isCompletionReportInputProvenance,
  isSubagentCoordinationInputProvenance,
  INTER_SESSION_PROMPT_PREFIX_BASE,
  normalizeInputProvenance,
  stripInterSessionPromptPrefixForDisplay,
} from "../sessions/input-provenance.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.metadata.js";
import { projectAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { extractChatHistoryBlockText } from "./chat-display-projection.canvas.js";
import {
  asRoleContentMessage,
  extractProjectedText,
  hasAssistantNonTextContent,
  hasAssistantDisplayableNonTextContent,
  hasTranscriptMediaFacts,
  isEmptyTextOnlyContent,
  isProjectedForwardedMessage,
  isForwardedUserMessage,
  isCronRunMessage,
  type RoleContentMessage,
} from "./chat-display-projection.helpers.js";

type TtsSupplementMarker = { textSha256?: string; spokenText?: string };

export type SubagentCoordinationDisplayResolver = {
  assertCurrent?: () => void;
  isSubagentSession: (sessionKey: string) => boolean;
  isSubagentRunMessage: (runId: string, messageSeq: number | undefined) => boolean;
};

export function isSubagentCoordinationHistoryInput(
  message: Record<string, unknown>,
  isSubagentSession?: SubagentCoordinationDisplayResolver["isSubagentSession"],
): boolean {
  if (message.role !== "user") {
    return false;
  }
  const provenance = normalizeInputProvenance(message.provenance);
  if (isSubagentCoordinationInputProvenance(provenance)) {
    return true;
  }
  return Boolean(
    provenance?.kind === "inter_session" &&
    provenance.sourceTool === "sessions_send" &&
    provenance.sourceSessionKey &&
    isSubagentSession?.(provenance.sourceSessionKey),
  );
}

/** Keep coordination in the model transcript while projecting only human-facing outcomes. */
export function createSubagentCoordinationHistoryProjection(
  resolver?: SubagentCoordinationDisplayResolver,
  state: {
    hiddenInputKeys: { add: (key: string) => unknown; has: (key: string) => boolean };
    visibleInputKeys: { add: (key: string) => unknown; has: (key: string) => boolean };
    visibleSteerRunIds: { add: (key: string) => unknown; has: (key: string) => boolean };
  } = {
    hiddenInputKeys: new Set<string>(),
    visibleInputKeys: new Set<string>(),
    visibleSteerRunIds: new Set<string>(),
  },
) {
  const { hiddenInputKeys, visibleInputKeys, visibleSteerRunIds } = state;
  return (messages: unknown[]): unknown[] => {
    resolver?.assertCurrent?.();
    const projected = messages.map((message) => {
      const record = readRecord(message);
      if (!record) {
        return message;
      }
      const metadata = readRecord(record["__openclaw"]);
      if (isSubagentCoordinationHistoryInput(record, resolver?.isSubagentSession)) {
        const inputKey = record.idempotencyKey ?? metadata?.idempotencyKey;
        // Steering belongs to an already-running turn, not the sender's requested run.
        if (typeof inputKey === "string" && !metadata?.steerTargetRunId) {
          hiddenInputKeys.add(inputKey);
        }
        return record.display === false ? record : { ...record, display: false };
      }
      const runId = readSessionTranscriptRunId(record);
      if (record.role === "user") {
        const inputKey = record.idempotencyKey ?? metadata?.idempotencyKey;
        if (typeof inputKey === "string") {
          visibleInputKeys.add(inputKey);
        }
        const steerTargetRunId = metadata?.steerTargetRunId ?? runId;
        if (typeof steerTargetRunId === "string") {
          visibleSteerRunIds.add(steerTargetRunId);
        }
        return message;
      }
      if (record.display === false) {
        return message;
      }
      if (
        (record.role === "assistant" || record.role === "toolResult" || record.role === "custom") &&
        runId &&
        !visibleSteerRunIds.has(runId) &&
        (hiddenInputKeys.has(buildRunUserTurnIdempotencyKey(runId)) ||
          (!visibleInputKeys.has(buildRunUserTurnIdempotencyKey(runId)) &&
            resolver?.isSubagentRunMessage(
              runId,
              typeof metadata?.seq === "number" ? metadata.seq : undefined,
            )))
      ) {
        return { ...record, display: false };
      }
      return message;
    });
    resolver?.assertCurrent?.();
    return projected;
  };
}

function readTtsSupplementMarker(
  message: Record<string, unknown>,
): TtsSupplementMarker | undefined {
  const marker = readRecord(message.openclawTtsSupplement);
  if (!marker) {
    return undefined;
  }
  const textSha256 = normalizeOptionalString(marker.textSha256);
  const spokenText = normalizeOptionalString(marker.spokenText);
  return textSha256 || spokenText ? { textSha256, spokenText } : undefined;
}

function readAssistantTtsSupplementMarker(
  message: Record<string, unknown>,
): TtsSupplementMarker | undefined {
  const marker = readTtsSupplementMarker(message);
  if (!marker || asRoleContentMessage(message)?.role !== "assistant") {
    return undefined;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  let hasSupplementBlock = false;
  for (const block of content) {
    const record = readRecord(block);
    if (!record) {
      continue;
    }
    if (record.type !== "text") {
      hasSupplementBlock = true;
      continue;
    }
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (text && text !== "Audio reply") {
      return undefined;
    }
  }
  return hasSupplementBlock ? marker : undefined;
}

/** Recognize stored supplements using the same display content as full history. */
export function isAssistantTtsSupplementMessage(message: unknown): boolean {
  const record = readRecord(message);
  return (
    record !== undefined &&
    readAssistantTtsSupplementMarker(projectAssistantDisplayContent(record)) !== undefined
  );
}

function readTtsSupplementTargetText(message: Record<string, unknown>): string {
  return asRoleContentMessage(message)?.role === "assistant" &&
    !isProjectedForwardedMessage(message) &&
    !readTtsSupplementMarker(message)
    ? extractProjectedText(message.content ?? message.text).trim()
    : "";
}

function mergeTtsSupplementContent(
  target: Record<string, unknown>,
  supplement: Record<string, unknown>,
): Record<string, unknown> {
  const supplementBlocks = Array.isArray(supplement.content)
    ? supplement.content.filter((block) => {
        const record = readRecord(block);
        return record !== undefined && record.type !== "text";
      })
    : [];
  if (supplementBlocks.length === 0) {
    return target;
  }
  const targetContent = target.content;
  if (Array.isArray(targetContent)) {
    return { ...target, content: [...targetContent, ...supplementBlocks] };
  }
  const targetText = extractProjectedText(targetContent ?? target.text).trim();
  return {
    ...target,
    content: [...(targetText ? [{ type: "text", text: targetText }] : []), ...supplementBlocks],
  };
}

export function mergeTtsSupplementMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!messages.some(readAssistantTtsSupplementMarker)) {
    return messages;
  }
  const targetTexts: Array<string | undefined> = [];
  const targetHashes: Array<string | undefined> = [];
  const merged: Array<Record<string, unknown>> = [];
  let changed = false;
  for (const message of messages) {
    const marker = readAssistantTtsSupplementMarker(message);
    if (marker) {
      let targetIndex = -1;
      for (let i = merged.length - 1; i >= 0; i--) {
        const candidate = merged[i];
        if (!candidate) {
          continue;
        }
        const text = (targetTexts[i] ??= readTtsSupplementTargetText(candidate));
        if (
          text &&
          ((marker.textSha256 &&
            (targetHashes[i] ??= createHash("sha256").update(text).digest("hex")) ===
              marker.textSha256) ||
            (marker.spokenText && text === marker.spokenText))
        ) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex >= 0) {
        merged[targetIndex] = mergeTtsSupplementContent(
          expectDefined(merged[targetIndex], "merged entry at target index"),
          message,
        );
        // Appended media can carry text. Only this replaced position loses its
        // prepared facts; other positions still refer to their original messages.
        targetTexts[targetIndex] = targetHashes[targetIndex] = undefined;
        changed = true;
        continue;
      }
    }
    merged.push(message);
  }
  return changed ? merged : messages;
}

function isSubagentAnnounceInterSessionUserMessage(
  message: Record<string, unknown>,
  readText?: (message: Record<string, unknown>) => string | undefined,
): boolean {
  const provenance = normalizeInputProvenance(message.provenance);
  if (
    provenance?.kind === "inter_session" &&
    (provenance.sourceTool === "subagent_announce" || provenance.sourceTool === "subagent_settle")
  ) {
    return true;
  }
  const text = readText ? readText(message) : extractProjectedText(message.content ?? message.text);
  return (
    typeof text === "string" &&
    text.includes(INTER_SESSION_PROMPT_PREFIX_BASE) &&
    text.includes("sourceTool=subagent_announce")
  );
}

function readChatHistoryRecordTimestampMs(message: unknown): number | undefined {
  const meta = readRecord(readRecord(message)?.["__openclaw"]);
  return asFiniteNumber(meta?.recordTimestampMs) ?? asFiniteNumber(readRecord(message)?.timestamp);
}

export function createPreSessionStartAnnouncePairFilter(sessionStartedAt: number | undefined) {
  let precedingAnnounce = false;
  return (messages: unknown[]): unknown[] => {
    if (sessionStartedAt === undefined || messages.length === 0) {
      return messages;
    }
    let changed = false;
    const kept: unknown[] = [];
    for (const current of messages) {
      if (precedingAnnounce) {
        precedingAnnounce = false;
        const ts =
          readRecord(current)?.role === "assistant"
            ? readChatHistoryRecordTimestampMs(current)
            : undefined;
        if (typeof ts === "number" && ts < sessionStartedAt) {
          changed = true;
          continue;
        }
      }
      const record = readRecord(current);
      if (
        record?.role === "user" &&
        isSubagentAnnounceInterSessionUserMessage(record, extractChatHistoryBlockText)
      ) {
        const ts = readChatHistoryRecordTimestampMs(current);
        if (typeof ts === "number" && ts < sessionStartedAt) {
          // The adjacent assistant may arrive in the next appended chunk.
          precedingAnnounce = true;
          changed = true;
          continue;
        }
      }
      kept.push(current);
    }
    return changed ? kept : messages;
  };
}

export function dropPreSessionStartAnnouncePairs(
  messages: unknown[],
  sessionStartedAt: number | undefined,
): unknown[] {
  return createPreSessionStartAnnouncePairFilter(sessionStartedAt)(messages);
}

function isDisplayHiddenProjectedMessage(message: Record<string, unknown>): boolean {
  if (message.display === false) {
    return true;
  }
  return message.role === "custom" && message.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE;
}

function shouldHideProjectedHistoryMessage(
  message: Record<string, unknown>,
  roleContent: RoleContentMessage | null,
  heartbeatUser: boolean,
): boolean {
  if (isDisplayHiddenProjectedMessage(message)) {
    return true;
  }
  if (isProjectedForwardedMessage(message)) {
    return false;
  }
  if (!roleContent) {
    return false;
  }
  if (roleContent.role === "user" && isCompletionReportInputProvenance(message.provenance)) {
    return true;
  }
  if (roleContent.role === "user" && isSubagentAnnounceInterSessionUserMessage(message)) {
    return true;
  }
  if (
    roleContent.role === "user" &&
    isEmptyTextOnlyContent(message.content ?? message.text) &&
    !hasTranscriptMediaFacts(message)
  ) {
    return true;
  }
  if (roleContent.role === "assistant" && isEmptyTextOnlyContent(message.content ?? message.text)) {
    return false;
  }
  return heartbeatUser || isHeartbeatOkResponse(roleContent);
}

/** Identifies the hidden native input that starts a heartbeat-driven turn. */
export function isHeartbeatHistoryTurnBoundaryMessage(message: unknown): boolean {
  const record = readRecord(message);
  if (!record || isForwardedUserMessage(record)) {
    return false;
  }
  const roleContent = asRoleContentMessage(record);
  return roleContent?.role === "user" && isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT);
}

function attachProjectedTurnBoundary(message: Record<string, unknown>): Record<string, unknown> {
  const metadata = readRecord(message["__openclaw"]);
  if (metadata?.turnBoundary === true) {
    return message;
  }
  return {
    ...message,
    __openclaw: {
      ...metadata,
      turnBoundary: true,
    },
  };
}

function canCarryProjectedTurnBoundary(message: RoleContentMessage | null): boolean {
  return Boolean(message && message.role !== "system" && message.role !== "custom");
}

function openclawAssistantModel(message: Record<string, unknown>): string | undefined {
  return message.role === "assistant" &&
    message.provider === "openclaw" &&
    typeof message.model === "string"
    ? message.model
    : undefined;
}

function displayTextForDuplicateCheck(message: Record<string, unknown>): string | undefined {
  const text = extractProjectedText(message.content ?? message.text).trim();
  return text ? text : undefined;
}

function isDuplicateAcpGatewayInjectedMessage(
  current: Record<string, unknown>,
  previousVisible: Record<string, unknown> | undefined,
): boolean {
  if (!previousVisible) {
    return false;
  }
  if (
    openclawAssistantModel(previousVisible) !== "acp-runtime" ||
    openclawAssistantModel(current) !== "gateway-injected"
  ) {
    return false;
  }
  if (hasAssistantNonTextContent(previousVisible) || hasAssistantNonTextContent(current)) {
    return false;
  }
  const previousText = displayTextForDuplicateCheck(previousVisible);
  const currentText = displayTextForDuplicateCheck(current);
  return Boolean(previousText && currentText && previousText === currentText);
}

function isDuplicateChannelFinalDeliveryMirror(
  current: Record<string, unknown>,
  previousVisible: Record<string, unknown> | undefined,
): boolean {
  if (!previousVisible || !isOpenClawDeliveryMirrorAssistantMessage(current)) {
    return false;
  }
  const deliveryMirror = readRecord(current.openclawDeliveryMirror);
  if (deliveryMirror?.kind !== "channel-final") {
    return false;
  }
  if (asRoleContentMessage(previousVisible)?.role !== "assistant") {
    return false;
  }
  if (isOpenClawDeliveryMirrorAssistantMessage(previousVisible)) {
    return false;
  }
  if (isProjectedForwardedMessage(previousVisible)) {
    return false;
  }
  const previousMeta = readRecord(previousVisible["__openclaw"]);
  if (typeof deliveryMirror.sourceAssistantMessageId === "string") {
    if (
      !deliveryMirror.sourceAssistantMessageId ||
      deliveryMirror.sourceAssistantMessageId !== previousMeta?.id ||
      hasAssistantDisplayableNonTextContent(previousVisible) ||
      hasAssistantNonTextContent(current) ||
      hasTranscriptMediaFacts(previousVisible) ||
      hasTranscriptMediaFacts(current)
    ) {
      return false;
    }
    const previousText = extractAssistantPhaseText(previousVisible)?.trim();
    const currentText = extractAssistantPhaseText(current)?.trim();
    return Boolean(previousText && currentText && previousText === currentText);
  }
  if (typeof previousMeta?.mirrorIdentity !== "string" || !previousMeta.mirrorIdentity.trim()) {
    return false;
  }
  if (hasAssistantNonTextContent(previousVisible) || hasAssistantNonTextContent(current)) {
    return false;
  }
  const previousText = displayTextForDuplicateCheck(previousVisible);
  const currentText = displayTextForDuplicateCheck(current);
  return Boolean(previousText && currentText && previousText === currentText);
}

export function toProjectedMessages(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    const record = readRecord(message);
    return record ? [projectAssistantDisplayContent(record)] : [];
  });
}

export function filterVisibleProjectedHistoryMessages(
  messages: Array<Record<string, unknown>>,
  turnBoundaryPending = false,
): {
  messages: Array<Record<string, unknown>>;
  turnBoundaryPending: boolean;
} {
  if (messages.length === 0) {
    return { messages, turnBoundaryPending };
  }
  let pendingTurnBoundary = turnBoundaryPending;
  let changed = false;
  const visible: Array<Record<string, unknown>> = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (!current) {
      continue;
    }
    const currentRoleContent = asRoleContentMessage(current);
    const heartbeatUser = Boolean(
      currentRoleContent && isHeartbeatUserMessage(currentRoleContent, HEARTBEAT_PROMPT),
    );
    const next = heartbeatUser ? messages[i + 1] : undefined;
    const nextRoleContent = next ? asRoleContentMessage(next) : null;
    if (
      next &&
      nextRoleContent &&
      isHeartbeatOkResponse(nextRoleContent) &&
      !isProjectedForwardedMessage(next)
    ) {
      changed = true;
      pendingTurnBoundary = true;
      i++;
      continue;
    }
    if (shouldHideProjectedHistoryMessage(current, currentRoleContent, heartbeatUser)) {
      changed = true;
      pendingTurnBoundary ||= heartbeatUser && !isForwardedUserMessage(current);
      continue;
    }
    if (
      isDuplicateAcpGatewayInjectedMessage(current, messages[i - 1]) ||
      isDuplicateChannelFinalDeliveryMirror(current, messages[i - 1])
    ) {
      changed = true;
      continue;
    }
    if (pendingTurnBoundary && canCarryProjectedTurnBoundary(currentRoleContent)) {
      visible.push(attachProjectedTurnBoundary(current));
      pendingTurnBoundary = false;
      changed = true;
    } else {
      visible.push(current);
    }
  }
  return {
    messages: changed ? visible : messages,
    turnBoundaryPending: pendingTurnBoundary,
  };
}

function stripPromptPrefixFromContent(content: unknown, strip: (text: string) => string): unknown {
  if (typeof content === "string") {
    return strip(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return block;
    }
    const record = block as Record<string, unknown>;
    if (typeof record.text !== "string") {
      return block;
    }
    const stripped = strip(record.text);
    return stripped === record.text ? block : { ...record, text: stripped };
  });
}

function readForwardedSender(message: Record<string, unknown>) {
  // Only structured provenance identifies the sender; prompt headers are display text.
  const provenance = normalizeInputProvenance(message.provenance);
  const sourceSessionKey = provenance?.sourceSessionKey;
  const parsed = parseAgentSessionKey(sourceSessionKey);
  const agentId = parsed?.agentId;
  const jobId = isCronRunMessage(message)
    ? provenance?.jobId
    : parsed?.rest.match(/^cron:([^:]+):run:[^:]+$/u)?.[1];
  return { sourceSessionKey, agentId, jobId };
}

function resolveForwardedSenderSession(
  message: Record<string, unknown>,
  resolveCronJobName: (jobId: string) => string | undefined,
): { sessionKey?: string; agentId?: string; label?: string } | undefined {
  const { sourceSessionKey, agentId, jobId } = readForwardedSender(message);
  const label = jobId ? (resolveCronJobName(jobId) ?? "Automation") : undefined;
  return sourceSessionKey
    ? { sessionKey: sourceSessionKey, ...(agentId ? { agentId } : {}), ...(label ? { label } : {}) }
    : undefined;
}

function readForwardedCronJobIds(messages: readonly unknown[]) {
  return messages.flatMap((value) => {
    const message = readRecord(value);
    if (!message || (!isForwardedUserMessage(message) && !isProjectedForwardedMessage(message))) {
      return [];
    }
    const jobId = readForwardedSender(message).jobId;
    return jobId ? [jobId] : [];
  });
}

export async function prepareForwardedMessageCronJobNameResolver(
  messages: readonly unknown[],
  storePath?: string,
) {
  return await prepareCronJobNameResolver(readForwardedCronJobIds(messages), storePath);
}

export function projectForwardedMessages(
  messages: Array<Record<string, unknown>>,
  resolveCronJobName?: (jobId: string) => string | undefined,
): Array<Record<string, unknown>> {
  const resolve =
    resolveCronJobName ?? createCronJobNameResolver(readForwardedCronJobIds(messages));
  const names = new Map<string, string | undefined>();
  const resolveName = (jobId: string) => {
    if (!names.has(jobId)) {
      names.set(jobId, resolve(jobId));
    }
    return names.get(jobId);
  };
  let changed = false;
  const projected = messages.map((message) => {
    if (!isForwardedUserMessage(message) && !isProjectedForwardedMessage(message)) {
      return message;
    }
    const senderSession = resolveForwardedSenderSession(message, resolveName);
    if (message.role === "assistant") {
      const previous = readRecord(message.senderSession);
      if (previous?.label === senderSession?.label) {
        return message;
      }
      changed = true;
      return {
        ...message,
        senderSession,
        senderLabel: `Forwarded from ${senderSession?.label ?? senderSession?.agentId}`,
      };
    }
    changed = true;
    const cronRun = isCronRunMessage(message);
    const prefix = normalizeInputProvenance(message.provenance)?.sourcePromptPrefix;
    const strip = cronRun
      ? (text: string) =>
          prefix && text.startsWith(prefix) ? text.slice(prefix.length).replace(/^ /u, "") : text
      : stripInterSessionPromptPrefixForDisplay;
    const next: Record<string, unknown> = {
      ...message,
      role: "assistant",
      ...(cronRun
        ? { __openclaw: { ...readRecord(message["__openclaw"]), turnBoundary: true } }
        : {}),
      senderLabel:
        senderSession?.label || senderSession?.agentId
          ? `Forwarded from ${senderSession.label ?? senderSession.agentId}`
          : "Forwarded agent message",
      ...(senderSession ? { senderSession } : {}),
    };
    if ("content" in next) {
      next.content = stripPromptPrefixFromContent(next.content, strip);
    }
    if (typeof next.text === "string") {
      next.text = strip(next.text);
    }
    return next;
  });
  return changed ? projected : messages;
}
