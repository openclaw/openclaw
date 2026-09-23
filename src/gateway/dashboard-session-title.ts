import { AsyncLocalStorage } from "node:async_hooks";
import { isValidBase64 } from "@openclaw/media-core/base64";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveNativeModelPrimary } from "../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import { createCrustaceanSlug } from "../agents/session-slug.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import type { WorktreeSourceStage } from "../agents/worktrees/types.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTimeout } from "../infra/fs-safe.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import type { ChatAttachment } from "./chat-attachments.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import {
  hasExplicitSessionName,
  resolveExplicitSessionName,
  sessionTitleRequests,
} from "./session-title-state.js";
import { readSessionTitleFieldsFromTranscript } from "./session-transcript-title-reader.js";

type DashboardSessionTitleModelEntry = Pick<
  SessionEntry,
  | "agentHarnessId"
  | "agentRuntimeOverride"
  | "authProfileOverride"
  | "model"
  | "modelOverride"
  | "modelProvider"
  | "modelSelectionLocked"
  | "providerOverride"
>;

const DASHBOARD_SESSION_TITLE_MAX_CHARS = 60;
const DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;
const WORKTREE_SESSION_TITLE_WAIT_MS = 30_000;
const DASHBOARD_SESSION_TITLE_PROMPT =
  "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message, in sentence case: capitalize only the first word and words that language always capitalizes. No emoji. Return only the title.";

function decodeTextAttachmentPrefix(attachment: ChatAttachment, maxChars: number): string | null {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  const content = attachment.content;
  if (!mimeType?.startsWith("text/") || typeof content !== "string" || !content) {
    return null;
  }
  if (!isValidBase64(content)) {
    return null;
  }
  // Three UTF-8 bytes per UTF-16 code unit plus one partial code point is sufficient
  // to fill the title cap without decoding a multi-megabyte pasted attachment.
  const maxBase64Chars = Math.ceil((maxChars * 3 + 3) / 3) * 4;
  const truncated = content.length > maxBase64Chars;
  const prefixLength = truncated ? maxBase64Chars : content.length;
  const prefix = content.slice(0, prefixLength);
  const bytes = Buffer.from(prefix, "base64");
  try {
    // Streaming mode withholds an incomplete trailing code point while still
    // rejecting malformed UTF-8 inside the bounded prefix.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
  } catch {
    return null;
  }
}

/** Builds the bounded model source shared by dashboard and worktree titles. */
export function buildDashboardSessionTitleSource(params: {
  message: string;
  attachments?: readonly ChatAttachment[];
}): string {
  const visibleMessage = params.message.trim();
  const slashCommand = visibleMessage.startsWith("/");
  let source = slashCommand ? "" : visibleMessage;
  for (const attachment of params.attachments ?? []) {
    const separatorLength = source ? 1 : 0;
    const remaining = DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS - source.length - separatorLength;
    if (remaining <= 0) {
      break;
    }
    const text = decodeTextAttachmentPrefix(attachment, remaining)?.trim();
    if (!text) {
      continue;
    }
    source += `${source ? "\n" : ""}${truncateUtf16Safe(text, remaining)}`;
  }
  if (!source && slashCommand) {
    return truncateUtf16Safe(visibleMessage, DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS);
  }
  return truncateUtf16Safe(source.trim(), DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS);
}

type SessionTitleParams = {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  currentUserMessage?: string;
  userMessage: string;
  commitGuard?: () => void;
  withSource?: WorktreeSourceStage;
  retryFailedJoin?: boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
};

function isAutoTitleSessionKey(sessionKey: string): boolean {
  const rest = parseAgentSessionKey(sessionKey)?.rest ?? "";
  return rest.startsWith("dashboard:") || rest.startsWith("ios-") || rest.startsWith("node-");
}

/** True when this interactive chat key should receive an automatic topic title. */
export function isDashboardSessionTitleCandidate(params: {
  sessionKey: string;
  userMessage: string;
}): boolean {
  const sourceText = params.userMessage.trim();
  return Boolean(
    sourceText && !sourceText.startsWith("/") && isAutoTitleSessionKey(params.sessionKey),
  );
}

function resolveDashboardTitleAuthProfile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: DashboardSessionTitleModelEntry | undefined;
  regularProvider: string;
}): string | undefined {
  const sessionProfile = params.entry?.authProfileOverride?.trim();
  if (sessionProfile) {
    return sessionProfile;
  }
  const configuredRef = resolveNativeModelPrimary(params.cfg, params.agentId)?.trim();
  const configuredProfile = configuredRef
    ? splitTrailingAuthProfile(configuredRef).profile
    : undefined;
  if (!configuredProfile) {
    return undefined;
  }
  const configuredModel = resolveSessionModelRef(params.cfg, undefined, params.agentId);
  return configuredModel.provider === params.regularProvider ? configuredProfile : undefined;
}

