import { randomUUID } from "node:crypto";
import {
  prepareSessionFork,
  readSessionForkTurn,
  runSessionFork,
} from "../../agents/session-fork-run.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { buildSkillExperienceReviewPrompt } from "./experience-review-prompt.js";
import type { ExperienceReviewCandidate } from "./experience-review-scheduler.js";
import { listWorkshopChanges } from "./library.js";
import { postWorkshopChangeNotice } from "./review-outcome.js";
import { workshopReviewRunId } from "./review-undo.js";

const REVIEW_TOOLS = ["skill_workshop"] as const;
const REVIEW_OWNER = "core:skill-workshop";

/** Admits a queued review only when Workshop is on and the session's policy exposes the tool. */
export async function prepareSkillExperienceReviewCandidate(
  candidate: ExperienceReviewCandidate,
  config: OpenClawConfig,
): Promise<ExperienceReviewCandidate | undefined> {
  if (
    isIncognitoSessionKey(candidate.source.sessionKey) ||
    resolveSkillWorkshopConfig(config).autonomous.mode === "off"
  ) {
    return undefined;
  }
  // The same host-owned turn facts a plugin fork uses: the anchored turn's requester and model.
  const turn = await readSessionForkTurn(candidate.source);
  if (!turn) {
    // Without the turn's own requester, sender-specific policy cannot be checked.
    return undefined;
  }
  const model = turn.model ?? {
    provider: candidate.ctx.modelProviderId,
    model: candidate.ctx.modelId,
  };
  const fork = await prepareSessionFork({
    config,
    source: candidate.source,
    tools: REVIEW_TOOLS,
    model,
    workspaceDir: candidate.ctx.workspaceDir,
    ...(turn.requester ? { requester: turn.requester } : {}),
  });
  if (!fork) {
    return undefined;
  }
  return {
    ...candidate,
    ctx: {
      ...candidate.ctx,
      workspaceDir: fork.workspaceDir,
      modelProviderId: model.provider,
      modelId: model.model,
    },
    ...(turn.requester ? { requester: turn.requester } : {}),
    config,
  };
}

export async function runSkillExperienceReview(
  candidate: ExperienceReviewCandidate,
  options: { abortSignal?: AbortSignal } = {},
): Promise<void> {
  const { config, source } = candidate;
  const { agentId } = source;
  const runId = workshopReviewRunId(randomUUID());
  // A Gateway reset keeps the sessionId and rotates the lifecycle revision; the notice is
  // posted only to the generation the review read.
  let generation: Parameters<typeof postWorkshopChangeNotice>[0]["generation"] | undefined;
  // Settlement runs inside the fork's detached admission, so a graceful restart waits for the
  // notice of skills the review already committed.
  await runSessionFork(
    {
      config,
      source,
      prompt: buildSkillExperienceReviewPrompt({
        ...candidate,
        propose: resolveSkillWorkshopConfig(config).autonomous.mode === "propose",
      }),
      tools: REVIEW_TOOLS,
      runId,
      owner: REVIEW_OWNER,
      model: {
        provider: candidate.ctx.modelProviderId,
        model: candidate.ctx.modelId,
        ...(candidate.ctx.authProfileId ? { authProfileId: candidate.ctx.authProfileId } : {}),
      },
      workspaceDir: candidate.ctx.workspaceDir,
      ...(candidate.requester ? { requester: candidate.requester } : {}),
      timeoutMs: resolveAgentTimeoutMs({ cfg: config }),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      assertCallerCurrent: () => {
        if (resolveSkillWorkshopConfig(getRuntimeConfig()).autonomous.mode === "off") {
          throw new Error("Skill Workshop was turned off during review.");
        }
      },
      onSourceAdmitted: (entry) => {
        generation = {
          agentId,
          storePath: source.storePath,
          sessionKey: source.sessionKey,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision ?? null,
        };
      },
    },
    async (outcome) => {
      const reviewFailure: unknown = outcome.ok ? undefined : outcome.error;
      // Each skill_workshop call commits on its own, so a failed or aborted run may have changed
      // skills. Cleanup always runs after the stop, and its independent failure must stay visible
      // to the scheduler instead of being classified as part of the cancellation.
      let cleanupFailure: unknown;
      try {
        const changes = await listWorkshopChanges(agentId, { runId });
        if (generation) {
          await postWorkshopChangeNotice({ config, generation, runId, changes });
        }
      } catch (error) {
        cleanupFailure = error;
      }
      if (cleanupFailure !== undefined) {
        // Cleanup failure identity survives even when the model succeeded. Do not throw it bare:
        // an aborted controller would classify a plain error as expected cancellation.
        throw reviewFailure === undefined
          ? new AggregateError([cleanupFailure], "Skill experience review cleanup failed")
          : new AggregateError(
              [reviewFailure, cleanupFailure],
              "Skill experience review and its cleanup failed",
            );
      }
      if (!outcome.ok) {
        if (options.abortSignal?.aborted || getGatewayRestartDrainSignal().aborted) {
          // The model aborts with a plain error; normalize the outcome so the scheduler reports
          // an expected cancellation rather than a review failure.
          throw Object.assign(new Error("Skill experience review was stopped by the user."), {
            name: "AbortError",
          });
        }
        throw outcome.error instanceof Error
          ? outcome.error
          : new Error(formatErrorMessage(outcome.error));
      }
    },
  );
}
