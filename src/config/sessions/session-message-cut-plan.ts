import { randomUUID } from "node:crypto";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readMessageWorkContext } from "../../chat/work-context.js";
import { assertModelSelectionUnlocked } from "../../sessions/model-overrides.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { SessionMessageCutMutationResult } from "./session-accessor.types.js";
import { findSessionTranscriptHeader } from "./session-entry-codec.js";
import { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { inheritSessionSelection } from "./session-entry-selection.js";
import { extractEditorText } from "./session-message-cut-content.js";
import type {
  SessionMessageCutIntent,
  SessionMessageCutResult,
} from "./session-message-cut.types.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import {
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
  selectSessionTranscriptTreeTipNodes,
} from "./transcript-tree.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
import { MIN_READABLE_SESSION_VERSION } from "./version.js";

type MessageCut = {
  status: "cut";
  editorText?: string;
  editorAttachments?: Array<{ mimeType: string; data: string }>;
  editorMediaRefs?: Array<{ path: string; contentType: string }>;
  parentId: string | null;
  prefix: TranscriptEvent[];
};

export type SessionMessageCutPlan =
  | Exclude<SessionMessageCutResult, { status: "created" }>
  | {
      status: "prepared";
      header: ReturnType<typeof createSessionTranscriptHeader>;
      events: TranscriptEvent[];
      result: Extract<SessionMessageCutResult, { status: "created" }>;
    };

/** Shared history selection and identity policy; the backend owns the atomic install. */
export function planSessionMessageCut(
  currentEntry: SessionEntry | undefined,
  events: readonly TranscriptEvent[],
  params: SessionMessageCutIntent,
  sourceRepositoryWorkspaceId?: string,
): SessionMessageCutPlan {
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  if (
    !params.expectedState ||
    currentEntry.sessionId !== params.expectedState.sessionId ||
    currentEntry.lifecycleRevision !== params.expectedState.lifecycleRevision
  ) {
    return { status: "conflict" };
  }
  if (
    sourceRepositoryWorkspaceId !== undefined &&
    currentEntry.repositoryWorkspaceId !== sourceRepositoryWorkspaceId
  ) {
    throw new Error("Repository workspace changed before session fork");
  }
  // Local cuts rotate transcript identity and clear harness ownership. Locked
  // history must instead stay with its native owner, even without an upstream link.
  assertModelSelectionUnlocked(
    currentEntry,
    "Session history changes are unavailable while model selection is locked.",
  );
  const cut = params.mode === "switch" ? undefined : resolveMessageCut(events, params.entryId);
  if (cut && cut.status !== "cut") {
    return cut;
  }
  if (params.mode === "switch") {
    const tipStatus = validateBranchTip(events, params.entryId);
    if (tipStatus) {
      return { status: tipStatus };
    }
  }
  if (
    params.mode === "fork" &&
    currentEntry.repositoryWorkspaceId &&
    (!params.repositoryWorkspaceId ||
      params.repositoryWorkspaceId === currentEntry.repositoryWorkspaceId)
  ) {
    throw new Error("Repository session fork requires its own prepared workspace");
  }

  const nextSessionId = randomUUID();
  const header = createSessionTranscriptHeader({
    cwd: readTranscriptHeaderCwd(events),
    sessionId: nextSessionId,
    version: findSessionTranscriptHeader(events)?.version ?? MIN_READABLE_SESSION_VERSION,
  });
  const nextEvents =
    params.mode === "fork" && cut
      ? [header, ...cut.prefix]
      : [
          header,
          ...events.filter((event) => !isSessionHeader(event)),
          {
            type: "leaf",
            id: uniqueEntryId(events),
            parentId: readLastEventId(events),
            timestamp: new Date().toISOString(),
            targetId: params.mode === "switch" ? params.entryId : (cut?.parentId ?? null),
          },
        ];
  // Rotating transcript identity fences stale live managers: later snapshot-replace writes
  // target the old session and cannot erase this leaf repoint from the active session.
  const forked = params.mode === "fork";
  const nextEntry: SessionEntry = {
    // Rewind keeps retired history references so cleanup cannot orphan old transcripts.
    ...(forked ? inheritSessionSelection(currentEntry) : currentEntry),
    sessionId: nextSessionId,
    lifecycleRevision: forked ? randomUUID() : currentEntry.lifecycleRevision,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    status: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    estimatedCostUsd: undefined,
    totalTokens: undefined,
    totalTokensFresh: undefined,
    totalTokensVersion: undefined,
    // A rotated transcript cannot resume provider/runtime identity from the old tail.
    // Clear transcript-derived accounting too so the next turn rebuilds canonical state.
    contextTokens: undefined,
    contextTokensSource: undefined,
    contextBudgetStatus: undefined,
    compactionCount: undefined,
    transcriptByteCompactionLatch: undefined,
    memoryFlush: undefined,
    cliSessionBindings: undefined,
    cliSessionIds: undefined,
    claudeCliSessionId: undefined,
    agentHarnessId: undefined,
    modelSelectionLocked: undefined,
    skillsSnapshot: undefined,
    systemPromptReport: undefined,
    restartRecoveryRuns: undefined,
    restartRecoveryForceSafeTools: undefined,
    abortCutoffMessageSid: undefined,
    abortCutoffTimestamp: undefined,
    usageFamilyKey: forked ? undefined : currentEntry.usageFamilyKey,
    usageFamilySessionIds: forked ? undefined : currentEntry.usageFamilySessionIds,
    previousSessionId: forked ? undefined : currentEntry.sessionId,
    ...(forked
      ? {
          forkSource: {
            sessionKey: params.canonicalSourceKey,
            sessionId: currentEntry.sessionId,
            entryId: params.entryId,
          },
          parentSessionKey: params.canonicalSourceKey,
        }
      : {}),
    ...(params.mode === "fork" ? params.forkWorkspace : {}),
    ...(params.mode === "fork" && params.creation
      ? buildSessionCreationStamp(params.creation)
      : {}),
    ...(params.mode === "fork" && params.repositoryWorkspaceId
      ? { repositoryWorkspaceId: params.repositoryWorkspaceId }
      : {}),
    ...(currentEntry.incognito === true || isIncognitoSessionKey(params.canonicalSourceKey)
      ? { incognito: true as const }
      : {}),
  };
  return {
    status: "prepared",
    header,
    events: nextEvents,
    result: {
      status: "created",
      key: params.targetKey,
      entry: nextEntry,
      ...(cut?.editorText ? { editorText: cut.editorText } : {}),
      ...(cut?.editorAttachments ? { editorAttachments: cut.editorAttachments } : {}),
      ...(cut?.editorMediaRefs ? { editorMediaRefs: cut.editorMediaRefs } : {}),
    },
  };
}