function normalizeDashboardSessionTitle(raw: string): string | null {
  const firstLine = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("```"));
  if (!firstLine) {
    return null;
  }
  const unwrapped = firstLine.replace(/^\s*(?:title\s*:\s*)?/i, "").replace(/^["'`]+|["'`]+$/g, "");
  const normalized = unwrapped.replace(/\s+/g, " ").trim();
  return normalized ? truncateUtf16Safe(normalized, DASHBOARD_SESSION_TITLE_MAX_CHARS) : null;
}

async function generateDashboardSessionTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry?: DashboardSessionTitleModelEntry;
  userMessage: string;
  utilityOnly?: boolean;
  abortSignal?: AbortSignal;
  assertCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<string | null> {
  const sourceText = buildDashboardSessionTitleSource({
    message: params.userMessage,
  });
  if (!sourceText || sourceText.startsWith("/")) {
    return null;
  }
  const regularModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider: regularModel.provider,
    entry: params.entry,
    cfg: params.cfg,
  });
  const preferredProfile = resolveDashboardTitleAuthProfile({
    cfg: params.cfg,
    agentId: params.agentId,
    entry: params.entry,
    regularProvider: regularModel.provider,
  });
  const regularModelRef = `${regularModel.provider}/${regularModel.model}${
    preferredProfile ? `@${preferredProfile}` : ""
  }`;
  const utilityModelRef = resolveUtilityModelRefForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: regularModel.provider,
    primaryModelRef: regularModelRef,
  });
  try {
    const { generateConversationLabelWithFallback } =
      await import("../auto-reply/reply/conversation-label-generator.js");
    params.assertCurrent?.();
    params.abortSignal?.throwIfAborted();
    const generated = await generateConversationLabelWithFallback({
      userMessage: sourceText,
      prompt: DASHBOARD_SESSION_TITLE_PROMPT,
      cfg: params.cfg,
      agentId: params.agentId,
      ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
      ...(utilityModelRef ? { utilityModelRef } : {}),
      regularModelRef,
      ...(preferredProfile ? { preferredProfile } : {}),
      normalizeLabel: normalizeDashboardSessionTitle,
      maxLength: DASHBOARD_SESSION_TITLE_MAX_CHARS,
      abortSignal: params.abortSignal,
      assertCurrent: params.assertCurrent,
      operatorAuthority: params.operatorAuthority,
      ...(params.utilityOnly ? { utilityOnly: true } : {}),
    });
    if (generated) {
      return normalizeDashboardSessionTitle(generated);
    }
  } catch {
    params.assertCurrent?.();
    params.abortSignal?.throwIfAborted();
  }
  // Speculative utility-only naming must not persist a provisional title that
  // would skip the healthy primary-model pass after send.
  if (params.utilityOnly) {
    return null;
  }
  // Saved titles also name Git branches; never persist raw prompt text as a fallback.
  return createCrustaceanSlug();
}

/** Prepares a creation draft's title without creating or updating a session. */
export async function prepareDashboardSessionTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry?: DashboardSessionTitleModelEntry;
  userMessage: string;
  abortSignal?: AbortSignal;
  assertCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<string | null> {
  try {
    return await generateDashboardSessionTitle({ ...params, utilityOnly: true });
  } catch {
    params.assertCurrent?.();
    params.abortSignal?.throwIfAborted();
    // Speculation is optional; a failed utility pass must not invent a title.
    return null;
  }
}

/** Worktree callers bound their own wait without cancelling another naming owner's request. */
export async function generateWorktreeSessionTitle(
  params: SessionTitleParams & {
    onError: (error: unknown) => void;
    onPersisted: () => void;
  },
): Promise<string | undefined> {
  const request = maybeGenerateSessionTitle(params).then((persisted) => {
    if (persisted) {
      params.onPersisted();
    }
  });
  try {
    await withTimeout(request, WORKTREE_SESSION_TITLE_WAIT_MS, "worktree title generation");
  } catch (error) {
    params.onError(error);
  }
  const readCurrent = (assertSourceCurrent?: () => void) => {
    params.commitGuard?.();
    assertSourceCurrent?.();
    const current = loadSessionEntry({
      agentId: params.agentId,
      sessionKey: resolveStoredSessionKeyForAgentStore(params),
      storePath: params.storePath,
    });
    if (current?.sessionId !== params.sessionId) {
      throw new Error("Session changed while naming its worktree; retry from the current session.");
    }
    return resolveExplicitSessionName(current);
  };
  return params.withSource
    ? await params.withSource((source) => readCurrent(source.assertCurrent))
    : readCurrent();
}

