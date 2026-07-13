import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentConfig, resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveModel } from "../../agents/embedded-agent-runner/model.js";
import { isEmbeddedAgentRunActive } from "../../agents/embedded-agent-runner/runs.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { filterHeartbeatTranscriptTurns } from "../../auto-reply/heartbeat-filter.js";
import { resolveHeartbeatPrompt } from "../../auto-reply/heartbeat.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  listSessionTranscriptInstances,
  readTranscriptStatsSync,
  type SessionTranscriptInstance,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  createCorePluginStateSyncKeyedStore,
  MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
} from "../../plugin-state/plugin-state-store.js";
import { CommandLane } from "../../process/lanes.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
} from "../../routing/session-key.js";
import { formatSkillExperienceReviewTranscript } from "./experience-review-prompt.js";
import {
  buildSkillHistoryScanPrompt,
  type SkillHistoryScanPromptSession,
} from "./history-scan-prompt.js";
import { getSkillProposalRunProgress } from "./service.js";
import type { SkillWorkshopProposalReviewProgress } from "./types.js";

const HISTORY_SCAN_SCHEMA = "openclaw.skill-workshop.history-scan.v1";
const HISTORY_SCAN_MAX_CANDIDATES = 60;
const HISTORY_SCAN_MAX_SESSIONS = 20;
const HISTORY_SCAN_MAX_TRANSCRIPT_CHARS = 80_000;
const HISTORY_SCAN_MAX_SESSION_CHARS = 16_000;
const HISTORY_SCAN_MAX_RECENT_MESSAGES = 80;
const HISTORY_SCAN_MAX_LOCAL_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS = 3;
const HISTORY_SCAN_DEFAULT_CONTEXT_TOKENS = 8_192;
const HISTORY_SCAN_SESSION_OVERHEAD_CHARS = 256;
const HISTORY_SCAN_MIN_MODEL_ITERATIONS = 6;
const HISTORY_SCAN_TIMEOUT_MS = 10 * 60_000;
const HISTORY_SCAN_SESSION_SEGMENT = "skill-workshop-history-scan";
const HISTORY_SCAN_BLOCKED_SEGMENTS = new Set([
  "active-memory",
  "commitments",
  "heartbeat",
  "hook",
  "memory",
  "skill-workshop-review",
  HISTORY_SCAN_SESSION_SEGMENT,
]);

export type SkillHistoryScanDirection = "older" | "newer";

export type SkillHistoryScanResult = {
  schema: typeof HISTORY_SCAN_SCHEMA;
  hasScanned: boolean;
  reviewedSessions: number;
  ideasFound: number;
  hasMore: boolean;
  lastScanReviewed: number;
  lastScanIdeas: number;
  lastScanAt?: string;
  oldestReviewedAt?: string;
  newestReviewedAt?: string;
};

export type SkillHistoryScanCursor = {
  instanceId: string;
  updatedAtMs: number;
};

type StoredSkillHistoryScanSnapshot = SkillHistoryScanResult & {
  oldestCursor?: SkillHistoryScanCursor;
  newestCursor?: SkillHistoryScanCursor;
};

type StoredSkillHistoryScanState = StoredSkillHistoryScanSnapshot & {
  pending?: {
    direction: SkillHistoryScanDirection;
    runId: string;
    next: StoredSkillHistoryScanSnapshot;
    progress: SkillWorkshopProposalReviewProgress;
    sessionCursors: SkillHistoryScanCursor[];
    completed?: {
      ideasFound: number;
    };
  };
};

export type SkillHistoryScanCandidate = {
  entry: SessionTranscriptInstance["entry"];
  instanceId: string;
  sessionKey: string;
  updatedAtMs: number;
};

type SkillHistoryScanRunParams = {
  agentId: string;
  config: OpenClawConfig;
  direction?: SkillHistoryScanDirection;
  env?: NodeJS.ProcessEnv;
  workspaceDir: string;
};

type ActiveSkillHistoryScan = {
  direction: SkillHistoryScanDirection;
  run: Promise<SkillHistoryScanResult>;
};

const historyScansInFlight = new Map<string, ActiveSkillHistoryScan>();

