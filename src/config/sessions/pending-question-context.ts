import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store-load.js";
import { normalizeStoreSessionKey, updateSessionStore } from "./store.js";
import type { SessionHeartbeatPendingQuestion } from "./types.js";

const DEFAULT_PENDING_QUESTION_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_PENDING_QUESTIONS_PER_SESSION = 8;
const MAX_PENDING_QUESTION_TEXT_CHARS = 2_000;

function resolveStorePathForSession(params: { cfg: OpenClawConfig; sessionKey: string }): string {
  const agentId =
    params.cfg.session?.scope === "global"
      ? resolveDefaultAgentId(params.cfg)
      : resolveAgentIdFromSessionKey(params.sessionKey);
  return resolveStorePath(params.cfg.session?.store, { agentId });
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  const normalized = [
    ...new Set(
      (values ?? [])
        .map(normalizeOptionalString)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePendingQuestion(
  question: SessionHeartbeatPendingQuestion,
): SessionHeartbeatPendingQuestion | undefined {
  const id = normalizeOptionalString(question.id);
  const text = normalizeOptionalString(question.text);
  if (!id || !text) {
    return undefined;
  }
  const commitmentIds = normalizeStringList(question.commitmentIds);
  const sourceRunIds = normalizeStringList(question.sourceRunIds);
  const sourceMessageIds = normalizeStringList(question.sourceMessageIds);
  return {
    id,
    text: text.slice(0, MAX_PENDING_QUESTION_TEXT_CHARS),
    ...(commitmentIds ? { commitmentIds } : {}),
    ...(sourceRunIds ? { sourceRunIds } : {}),
    ...(sourceMessageIds ? { sourceMessageIds } : {}),
    createdAt: Number.isFinite(question.createdAt) ? question.createdAt : Date.now(),
    ...(question.ttlMs !== undefined && Number.isFinite(question.ttlMs) && question.ttlMs >= 0
      ? { ttlMs: question.ttlMs }
      : {}),
  };
}

function isPendingQuestionLive(question: SessionHeartbeatPendingQuestion, now: number): boolean {
  const ttlMs = question.ttlMs ?? DEFAULT_PENDING_QUESTION_TTL_MS;
  return question.createdAt + ttlMs >= now;
}

export async function enqueueHeartbeatPendingQuestion(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  question: SessionHeartbeatPendingQuestion;
  nowMs?: number;
}): Promise<boolean> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }
  const normalizedQuestion = normalizePendingQuestion(params.question);
  if (!normalizedQuestion) {
    return false;
  }
  const storePath = resolveStorePathForSession({ cfg: params.cfg, sessionKey });
  const normalizedKey = normalizeStoreSessionKey(sessionKey);
  const now = params.nowMs ?? Date.now();
  let enqueued = false;
  await updateSessionStore(storePath, (store) => {
    const storeKey = store[normalizedKey] ? normalizedKey : sessionKey;
    const entry = store[storeKey];
    if (!entry) {
      return;
    }
    const existing = (
      Array.isArray(entry.heartbeatPendingQuestions) ? entry.heartbeatPendingQuestions : []
    )
      .map(normalizePendingQuestion)
      .filter((candidate): candidate is SessionHeartbeatPendingQuestion =>
        Boolean(
          candidate &&
          isPendingQuestionLive(candidate, now) &&
          candidate.id !== normalizedQuestion.id,
        ),
      );
    entry.heartbeatPendingQuestions = [...existing, normalizedQuestion].slice(
      -MAX_PENDING_QUESTIONS_PER_SESSION,
    );
    entry.updatedAt = now;
    enqueued = true;
  });
  return enqueued;
}

export function buildHeartbeatPendingQuestionContext(
  questions: SessionHeartbeatPendingQuestion[],
): string | undefined {
  const liveQuestions = questions
    .map(normalizePendingQuestion)
    .filter((question): question is SessionHeartbeatPendingQuestion => Boolean(question));
  if (liveQuestions.length === 0) {
    return undefined;
  }
  const rendered = liveQuestions
    .map((question, index) => {
      const label = liveQuestions.length === 1 ? "Question" : `Question ${index + 1}`;
      return `${label}: ${question.text}`;
    })
    .join("\n");
  return `A proactive heartbeat check-in was delivered to the user before this turn, but that assistant message may be transcript-only and absent from replay history. If the latest user message appears to answer it, interpret the user message in this context and continue naturally. Do not mention heartbeat, commitments, pending-question state, or internal delivery machinery.

${rendered}`;
}

export async function drainHeartbeatPendingQuestionContext(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  nowMs?: number;
}): Promise<string | undefined> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const storePath = resolveStorePathForSession({ cfg: params.cfg, sessionKey });
  const normalizedKey = normalizeStoreSessionKey(sessionKey);
  const loaded = loadSessionStore(storePath, { skipCache: true });
  const loadedEntry = loaded[normalizedKey] ?? loaded[sessionKey];
  if (!loadedEntry?.heartbeatPendingQuestions?.length) {
    return undefined;
  }
  const now = params.nowMs ?? Date.now();
  const drained = await updateSessionStore(storePath, (store) => {
    const storeKey = store[normalizedKey] ? normalizedKey : sessionKey;
    const entry = store[storeKey];
    if (!entry?.heartbeatPendingQuestions?.length) {
      return [] as SessionHeartbeatPendingQuestion[];
    }
    const active = entry.heartbeatPendingQuestions
      .map(normalizePendingQuestion)
      .filter((candidate): candidate is SessionHeartbeatPendingQuestion =>
        Boolean(candidate && isPendingQuestionLive(candidate, now)),
      );
    delete entry.heartbeatPendingQuestions;
    if (active.length > 0) {
      entry.updatedAt = now;
    }
    return active;
  });
  return buildHeartbeatPendingQuestionContext(drained);
}