export async function maybeGenerateDashboardSessionTitle(
  params: SessionTitleParams,
): Promise<boolean> {
  return (
    isDashboardSessionTitleCandidate(params) &&
    (await maybeGenerateSessionTitle({ ...params, retryFailedJoin: true }))
  );
}

/** Joins existing work; only the caller that persists a title returns true. */
export async function maybeGenerateSessionTitle(params: SessionTitleParams): Promise<boolean> {
  const sessionKey = resolveStoredSessionKeyForAgentStore(params);
  const scope = { agentId: params.agentId, sessionKey, storePath: params.storePath };
  const entry = loadSessionEntry(scope);
  if (hasExplicitSessionName(entry) || entry?.sessionId !== params.sessionId) {
    return false;
  }

  const requestTarget = { ...scope, sessionId: params.sessionId };
  const existing = sessionTitleRequests.get(requestTarget);
  if (existing) {
    const persisted = await (params.retryFailedJoin ? existing.catch(() => false) : existing);
    // A failed join can retry once with fresh session state and this caller's authority.
    return !persisted && params.retryFailedJoin
      ? await maybeGenerateSessionTitle({ ...params, retryFailedJoin: false })
      : false;
  }

  // A retry may be triggered by a later send or by discussion open. Always
  // title the session from its original user message when the transcript owns it.
  const transcriptSource = readSessionTitleFieldsFromTranscript({
    agentId: params.agentId,
    sessionEntry: entry,
    sessionId: params.sessionId,
    sessionKey,
    storePath: params.storePath,
  }).firstUserMessage;
  const transcriptText = transcriptSource ? stripInboundMetadata(transcriptSource).trim() : "";
  const currentText = params.currentUserMessage?.trim() ?? "";
  // A first-turn transcript may win the persistence race before title work starts.
  // When it is the current turn, retain the supplied attachment-enriched source.
  const sourceText =
    entry.pendingWorktree?.titleSource?.trim() ??
    (!transcriptText || (currentText && currentText === transcriptText)
      ? params.userMessage.trim()
      : transcriptText);
  if (!sourceText) {
    return false;
  }

  const generate = (abortSignal?: AbortSignal) =>
    generateDashboardSessionTitle({
      cfg: params.cfg,
      agentId: params.agentId,
      entry: params.entry ?? entry,
      userMessage: sourceText,
      operatorAuthority: params.operatorAuthority,
      ...(abortSignal ? { abortSignal } : {}),
    });
  const finish = async (generation: Promise<string | null>) => {
    const displayName = await generation;
    if (!displayName) {
      return false;
    }
    const persist = async (assertSourceCurrent?: () => void) => {
      const assertCommitAllowed = assertSourceCurrent
        ? () => {
            params.commitGuard?.();
            assertSourceCurrent();
          }
        : params.commitGuard;
      if (assertSourceCurrent) {
        assertCommitAllowed?.();
      }
      let persisted = false;
      await patchSessionEntryCore(
        scope,
        (current) => {
          if (current.sessionId !== params.sessionId || hasExplicitSessionName(current)) {
            return null;
          }
          persisted = true;
          return { displayName };
        },
        {
          requireWriteSuccess: true,
          ...(assertCommitAllowed ? { assertCommitAllowed } : {}),
        },
      );
      return persisted;
    };
    return params.withSource
      ? await params.withSource((source) => persist(source.assertCurrent))
      : await persist();
  };

  const request = sessionTitleRequests.run(requestTarget, () =>
    Promise.resolve().then(async () => {
      const withSource = params.withSource;
      if (!withSource) {
        params.commitGuard?.();
        return await finish(generate());
      }
      return await runWithAsyncWorkResources(
        async () => {
          const runInGenerationContext = AsyncLocalStorage.snapshot();
          const pending = await withSource((source) => {
            params.commitGuard?.();
            source.assertCurrent();
            // Release source custody during inference; reacquire it only to persist.
            const completion = runInGenerationContext(() =>
              trackAsyncWork(() => generate(getAsyncWorkSignal())),
            );
            void completion.catch(() => undefined);
            return { completion };
          });
          return await finish(pending.completion);
        },
        { cancelOnError: true },
      );
    }),
  );
  return await request;
}
