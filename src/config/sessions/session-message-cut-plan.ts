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
  message: Record<string, unknown>;
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

/** Rewind and switch install one appended control row on the existing transcript. */
export type SessionMessageCutInPlacePlan =
  | Exclude<SessionMessageCutResult, { status: "created" }>
  | {
      status: "prepared";
      leafEvent: TranscriptEvent;
      /** Selected active tip after the repoint; null restores an empty branch. */
      leafTargetId: string | null;
      result: Extract<SessionMessageCutResult, { status: "created" }>;
    };

export type SessionMessageCutTarget = {
  eventType: string | null;
  /** Stored message role from navigation facts; no payload is decoded for it. */
  messageRole: string | null;
  /** Visible predecessor on the active path, or null at the root. */
  repointTargetId: string | null;
  onActivePath: boolean;
};

export type SessionMessageCutReader = {
  readTarget(entryId: string): SessionMessageCutTarget | undefined;
  /**
   * The selected user message, read only after the cut is validated: a rewind
   * returns its editor text and attachments. Over-budget payloads are refused.
   */
  readEditorMessage(entryId: string): Record<string, unknown> | undefined;
  /** True when the canonical navigation owner lists this entry as a selectable tip. */
  isBranchTip(entryId: string): boolean;
  /**
   * True when the canonical owner resolves the planned control to this target.
   * Reset normalization can rewrite a control onto the current leaf, which would
   * silently ignore the request, so both modes refuse instead.
   */
  canonicalSelectionHolds(targetId: string | null): boolean;
  /** Canonical path to this leaf, as physical sequences; indexed readers only. */
  canonicalBranchPathSeqs?(leafEventId: string): readonly number[] | undefined;
  activeLeafEventId(): string | null;
  /** Physical append cursor: the newest identity row, which the leaf control chains onto. */
  tailEventId(): string | null;
  allocateEventId(): string;
};

/**
 * Reader for a memory-resident transcript, where the whole event list is already
 * in the actor's working state and the navigation tree is the only index.
 */
export function createMemorySessionMessageCutReader(
  events: readonly unknown[],
): SessionMessageCutReader {
  const tree = scanSessionTranscriptTree(events);
  const activeIds = new Set(
    selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.id),
  );
  let controlId: string | undefined;
  const allocateEventId = () => {
    for (; controlId === undefined;) {
      const candidate = randomUUID().slice(0, 8);
      if (!tree.byId.has(candidate)) {
        controlId = candidate;
      }
    }
    return controlId;
  };
  // The scanner resolves a control in file order, so the only honest answer to
  // "what will this cut select" comes from rescanning with the planned control.
  const resolve = (targetId: string | null) =>
    scanSessionTranscriptTree([
      ...events,
      { type: "leaf", id: allocateEventId(), parentId: tree.nodes.at(-1)?.id ?? null, targetId },
    ]);
  return {
    readTarget(entryId) {
      const node = tree.byId.get(entryId);
      if (!node) {
        return undefined;
      }
      const record = asRecord(node.entry);
      const role = asRecord(record?.message)?.role;
      return {
        eventType: typeof record?.type === "string" ? record.type : null,
        messageRole: typeof role === "string" ? role : null,
        onActivePath: activeIds.has(entryId),
        repointTargetId: node.parentId,
      };
    },
    readEditorMessage: (entryId) => asRecord(asRecord(tree.byId.get(entryId)?.entry)?.message),
    isBranchTip(entryId) {
      const node = tree.byId.get(entryId);
      return (
        node !== undefined &&
        !isSessionTranscriptLeafControl(node.entry) &&
        resolve(entryId).leafId === entryId &&
        selectSessionTranscriptTreeTipNodes(tree).some((tip) => tip.id === entryId)
      );
    },
    canonicalSelectionHolds: (targetId) => resolve(targetId).leafId === targetId,
    activeLeafEventId: () => tree.leafId,
    tailEventId: () => tree.nodes.at(-1)?.id ?? null,
    allocateEventId,
  };
}