function validateBranchTip(
  events: readonly TranscriptEvent[],
  entryId: string,
): "missing-entry" | "not-branch-tip" | "already-active" | undefined {
  const tree = scanSessionTranscriptTree(events);
  const target = tree.byId.get(entryId);
  if (!target) {
    return "missing-entry";
  }
  if (isSessionTranscriptLeafControl(target.entry)) {
    return "not-branch-tip";
  }
  if (!selectSessionTranscriptTreeTipNodes(tree).some((node) => node.id === entryId)) {
    return "not-branch-tip";
  }
  return tree.leafId === entryId ? "already-active" : undefined;
}

function resolveMessageCut(
  events: readonly TranscriptEvent[],
  entryId: string,
): MessageCut | Exclude<SessionMessageCutMutationResult, { status: "created" }> {
  const tree = scanSessionTranscriptTree(events);
  const target = tree.byId.get(entryId);
  if (!target) {
    return { status: "missing-entry" };
  }
  const record = asRecord(target.entry);
  const message = asRecord(record?.message);
  if (record?.type !== "message" || message?.role !== "user") {
    return { status: "not-user-message" };
  }
  const activePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const targetIndex = activePath.findIndex((node) => node.id === entryId);
  if (targetIndex < 0) {
    return { status: "off-active-path" };
  }
  const prefix: TranscriptEvent[] = [];
  for (const node of activePath.slice(0, targetIndex)) {
    const entry = asRecord(node.entry);
    // Spread (not Object.assign) so a parsed own `__proto__` key stays an inert
    // data property instead of rebinding the copy's prototype.
    prefix.push(
      entry && entry.parentId !== node.parentId
        ? { ...entry, parentId: node.parentId }
        : node.entry,
    );
  }
  const editorAttachments = extractEditorAttachments(message.content);
  const editorMediaRefs = extractEditorMediaRefs(message);
  return {
    status: "cut",
    editorText: readMessageWorkContext(message)?.text ?? extractEditorText(message.content),
    ...(editorAttachments ? { editorAttachments } : {}),
    ...(editorMediaRefs ? { editorMediaRefs } : {}),
    parentId: target.parentId,
    prefix,
  };
}

// Gateway-written inline images are already size-capped at send time; these bounds
// only keep a corrupted transcript from ballooning the rewind/fork response.
const EDITOR_ATTACHMENT_LIMIT = 10;
const EDITOR_ATTACHMENT_MAX_BASE64_CHARS = Math.ceil((5 * 1024 * 1024) / 3) * 4;

function extractEditorAttachments(
  content: unknown,
): Array<{ mimeType: string; data: string }> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const attachments = content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "image" &&
      typeof record.data === "string" &&
      record.data.trim() &&
      record.data.length <= EDITOR_ATTACHMENT_MAX_BASE64_CHARS &&
      typeof record.mimeType === "string" &&
      record.mimeType.startsWith("image/")
      ? [{ mimeType: record.mimeType, data: record.data }]
      : [];
  });
  return attachments.length > 0 ? attachments.slice(0, EDITOR_ATTACHMENT_LIMIT) : undefined;
}

function extractEditorMediaRefs(
  message: Record<string, unknown>,
): Array<{ path: string; contentType: string }> | undefined {
  const media = asRecord(message["__openclaw"])?.media;
  if (!Array.isArray(media)) {
    return undefined;
  }
  const refs = media.flatMap((entry) => {
    const record = asRecord(entry);
    const mediaUrl = typeof record?.url === "string" ? record.url.trim() : undefined;
    const mediaPath =
      mediaUrl === undefined
        ? typeof record?.path === "string"
          ? record.path.trim()
          : ""
        : /^media:\/\//i.test(mediaUrl)
          ? mediaUrl
          : "";
    const contentType = record?.contentType;
    return mediaPath && typeof contentType === "string" && contentType.startsWith("image/")
      ? [{ path: mediaPath, contentType }]
      : [];
  });
  return refs.length > 0 ? refs : undefined;
}

function isSessionHeader(event: unknown): boolean {
  return asRecord(event)?.type === "session";
}

function readTranscriptHeaderCwd(events: readonly TranscriptEvent[]): string | undefined {
  const cwd = asRecord(events.find(isSessionHeader))?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
}

function readLastEventId(events: readonly TranscriptEvent[]): string | null {
  const id = asRecord(events.findLast((event) => !isSessionHeader(event)))?.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function uniqueEntryId(events: readonly TranscriptEvent[]): string {
  const ids = new Set(
    events.flatMap((event) => {
      const id = asRecord(event)?.id;
      return typeof id === "string" ? [id] : [];
    }),
  );
  for (;;) {
    const id = randomUUID().slice(0, 8);
    if (!ids.has(id)) {
      return id;
    }
  }
}