function historyScanStore(env?: NodeJS.ProcessEnv) {
  return createCorePluginStateSyncKeyedStore<StoredSkillHistoryScanState>({
    ownerId: "core:skill-workshop",
    namespace: "history-scan",
    maxEntries: MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
}

function historyScanStateKey(agentId: string, workspaceDir: string, storePath: string): string {
  const scope = createHash("sha256")
    .update(`${agentId}\0${path.resolve(workspaceDir)}\0${path.resolve(storePath)}`)
    .digest("hex");
  return `${agentId}:${scope}`;
}

function emptyHistoryScanResult(): SkillHistoryScanResult {
  return {
    schema: HISTORY_SCAN_SCHEMA,
    hasScanned: false,
    reviewedSessions: 0,
    ideasFound: 0,
    hasMore: false,
    lastScanReviewed: 0,
    lastScanIdeas: 0,
  };
}

function isStoredHistoryScanState(value: unknown): value is StoredSkillHistoryScanState {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schema?: unknown }).schema === HISTORY_SCAN_SCHEMA,
  );
}

function loadHistoryScanState(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir: string;
}): StoredSkillHistoryScanState | undefined {
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  const value = historyScanStore(params.env).lookup(
    historyScanStateKey(params.agentId, params.workspaceDir, storePath),
  );
  return isStoredHistoryScanState(value) ? value : undefined;
}

export function getSkillHistoryScanStatus(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir: string;
}): SkillHistoryScanResult {
  return toPublicHistoryScanResult(loadHistoryScanState(params) ?? emptyHistoryScanResult());
}

function toPublicHistoryScanResult(state: StoredSkillHistoryScanState): SkillHistoryScanResult {
  const {
    oldestCursor: _oldestCursor,
    newestCursor: _newestCursor,
    pending: _pending,
    ...result
  } = state;
  return result;
}

function withoutPendingHistoryScan(
  state: StoredSkillHistoryScanState,
): StoredSkillHistoryScanSnapshot {
  const { pending: _pending, ...snapshot } = state;
  return snapshot;
}

function withHistoryScanIdeas(params: {
  next: StoredSkillHistoryScanSnapshot;
  previous: StoredSkillHistoryScanSnapshot;
  ideasFound: number;
}): StoredSkillHistoryScanSnapshot {
  return {
    ...params.next,
    ideasFound: params.previous.ideasFound + params.ideasFound,
    lastScanIdeas: params.ideasFound,
  };
}

export function isSkillHistoryScanSessionEligible(
  summary: Pick<SessionTranscriptInstance, "acpOwned" | "entry" | "provenanceKnown" | "sessionKey">,
): boolean {
  const { acpOwned, entry, provenanceKnown, sessionKey } = summary;
  if (
    !provenanceKnown ||
    acpOwned ||
    !sessionKey.trim() ||
    !entry.sessionId?.trim() ||
    entry.spawnedBy ||
    (entry.spawnDepth ?? 0) > 0 ||
    entry.pluginOwnerId ||
    entry.hookExternalContentSource ||
    isCronSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey)
  ) {
    return false;
  }
  const segments = sessionKey.toLowerCase().split(":");
  return !segments.some((segment) => HISTORY_SCAN_BLOCKED_SEGMENTS.has(segment));
}

export function compareSkillHistoryScanCandidates(
  left: Pick<SkillHistoryScanCandidate, "instanceId" | "updatedAtMs">,
  right: Pick<SkillHistoryScanCandidate, "instanceId" | "updatedAtMs">,
): number {
  const timestampOrder = right.updatedAtMs - left.updatedAtMs;
  if (timestampOrder !== 0) {
    return timestampOrder;
  }
  return left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0;
}

function candidateOlderThanCursor(
  candidate: SkillHistoryScanCandidate,
  cursor: SkillHistoryScanCursor,
): boolean {
  return compareSkillHistoryScanCandidates(candidate, cursor) > 0;
}

function candidateNewerThanCursor(
  candidate: SkillHistoryScanCandidate,
  cursor: SkillHistoryScanCursor,
): boolean {
  return compareSkillHistoryScanCandidates(candidate, cursor) < 0;
}

export function selectSkillHistoryScanCandidates(params: {
  candidates: readonly SkillHistoryScanCandidate[];
  direction: SkillHistoryScanDirection;
  oldestCursor?: SkillHistoryScanCursor;
  newestCursor?: SkillHistoryScanCursor;
}): SkillHistoryScanCandidate[] {
  if (params.direction === "newer") {
    return params.newestCursor
      ? params.candidates
          .filter((candidate) => candidateNewerThanCursor(candidate, params.newestCursor!))
          .toReversed()
      : [...params.candidates].toReversed();
  }
  return params.oldestCursor
    ? params.candidates.filter((candidate) =>
        candidateOlderThanCursor(candidate, params.oldestCursor!),
      )
    : [...params.candidates];
}

