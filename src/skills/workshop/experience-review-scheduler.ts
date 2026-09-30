import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { EmbeddedForegroundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { getCanonicalSkillWorkspace } from "../../agents/skill-workshop-workspace-context.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { RunSkillUsage } from "../runtime/run-usage.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

/** Model iterations a session accumulates across turns before a review is due. */
const EXPERIENCE_REVIEW_ITERATION_THRESHOLD = 10;
const EXPERIENCE_REVIEW_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_RETRY_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_MAX_PENDING = 32;
const EXPERIENCE_REVIEW_MAX_COUNTERS = 1024;
const EXPERIENCE_REVIEW_BLOCKED_TRIGGERS = new Set(["cron", "heartbeat", "memory", "overflow"]);
const EXPERIENCE_REVIEW_BLOCKED_SESSION_SEGMENTS = new Set(["cron", "hook", "subagent"]);

const log = createSubsystemLogger("skills/workshop");

type ExperienceReviewAgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
};

type ExperienceReviewAgentContext = {
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  modelContextWindowTokens?: number;
  authProfileId?: string;
  modelIterations?: number;
  skillWorkshopAvailable?: boolean;
  compacted?: boolean;
  foregroundPromptContext: EmbeddedForegroundPromptContext;
};

export type SkillExperienceReviewParams = {
  event: ExperienceReviewAgentEndEvent;
  ctx: ExperienceReviewAgentContext;
  usedSkills?: readonly RunSkillUsage[];
  config: OpenClawConfig;
  source?: TranscriptEntryAnchor;
  /** The foreground turn itself changed a Workshop skill, so its learning is already saved. */
  workshopMutated?: boolean;
};

export type ExperienceReviewCandidate = {
  ctx: Pick<ExperienceReviewAgentContext, "runId" | "authProfileId" | "foregroundPromptContext"> & {
    workspaceDir: string;
    modelProviderId: string;
    modelId: string;
  };
  config: OpenClawConfig;
  source: TranscriptEntryAnchor;
  usedSkills?: readonly RunSkillUsage[];
  turnAborted?: boolean;
};

type ExperienceReviewTimer = ReturnType<typeof setTimeout>;

type ExperienceReviewSchedulerDeps = {
  isSystemActive: () => boolean | Promise<boolean>;
  runReview: (candidate: ExperienceReviewCandidate) => Promise<void>;
  setTimer?: (callback: () => void, delayMs: number) => ExperienceReviewTimer;
  clearTimer?: (timer: ExperienceReviewTimer) => void;
};

type PendingExperienceReview = {
  candidate: ExperienceReviewCandidate;
  generation: number;
  timer?: ExperienceReviewTimer;
};

function isEligibleContext(ctx: ExperienceReviewAgentContext): boolean {
  // Only harnesses that report both the resolved model and actual host-side
  // Workshop availability may schedule. Other runtimes fail closed here.
  if (ctx.skillWorkshopAvailable !== true || !ctx.modelProviderId?.trim() || !ctx.modelId?.trim()) {
    return false;
  }
  const trigger = ctx.foregroundPromptContext.trigger?.trim().toLowerCase();
  if (trigger && EXPERIENCE_REVIEW_BLOCKED_TRIGGERS.has(trigger)) {
    return false;
  }
  const sessionKey = ctx.sessionKey?.trim().toLowerCase();
  // Background Workshop runs use internal session-effects keys and must never review themselves.
  if (
    !sessionKey ||
    sessionKey.includes("active-memory") ||
    isInternalSessionEffectsKey(sessionKey)
  ) {
    return false;
  }
  return !sessionKey
    .split(":")
    .some((segment) => EXPERIENCE_REVIEW_BLOCKED_SESSION_SEGMENTS.has(segment));
}

/** Provider-reported iterations win; otherwise count assistant messages after the last user message. */
function resolveTurnModelIterations(params: SkillExperienceReviewParams): number {
  const reported = params.ctx.modelIterations;
  if (reported !== undefined) {
    return Number.isSafeInteger(reported) && reported >= 0 ? reported : 0;
  }
  const { messages } = params.event;
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user") {
      break;
    }
    if (isRecord(message) && message.role === "assistant") {
      count += 1;
    }
  }
  return count;
}

/** A learned skill the turn read or viewed; its outcome is fresh evidence for that skill. */
function usedWorkshopSkill(params: SkillExperienceReviewParams): boolean {
  if (!params.usedSkills?.length) {
    return false;
  }
  const root = canonicalizePath(
    resolveWorkshopSkillsDir(params.config, params.ctx.foregroundPromptContext.agentId),
  );
  return params.usedSkills.some((skill) => skill.skillFile?.startsWith(`${root}${path.sep}`));
}

/**
 * Counts model iterations per (agent, session) across turns and queues one background review
 * once a session has done enough work since its last review or its last own Workshop edit,
 * or right after a turn that used a learned skill. Reviews wait for a quiet period and run
 * one at a time.
 */