/** Fork identity and prefix policy; the backend owns the atomic install. */
export function planSessionMessageCut(
  entry: SessionEntry | undefined,
  events: readonly TranscriptEvent[],
  params: SessionMessageCutIntent & { mode: "fork" },
  sourceRepositoryWorkspaceId?: string,
): SessionMessageCutPlan {
  const refusal = refuseUnselectableMessageCut(entry, params, sourceRepositoryWorkspaceId);
  if (refusal) {
    return refusal;
  }
  const currentEntry = entry!;
  const cut = resolveForkPrefix(events, params.entryId);
  if (cut.status !== "cut") {
    return cut;
  }
  if (
    currentEntry.repositoryWorkspaceId &&
    (!params.repositoryWorkspaceId ||
      params.repositoryWorkspaceId === currentEntry.repositoryWorkspaceId)
  ) {
    throw new Error("Repository session fork requires its own prepared workspace");
  }
  if (settledWorkspaceConflicts(currentEntry, params)) {
    return { status: "conflict" };
  }
  const nextSessionId = randomUUID();
  const header = createSessionTranscriptHeader({
    cwd: readTranscriptHeaderCwd(events),
    sessionId: nextSessionId,
    version: findSessionTranscriptHeader(events)?.version ?? MIN_READABLE_SESSION_VERSION,
    // The prefix comes from the counted active path, so the source already counts
    // every event through its last id.
    inheritedThrough: [readLastEventId(cut.prefix)].filter((id): id is string => id !== null),
  });
  return {
    status: "prepared",
    header,
    events: [header, ...cut.prefix],
    result: {
      status: "created",
      key: params.targetKey,
      entry: buildMessageCutSessionEntry(currentEntry, params, nextSessionId),
      ...readMessageCutEditorFields(cut.message),
    },
  };
}

/**
 * Rewind and branch switch install their repoint on the existing transcript.
 *
 * The appended `leaf` control is the only semantic change, so the session keeps
 * its id and the committing writer fences stale writers with the transcript
 * generation and mutation watermark instead of a new transcript identity.
 */
export function planInPlaceSessionMessageCut(
  entry: SessionEntry | undefined,
  reader: SessionMessageCutReader,
  params: SessionMessageCutIntent & { mode: "rewind" | "switch" },
  sourceRepositoryWorkspaceId?: string,
): SessionMessageCutInPlacePlan {
  const refusal = refuseUnselectableMessageCut(entry, params, sourceRepositoryWorkspaceId);
  if (refusal) {
    return refusal;
  }
  const currentEntry = entry!;
  const target = reader.readTarget(params.entryId);
  if (!target) {
    return { status: "missing-entry" };
  }
  let message: Record<string, unknown> | undefined;
  let repointTargetId: string | null;
  if (params.mode === "switch") {
    if (target.eventType === "leaf" || !reader.isBranchTip(params.entryId)) {
      return { status: "not-branch-tip" };
    }
    if (reader.activeLeafEventId() === params.entryId) {
      return { status: "already-active" };
    }
    repointTargetId = params.entryId;
  } else {
    if (target.eventType !== "message" || target.messageRole !== "user") {
      return { status: "not-user-message" };
    }
    if (!target.onActivePath) {
      return { status: "off-active-path" };
    }
    repointTargetId = target.repointTargetId;
  }
  // A later reset re-roots navigation, so the canonical owner would rewrite this
  // control onto the current leaf and ignore the request. Refuse it instead.
  if (!reader.canonicalSelectionHolds(repointTargetId)) {
    return { status: params.mode === "switch" ? "not-branch-tip" : "off-active-path" };
  }
  if (settledWorkspaceConflicts(currentEntry, params)) {
    return { status: "conflict" };
  }
  // Validated: the rewind's editor payload is the only body this path reads.
  if (params.mode === "rewind") {
    message = reader.readEditorMessage(params.entryId);
  }
  return {
    status: "prepared",
    leafTargetId: repointTargetId,
    leafEvent: {
      type: "leaf",
      id: reader.allocateEventId(),
      parentId: reader.tailEventId(),
      timestamp: new Date().toISOString(),
      targetId: repointTargetId,
    },
    result: {
      status: "created",
      key: params.targetKey,
      entry: buildMessageCutSessionEntry(currentEntry, params, currentEntry.sessionId),
      ...readMessageCutEditorFields(message),
    },
  };
}