function listHistoryScanCandidates(params: SkillHistoryScanRunParams): SkillHistoryScanCandidate[] {
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  return listSessionTranscriptInstances({
    agentId: params.agentId,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
    ...(params.env ? { env: params.env } : {}),
  })
    .filter(isSkillHistoryScanSessionEligible)
    .map(({ entry, sessionId, sessionKey, updatedAtMs }) => ({
      entry,
      instanceId: sessionId,
      sessionKey,
      updatedAtMs,
    }))
    .toSorted(compareSkillHistoryScanCandidates);
}

function countModelIterations(messages: readonly unknown[]): number {
  return messages.reduce<number>((count, message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return count;
    }
    return count + ((message as { role?: unknown }).role === "assistant" ? 1 : 0);
  }, 0);
}

function capSessionTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) {
    return transcript;
  }
  const omission = "\n\n[older session content omitted]\n\n";
  if (maxChars <= omission.length) {
    return transcript.slice(0, maxChars);
  }
  const contentBudget = Math.max(0, maxChars - omission.length);
  const headLength = Math.min(2_000, Math.floor(contentBudget / 2));
  const head = transcript.slice(0, headLength);
  const tail = transcript.slice(-(contentBudget - headLength));
  return `${head}\n\n[older session content omitted]\n\n${tail}`;
}

export function hasLegacyHookTranscriptContent(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      (message as { role?: unknown }).role !== "user"
    ) {
      return false;
    }
    const rendered = formatSkillExperienceReviewTranscript([message]);
    return (
      (rendered.includes("<<<EXTERNAL_UNTRUSTED_CONTENT") &&
        /(?:^|\n)Source: (?:Email|Webhook)(?:\n|$)/.test(rendered)) ||
      /(?:^|\n)\[cron:[^\]\n]+\](?: |$)/.test(rendered)
    );
  });
}

export function resolveSkillHistoryScanTranscriptBudget(contextTokens?: number): number {
  const effectiveContextTokens =
    Number.isFinite(contextTokens) && (contextTokens ?? 0) > 0
      ? Math.floor(contextTokens as number)
      : HISTORY_SCAN_DEFAULT_CONTEXT_TOKENS;
  return Math.min(
    HISTORY_SCAN_MAX_TRANSCRIPT_CHARS,
    Math.max(256, Math.floor(effectiveContextTokens * 0.35)),
  );
}

export function formatSkillHistoryScanTranscript(
  messages: readonly unknown[],
  maxChars: number,
): string {
  // Redact the complete structure first. Truncating first can split a PEM or
  // other multiline secret so the remaining fragment no longer matches.
  return capSessionTranscript(
    // Provider-bound history uses mandatory built-in patterns. Operator log
    // redaction mode and custom pattern replacement cannot weaken this seam.
    redactSensitiveText(formatSkillExperienceReviewTranscript(messages), { mode: "tools" }),
    maxChars,
  );
}

function filterSkillHistoryScanReviewMessages(
  messages: readonly unknown[],
  heartbeatPrompt?: string,
): readonly unknown[] | undefined {
  if (hasLegacyHookTranscriptContent(messages)) {
    return undefined;
  }
  const roleMessages = messages.filter((message): message is { role: string; content?: unknown } =>
    Boolean(
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      typeof (message as { role?: unknown }).role === "string",
    ),
  );
  return filterHeartbeatTranscriptTurns(roleMessages, heartbeatPrompt);
}

export function selectSkillHistoryScanReviewMessages(
  messages: readonly unknown[],
  heartbeatPrompt?: string,
): readonly unknown[] | undefined {
  return prepareSkillHistoryScanReviewMessages(messages, heartbeatPrompt)?.messages;
}

export function prepareSkillHistoryScanReviewMessages(
  messages: readonly unknown[],
  heartbeatPrompt?: string,
): { messages: readonly unknown[]; modelIterations: number } | undefined {
  const filtered = filterSkillHistoryScanReviewMessages(messages, heartbeatPrompt);
  if (!filtered) {
    return undefined;
  }
  return {
    messages: filtered.slice(-HISTORY_SCAN_MAX_RECENT_MESSAGES),
    modelIterations: countModelIterations(filtered),
  };
}

export function isSkillHistoryScanLocalTranscriptSizeEligible(sizeBytes: number): boolean {
  return (
    Number.isFinite(sizeBytes) &&
    sizeBytes >= 0 &&
    sizeBytes <= HISTORY_SCAN_MAX_LOCAL_TRANSCRIPT_BYTES
  );
}