export function createSkillExperienceReviewScheduler(deps: ExperienceReviewSchedulerDeps) {
  const iterationsBySession = new Map<string, number>();
  const pendingBySession = new Map<string, PendingExperienceReview>();
  let reviewInFlight = false;
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? clearTimeout;

  const arm = (key: string, pending: PendingExperienceReview, delayMs: number) => {
    if (pending.timer) {
      clearTimer(pending.timer);
    }
    const generation = ++pending.generation;
    const timerCallback = () => {
      if (pendingBySession.get(key) !== pending || pending.generation !== generation) {
        return;
      }
      pending.timer = undefined;
      void (async () => {
        const active = await deps.isSystemActive();
        if (pendingBySession.get(key) !== pending || pending.generation !== generation) {
          return;
        }
        if (active || reviewInFlight) {
          arm(key, pending, EXPERIENCE_REVIEW_RETRY_IDLE_MS);
          return;
        }
        reviewInFlight = true;
        try {
          pendingBySession.delete(key);
          await deps.runReview(pending.candidate);
        } finally {
          reviewInFlight = false;
        }
      })().catch((error: unknown) => {
        log.warn(`skill experience review failed: ${formatErrorMessage(error)}`);
        if (pendingBySession.get(key) === pending && pending.generation === generation) {
          pendingBySession.delete(key);
        }
      });
    };
    // This timer outlives the foreground turn that armed it. Create its async
    // resource outside the parent scope so review work admits on the current generation.
    const timer = runOutsidePreparedModelRuntimePluginGenerationScope(() =>
      runOutsidePluginRuntimeGenerationScope(() => setTimer(timerCallback, delayMs)),
    );
    pending.timer = timer;
    timer.unref?.();
  };

  const cancel = (key: string) => {
    const pending = pendingBySession.get(key);
    if (pending?.timer) {
      clearTimer(pending.timer);
    }
    pendingBySession.delete(key);
    iterationsBySession.delete(key);
  };

  return {
    schedule(params: SkillExperienceReviewParams): void {
      const sessionKey = params.ctx.sessionKey?.trim();
      if (
        !sessionKey ||
        isIncognitoSessionKey(sessionKey) ||
        isIncognitoSessionKey(params.source?.sessionKey)
      ) {
        return;
      }
      // Unqualified keys such as global still belong to one foreground agent.
      const key = JSON.stringify([params.ctx.foregroundPromptContext.agentId, sessionKey]);
      const existing = pendingBySession.get(key);
      // Quiet time follows all later foreground work in the session.
      if (existing) {
        arm(key, existing, EXPERIENCE_REVIEW_IDLE_MS);
      }
      // Errored completions (provider/prompt failures) are environment noise, not
      // learnable evidence. User aborts carry no error and stay eligible.
      if (typeof params.event.error === "string" && params.event.error.trim() !== "") {
        log.debug(`experience review skipped: reason=errored-completion session=${sessionKey}`);
        return;
      }
      if (resolveSkillWorkshopConfig(params.config).autonomous.mode !== "auto") {
        cancel(key);
        return;
      }
      if (!isEligibleContext(params.ctx)) {
        log.debug(`experience review skipped: reason=ineligible-context session=${sessionKey}`);
        return;
      }
      // The foreground turn already saved its learning; an older queued review is stale.
      if (params.workshopMutated) {
        cancel(key);
        return;
      }
      const iterations = (iterationsBySession.get(key) ?? 0) + resolveTurnModelIterations(params);
      iterationsBySession.delete(key);
      if (iterations < EXPERIENCE_REVIEW_ITERATION_THRESHOLD && !usedWorkshopSkill(params)) {
        // Re-insert so the least recently active session is the one pruned.
        iterationsBySession.set(key, iterations);
        pruneMapToMaxSize(iterationsBySession, EXPERIENCE_REVIEW_MAX_COUNTERS);
        return;
      }
      const workspaceDir = getCanonicalSkillWorkspace() ?? params.ctx.workspaceDir?.trim();
      const modelProviderId = params.ctx.modelProviderId?.trim();
      const modelId = params.ctx.modelId?.trim();
      const { source } = params;
      if (!workspaceDir || !source || !modelProviderId || !modelId) {
        log.debug(`experience review skipped: reason=missing-context session=${sessionKey}`);
        return;
      }
      if (!existing && pendingBySession.size >= EXPERIENCE_REVIEW_MAX_PENDING) {
        const oldest = pendingBySession.entries().next().value;
        if (oldest) {
          if (oldest[1].timer) {
            clearTimer(oldest[1].timer);
          }
          pendingBySession.delete(oldest[0]);
        }
      }
      const candidate: ExperienceReviewCandidate = {
        ctx: {
          runId: params.ctx.runId,
          workspaceDir,
          modelProviderId,
          modelId,
          authProfileId: params.ctx.authProfileId,
          foregroundPromptContext: params.ctx.foregroundPromptContext,
        },
        config: params.config,
        source: { ...source },
        usedSkills: params.usedSkills ? [...params.usedSkills] : undefined,
        turnAborted: !params.event.success,
      };
      const pending = existing ?? { candidate, generation: 0 };
      pending.candidate = candidate;
      pendingBySession.set(key, pending);
      arm(key, pending, EXPERIENCE_REVIEW_IDLE_MS);
      log.debug(`experience review scheduled: session=${sessionKey} iterations=${iterations}`);
    },
    clear(): void {
      for (const pending of pendingBySession.values()) {
        if (pending.timer) {
          clearTimer(pending.timer);
        }
      }
      pendingBySession.clear();
      iterationsBySession.clear();
    },
  };
}