/** Preconditions shared by both planners, independent of how history is read. */
function refuseUnselectableMessageCut(
  currentEntry: SessionEntry | undefined,
  params: SessionMessageCutIntent,
  sourceRepositoryWorkspaceId?: string,
): Exclude<SessionMessageCutResult, { status: "created" }> | undefined {
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
  // Local cuts clear harness ownership. Locked history must instead stay with
  // its native owner, even without an upstream link.
  assertModelSelectionUnlocked(
    currentEntry,
    "Session history changes are unavailable while model selection is locked.",
  );
  return undefined;
}

function settledWorkspaceConflicts(
  currentEntry: SessionEntry,
  params: SessionMessageCutIntent,
): boolean {
  const workspace = params.settledLocalWorkspace;
  return Boolean(
    workspace &&
    (params.mode === "fork" ||
      currentEntry.worktree?.id !== workspace.worktreeId ||
      currentEntry.sessionId !== workspace.sessionId ||
      (currentEntry.lifecycleRevision ?? null) !== workspace.lifecycleRevision),
  );
}

/**
 * The destination entry for every message cut.
 *
 * Fork installs a detached identity. Rewind and switch keep theirs and reset
 * only the state the moved transcript tail invalidates, so the next turn
 * rebuilds context, run and harness facts from the new active path.
 */
function buildMessageCutSessionEntry(
  currentEntry: SessionEntry,
  params: SessionMessageCutIntent,
  sessionId: string,
): SessionEntry {
  const forked = params.mode === "fork";
  const workspace = params.settledLocalWorkspace;
  // In-place cuts keep the transcript identity, so the lifecycle revision is the
  // fence that retires pre-cut owners: live workspace custody, owned transcript
  // writers and lifecycle-scoped authority all compare it.
  const lifecycleRevision = randomUUID();
  return {
    ...(forked ? inheritSessionSelection(currentEntry) : currentEntry),
    sessionId,
    lifecycleRevision,
    localWorkspaceHandoff: workspace
      ? {
          worktreeId: workspace.worktreeId,
          fromSessionId: workspace.sessionId,
          toSessionId: sessionId,
          // The settled incarnation this custody record transfers from.
          lifecycleRevision: workspace.lifecycleRevision,
          projectionRevision: workspace.projectionRevision,
        }
      : undefined,
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
    // A moved transcript tail cannot resume provider/runtime identity. Clear
    // transcript-derived accounting too so the next turn rebuilds canonical state.
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
    resumeAfterRestart: undefined,
    abortCutoffMessageSid: undefined,
    abortCutoffTimestamp: undefined,
    ...(forked
      ? {
          forkSource: {
            sessionKey: params.canonicalSourceKey,
            sessionId: currentEntry.sessionId,
            entryId: params.entryId,
          },
          parentSessionKey: params.canonicalSourceKey,
          ...(currentEntry.visibility === "draft" ? { visibility: "draft" as const } : {}),
          ...params.forkWorkspace,
          ...(params.creation ? buildSessionCreationStamp(params.creation) : {}),
          ...(params.repositoryWorkspaceId
            ? { repositoryWorkspaceId: params.repositoryWorkspaceId }
            : {}),
        }
      : {}),
    ...(currentEntry.incognito === true || isIncognitoSessionKey(params.canonicalSourceKey)
      ? { incognito: true as const }
      : {}),
  };
}

function readMessageCutEditorFields(message: Record<string, unknown> | undefined) {
  if (!message) {
    return {};
  }
  const editorText = readMessageWorkContext(message)?.text ?? extractEditorText(message.content);
  const editorAttachments = extractEditorAttachments(message.content);
  const editorMediaRefs = extractEditorMediaRefs(message);
  return {
    ...(editorText ? { editorText } : {}),
    ...(editorAttachments ? { editorAttachments } : {}),
    ...(editorMediaRefs ? { editorMediaRefs } : {}),
  };
}

function resolveForkPrefix(
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
  return {
    status: "cut",
    message,
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