async function readHistoryScanSession(params: {
  agentId: string;
  candidate: SkillHistoryScanCandidate;
  heartbeatPrompt: string;
  maxTranscriptChars: number;
  storePath: string;
}): Promise<SkillHistoryScanPromptSession | undefined> {
  const transcriptScope = {
    agentId: params.agentId,
    sessionId: params.candidate.entry.sessionId,
    sessionKey: params.candidate.sessionKey,
    sessionEntry: params.candidate.entry,
    storePath: params.storePath,
  };
  // Legacy rows may predate explicit hook provenance. Inspect every local turn
  // before choosing a bounded provider-facing window so old hook payloads can
  // never age out of the exclusion check.
  if (
    !isSkillHistoryScanLocalTranscriptSizeEligible(
      readTranscriptStatsSync(transcriptScope).sizeBytes,
    )
  ) {
    return undefined;
  }
  const allMessages = await readSessionMessagesAsync(transcriptScope, {
    mode: "full",
    reason: "Skill Workshop legacy hook provenance check",
  });
  const review = prepareSkillHistoryScanReviewMessages(allMessages, params.heartbeatPrompt);
  if (!review || review.modelIterations < HISTORY_SCAN_MIN_MODEL_ITERATIONS) {
    return undefined;
  }
  const transcript = formatSkillHistoryScanTranscript(review.messages, params.maxTranscriptChars);
  if (!transcript.trim()) {
    return undefined;
  }
  return {
    instanceId: params.candidate.instanceId,
    sessionKey: params.candidate.sessionKey,
    updatedAt: new Date(params.candidate.updatedAtMs).toISOString(),
    modelIterations: review.modelIterations,
    transcript,
  };
}

export async function collectSkillHistoryScanBatch(params: {
  candidates: readonly SkillHistoryScanCandidate[];
  isSessionActive?: (candidate: SkillHistoryScanCandidate) => boolean;
  maxTranscriptChars?: number;
  readSession: (
    candidate: SkillHistoryScanCandidate,
  ) => Promise<SkillHistoryScanPromptSession | undefined>;
}): Promise<{
  blockedByActive: boolean;
  considered: SkillHistoryScanCandidate[];
  sessions: SkillHistoryScanPromptSession[];
}> {
  const considered: SkillHistoryScanCandidate[] = [];
  const sessions: SkillHistoryScanPromptSession[] = [];
  const maxTranscriptChars = params.maxTranscriptChars ?? HISTORY_SCAN_MAX_TRANSCRIPT_CHARS;
  let blockedByActive = false;
  let transcriptChars = 0;
  for (const candidate of params.candidates.slice(0, HISTORY_SCAN_MAX_CANDIDATES)) {
    if (params.isSessionActive?.(candidate)) {
      blockedByActive = true;
      break;
    }
    const session = await params.readSession(candidate);
    // An active run can claim the session while its transcript is being read.
    // Stop before advancing the cursor so a later scan sees a stable snapshot.
    if (params.isSessionActive?.(candidate)) {
      blockedByActive = true;
      break;
    }
    if (
      session &&
      sessions.length > 0 &&
      transcriptChars + session.transcript.length + HISTORY_SCAN_SESSION_OVERHEAD_CHARS >
        maxTranscriptChars
    ) {
      break;
    }
    considered.push(candidate);
    if (!session) {
      continue;
    }
    sessions.push(session);
    transcriptChars += session.transcript.length + HISTORY_SCAN_SESSION_OVERHEAD_CHARS;
    if (sessions.length >= HISTORY_SCAN_MAX_SESSIONS) {
      break;
    }
  }
  return { blockedByActive, considered, sessions };
}

export async function runSkillHistoryScanReview(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  modelRef?: { model: string; provider: string };
  onComplete?: (ideasFound: number) => Promise<void>;
  onProgress?: (progress: SkillWorkshopProposalReviewProgress) => Promise<void>;
  progress?: SkillWorkshopProposalReviewProgress;
  runId?: string;
  sessions: readonly SkillHistoryScanPromptSession[];
  workspaceDir: string;
}): Promise<number> {
  if (params.sessions.length === 0) {
    return 0;
  }
  const modelRef =
    params.modelRef ?? resolveDefaultModelForAgent({ cfg: params.config, agentId: params.agentId });
  const proposalMutationBudget = {
    remaining: params.progress?.remaining ?? HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS,
    completed: params.progress?.proposalIds.length ?? 0,
    successfulMutations: params.progress?.successfulMutations ?? 0,
    failedMutations: 0,
    mutatedProposalIds: new Set(params.progress?.proposalIds),
  };
  const proposalReviewCompletion = params.onComplete
    ? {
        completed: false,
        complete: async () => {
          const ideasFound = resolveSkillHistoryScanReviewOutcome({
            ideasFound: proposalMutationBudget.completed,
            proposalMutationBudgetRemaining: proposalMutationBudget.remaining,
            successfulMutations: proposalMutationBudget.successfulMutations,
            failedMutations: proposalMutationBudget.failedMutations,
          });
          await params.onComplete?.(ideasFound);
        },
        recordProgress: params.onProgress,
      }
    : undefined;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-history-scan-"));
  const runId = params.runId ?? `${HISTORY_SCAN_SESSION_SEGMENT}:${randomUUID()}`;
  let runError: unknown;
  try {
    const sessionId = randomUUID();
    const sessionKey = `agent:${params.agentId}:${HISTORY_SCAN_SESSION_SEGMENT}:${sessionId}`;
    const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
    const result = await runEmbeddedAgent({
      sessionId,
      sessionKey,
      sandboxSessionKey: sessionKey,
      sessionFile: path.join(tempDir, "session.jsonl"),
      agentId: params.agentId,
      trigger: "manual",
      lane: CommandLane.SkillWorkshopReview,
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      workspaceDir: params.workspaceDir,
      config: params.config,
      prompt: buildSkillHistoryScanPrompt({
        sessions: params.sessions,
        requireCompletion: proposalReviewCompletion !== undefined,
      }),
      provider: modelRef.provider,
      model: modelRef.model,
      // Keep the prompt budget tied to the selected model. A smaller configured
      // fallback must not receive a prompt sized for the primary model.
      modelFallbacksOverride: [],
      timeoutMs: HISTORY_SCAN_TIMEOUT_MS,
      runId,
      toolsAllow: ["skill_workshop"],
      disableMessageTool: true,
      disableTrajectory: true,
      skillWorkshopProposalOnly: true,
      skillWorkshopProposalEnv: params.env,
      skillWorkshopProposalMutationBudget: proposalMutationBudget,
      skillWorkshopProposalReviewCompletion: proposalReviewCompletion,
      skillWorkshopOrigin: { agentId: params.agentId, runId },
      cleanupBundleMcpOnRunEnd: true,
      bootstrapContextMode: "lightweight",
      skillsSnapshot: { prompt: "", skills: [] },
      verboseLevel: "off",
      reasoningLevel: "off",
      suppressToolErrorWarnings: true,
    });
    runError = resolveSkillHistoryScanRunFailure(result);
  } catch (error) {
    runError = error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  if (proposalReviewCompletion?.completed) {
    return proposalMutationBudget.completed;
  }
  return resolveSkillHistoryScanReviewOutcome({
    ideasFound: proposalMutationBudget.completed,
    proposalMutationBudgetRemaining: proposalMutationBudget.remaining,
    successfulMutations: proposalMutationBudget.successfulMutations,
    failedMutations: proposalMutationBudget.failedMutations,
    ...(runError === undefined ? {} : { runError }),
  });
}

export function resolveSkillHistoryScanRunFailure(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): Error | undefined {
  const errorPayload = result.payloads?.find((payload) => payload.isError);
  const message =
    result.meta.error?.message.trim() ||
    result.meta.failureSignal?.message.trim() ||
    (result.meta.aborted ? "Historical skill scan model run aborted." : undefined) ||
    errorPayload?.text?.trim();
  return message || errorPayload
    ? new Error(message || "Historical skill scan model run failed.")
    : undefined;
}

export function resolveSkillHistoryScanReviewOutcome(params: {
  failedMutations?: number;
  ideasFound: number;
  proposalMutationBudgetRemaining: number;
  successfulMutations: number;
  runError?: unknown;
}): number {
  if (params.runError !== undefined) {
    throw params.runError;
  }
  if ((params.failedMutations ?? 0) > 0) {
    throw new Error("Historical skill scan has failed proposal mutations to retry.");
  }
  const attemptedMutations =
    HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS - params.proposalMutationBudgetRemaining;
  if (params.successfulMutations > attemptedMutations) {
    throw new Error("Historical skill scan proposal accounting is inconsistent.");
  }
  return params.ideasFound;
}

export function resolveSkillHistoryScanHasMore(params: {
  direction: SkillHistoryScanDirection;
  oldestCursor?: SkillHistoryScanCursor;
  candidates: readonly SkillHistoryScanCandidate[];
}): boolean {
  // A cursorless newer scan follows an empty first scan. Its candidates are
  // new work, not evidence that an older page remains.
  if (params.direction === "newer" && !params.oldestCursor) {
    return false;
  }
  const oldestCursor = params.oldestCursor;
  return oldestCursor
    ? params.candidates.some((candidate) => candidateOlderThanCursor(candidate, oldestCursor))
    : params.candidates.length > 0;
}

export function reconcileSkillHistoryScanProgress(params: {
  durableMutationCount: number;
  durableProposalIds: readonly string[];
}): SkillWorkshopProposalReviewProgress {
  // Proposal records are the recovery authority. The checkpoint can include a
  // failed reservation or miss a write that landed immediately before a crash.
  const proposalIds = [...new Set(params.durableProposalIds)];
  const remaining = Math.max(0, HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS - params.durableMutationCount);
  return {
    proposalIds,
    remaining,
    successfulMutations: params.durableMutationCount,
  };
}

function finalizeUnreplayableSkillHistoryScan(
  previous: StoredSkillHistoryScanSnapshot,
  pending: NonNullable<StoredSkillHistoryScanState["pending"]>,
): StoredSkillHistoryScanSnapshot {
  // Durable proposals prove useful work completed. If the source rotated or
  // changed, finalize that partial batch instead of wedging every later scan.
  return withHistoryScanIdeas({
    next: pending.next,
    previous,
    ideasFound: pending.progress.proposalIds.length,
  });
}

function toStoredState(params: {
  previous: StoredSkillHistoryScanState | undefined;
  direction: SkillHistoryScanDirection;
  considered: readonly SkillHistoryScanCandidate[];
  sessions: readonly SkillHistoryScanPromptSession[];
  candidates: readonly SkillHistoryScanCandidate[];
  ideasFound: number;
  now: number;
}): StoredSkillHistoryScanState {
  const previous = params.previous;
  const reviewedTimes = params.sessions.map((session) => Date.parse(session.updatedAt));
  const previousOldest = previous?.oldestReviewedAt
    ? Date.parse(previous.oldestReviewedAt)
    : undefined;
  const previousNewest = previous?.newestReviewedAt
    ? Date.parse(previous.newestReviewedAt)
    : undefined;
  const oldestReviewedAtMs = Math.min(
    ...reviewedTimes,
    ...(Number.isFinite(previousOldest) ? [previousOldest as number] : []),
  );
  const newestReviewedAtMs = Math.max(
    ...reviewedTimes,
    ...(Number.isFinite(previousNewest) ? [previousNewest as number] : []),
  );
  const lastConsidered = params.considered.at(-1);
  const firstConsidered = params.considered.at(0);
  const oldestCursor =
    params.direction === "older" && lastConsidered
      ? { instanceId: lastConsidered.instanceId, updatedAtMs: lastConsidered.updatedAtMs }
      : previous?.oldestCursor;
  const newestCursor =
    params.direction === "newer" && lastConsidered
      ? { instanceId: lastConsidered.instanceId, updatedAtMs: lastConsidered.updatedAtMs }
      : (previous?.newestCursor ??
        (firstConsidered
          ? { instanceId: firstConsidered.instanceId, updatedAtMs: firstConsidered.updatedAtMs }
          : undefined));
  const hasMore = resolveSkillHistoryScanHasMore({
    direction: params.direction,
    ...(oldestCursor ? { oldestCursor } : {}),
    candidates: params.candidates,
  });
  return {
    schema: HISTORY_SCAN_SCHEMA,
    hasScanned: true,
    reviewedSessions: (previous?.reviewedSessions ?? 0) + params.sessions.length,
    ideasFound: (previous?.ideasFound ?? 0) + params.ideasFound,
    hasMore,
    lastScanReviewed: params.sessions.length,
    lastScanIdeas: params.ideasFound,
    lastScanAt: new Date(params.now).toISOString(),
    ...(Number.isFinite(oldestReviewedAtMs)
      ? { oldestReviewedAt: new Date(oldestReviewedAtMs).toISOString() }
      : {}),
    ...(Number.isFinite(newestReviewedAtMs)
      ? { newestReviewedAt: new Date(newestReviewedAtMs).toISOString() }
      : {}),
    ...(oldestCursor ? { oldestCursor } : {}),
    ...(newestCursor ? { newestCursor } : {}),
  };
}

async function runSkillHistoryScanCore(
  params: SkillHistoryScanRunParams,
): Promise<SkillHistoryScanResult> {
  const store = historyScanStore(params.env);
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  const stateKey = historyScanStateKey(params.agentId, params.workspaceDir, storePath);
  let stored = store.lookup(stateKey);
  if (stored === undefined) {
    store.registerIfAbsent(stateKey, emptyHistoryScanResult());
    stored = store.lookup(stateKey);
  }
  if (!isStoredHistoryScanState(stored)) {
    stored = emptyHistoryScanResult();
    store.register(stateKey, stored);
  }
  const previous = withoutPendingHistoryScan(stored);
  const direction: SkillHistoryScanDirection = params.direction ?? "older";
  let resumedPending: StoredSkillHistoryScanState["pending"];
  if (stored.pending) {
    if (stored.pending.completed) {
      const recovered = withHistoryScanIdeas({
        next: stored.pending.next,
        previous,
        ideasFound: stored.pending.completed.ideasFound,
      });
      store.register(stateKey, recovered);
      return recovered;
    }
    if (stored.pending.direction !== direction) {
      throw new Error(
        `An interrupted Skill Workshop history scan in the ${stored.pending.direction} direction must finish first.`,
      );
    }
    const durableProgress = await getSkillProposalRunProgress({
      runId: stored.pending.runId,
      workspaceDir: params.workspaceDir,
      ...(params.env ? { env: params.env } : {}),
    });
    resumedPending = {
      ...stored.pending,
      progress: reconcileSkillHistoryScanProgress({
        durableMutationCount: durableProgress.mutationCount,
        durableProposalIds: durableProgress.proposalIds,
      }),
    };
    store.register(stateKey, { ...previous, pending: resumedPending });
  }
  const candidates = listHistoryScanCandidates(params);
  let eligible = selectSkillHistoryScanCandidates({
    candidates,
    direction,
    ...(previous?.oldestCursor ? { oldestCursor: previous.oldestCursor } : {}),
    ...(previous?.newestCursor ? { newestCursor: previous.newestCursor } : {}),
  });
  if (resumedPending) {
    const candidatesById = new Map(
      candidates.map((candidate) => [candidate.instanceId, candidate] as const),
    );
    const resumedCandidates = resumedPending.sessionCursors.flatMap((cursor) => {
      const candidate = candidatesById.get(cursor.instanceId);
      return candidate?.updatedAtMs === cursor.updatedAtMs ? [candidate] : [];
    });
    if (resumedCandidates.length !== resumedPending.sessionCursors.length) {
      if (resumedPending.progress.proposalIds.length === 0) {
        store.register(stateKey, previous);
        return await runSkillHistoryScanCore(params);
      }
      const sourceStillActive = resumedPending.sessionCursors.some((cursor) => {
        const candidate = candidatesById.get(cursor.instanceId);
        return candidate ? isEmbeddedAgentRunActive(candidate.entry.sessionId) : false;
      });
      if (sourceStillActive) {
        throw new Error(
          "Interrupted Skill Workshop history scan source sessions are still active.",
        );
      }
      const recovered = finalizeUnreplayableSkillHistoryScan(previous, resumedPending);
      store.register(stateKey, recovered);
      return recovered;
    }
    eligible = resumedCandidates;
  }
  const modelRef = resolveDefaultModelForAgent({ cfg: params.config, agentId: params.agentId });
  const resolvedModel =
    eligible.length > 0
      ? resolveModel(
          modelRef.provider,
          modelRef.model,
          resolveAgentDir(params.config, params.agentId, params.env),
          params.config,
          { workspaceDir: params.workspaceDir },
        ).model
      : undefined;
  const contextTokens = resolvedModel
    ? Math.min(
        resolvedModel.contextTokens ?? resolvedModel.contextWindow,
        resolvedModel.contextWindow,
      )
    : undefined;
  const maxTranscriptChars = resolveSkillHistoryScanTranscriptBudget(contextTokens);
  const maxSessionTranscriptChars = Math.min(
    HISTORY_SCAN_MAX_SESSION_CHARS,
    Math.max(1, maxTranscriptChars - HISTORY_SCAN_SESSION_OVERHEAD_CHARS),
  );
  // Heartbeat turns durably use the stable transcript marker. The configured
  // prompt is only an extra legacy match and may change without hiding old turns.
  const heartbeatPrompt = resolveHeartbeatPrompt(
    resolveAgentConfig(params.config, params.agentId)?.heartbeat?.prompt ??
      params.config.agents?.defaults?.heartbeat?.prompt,
  );
  const batch = await collectSkillHistoryScanBatch({
    candidates: eligible,
    isSessionActive: (candidate) => isEmbeddedAgentRunActive(candidate.entry.sessionId),
    maxTranscriptChars,
    readSession: (candidate) =>
      readHistoryScanSession({
        agentId: params.agentId,
        candidate,
        heartbeatPrompt,
        maxTranscriptChars: maxSessionTranscriptChars,
        storePath,
      }),
  });
  if (
    resumedPending &&
    (batch.sessions.length !== resumedPending.sessionCursors.length ||
      batch.sessions.some(
        (session, index) => session.instanceId !== resumedPending.sessionCursors[index]?.instanceId,
      ))
  ) {
    if (resumedPending.progress.proposalIds.length === 0) {
      store.register(stateKey, previous);
      return await runSkillHistoryScanCore(params);
    }
    if (batch.blockedByActive) {
      throw new Error("Interrupted Skill Workshop history scan source sessions are still active.");
    }
    const recovered = finalizeUnreplayableSkillHistoryScan(previous, resumedPending);
    store.register(stateKey, recovered);
    return recovered;
  }
  const provisionalNext =
    resumedPending?.next ??
    toStoredState({
      previous,
      direction,
      considered: batch.considered,
      sessions: batch.sessions,
      candidates,
      ideasFound: 0,
      now: Date.now(),
    });
  if (batch.sessions.length === 0) {
    if (resumedPending) {
      throw new Error("Interrupted Skill Workshop history scan has no readable settled sessions.");
    }
    store.register(stateKey, provisionalNext);
    return provisionalNext;
  }

  const runId = resumedPending?.runId ?? `${HISTORY_SCAN_SESSION_SEGMENT}:${randomUUID()}`;
  const progress = resumedPending?.progress ?? {
    proposalIds: [],
    remaining: HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS,
    successfulMutations: 0,
  };
  // Write the in-progress checkpoint before any proposal can be persisted.
  // Only the review's explicit final tool call may mark the whole batch complete.
  store.register(stateKey, {
    ...previous,
    pending: {
      direction,
      runId,
      next: provisionalNext,
      progress,
      sessionCursors:
        resumedPending?.sessionCursors ??
        batch.sessions.map((session) => ({
          instanceId: session.instanceId,
          updatedAtMs: Date.parse(session.updatedAt),
        })),
    },
  });
  let reviewError: unknown;
  try {
    await runSkillHistoryScanReview({
      agentId: params.agentId,
      config: params.config,
      env: params.env,
      modelRef,
      progress,
      onProgress: async (nextProgress) => {
        const current = store.lookup(stateKey);
        if (
          !isStoredHistoryScanState(current) ||
          current.pending?.runId !== runId ||
          current.pending.completed
        ) {
          throw new Error("Historical skill scan progress checkpoint changed.");
        }
        store.register(stateKey, {
          ...previous,
          pending: {
            ...current.pending,
            progress: nextProgress,
          },
        });
      },
      onComplete: async (ideasFound) => {
        const current = store.lookup(stateKey);
        if (
          !isStoredHistoryScanState(current) ||
          current.pending?.runId !== runId ||
          current.pending.completed
        ) {
          throw new Error("Historical skill scan completion checkpoint changed.");
        }
        store.register(stateKey, {
          ...previous,
          pending: {
            ...current.pending,
            completed: { ideasFound },
          },
        });
      },
      runId,
      sessions: batch.sessions,
      workspaceDir: params.workspaceDir,
    });
  } catch (error) {
    reviewError = error;
  }
  const completedState = store.lookup(stateKey);
  if (
    isStoredHistoryScanState(completedState) &&
    completedState.pending?.runId === runId &&
    completedState.pending.completed
  ) {
    const next = withHistoryScanIdeas({
      next: completedState.pending.next,
      previous,
      ideasFound: completedState.pending.completed.ideasFound,
    });
    store.register(stateKey, next);
    return next;
  }
  // Leave the in-progress checkpoint intact. A retry reuses its run id,
  // durable proposal ids, and remaining mutation budget.
  throw reviewError ?? new Error("Historical skill scan did not confirm batch completion.");
}

export function runSkillHistoryScan(
  params: SkillHistoryScanRunParams,
): Promise<SkillHistoryScanResult> {
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  const key = historyScanStateKey(params.agentId, params.workspaceDir, storePath);
  const direction = params.direction ?? "older";
  const active = historyScansInFlight.get(key);
  if (active) {
    if (active.direction === direction) {
      return active.run;
    }
    return Promise.reject(
      new Error(`A Skill Workshop history scan in the ${active.direction} direction is running.`),
    );
  }
  const run = runSkillHistoryScanCore({ ...params, direction }).then(toPublicHistoryScanResult);
  const current = { direction, run };
  historyScansInFlight.set(key, current);
  void run
    .finally(() => {
      if (historyScansInFlight.get(key) === current) {
        historyScansInFlight.delete(key);
      }
    })
    .catch(() => undefined);
  return run;
}
