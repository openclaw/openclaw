import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  createSkillExperienceReviewScheduler,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";

const log = createSubsystemLogger("skills/workshop");
const UNUSED_ARCHIVE_INTERVAL_MS = 24 * 60 * 60_000;
const lastUnusedArchiveByAgent = new Map<string, number>();

const defaultScheduler = createSkillExperienceReviewScheduler({
  isSystemActive: async () => {
    const { getActiveEmbeddedRunCount } =
      await import("../../agents/embedded-agent-runner/active-run-projections.js");
    return getActiveEmbeddedRunCount() > 0;
  },
  runReview: async (candidate) => {
    const { getRuntimeConfig } = await import("../../config/config.js");
    const { prepareSkillExperienceReviewCandidate, runSkillExperienceReview } =
      await import("./experience-review.js");
    const prepared = await prepareSkillExperienceReviewCandidate(candidate, getRuntimeConfig());
    if (prepared) {
      await runSkillExperienceReview(prepared);
    }
  },
});

/** Counts the finished turn toward a background review; never affects the turn's result. */
export function scheduleSkillExperienceReview(
  params: Omit<SkillExperienceReviewParams, "workshopMutated">,
): void {
  const runId = params.ctx.runId?.trim();
  if (resolveSkillWorkshopConfig(params.config).autonomous.mode !== "auto" || !runId) {
    defaultScheduler.schedule(params);
    return;
  }
  // The change feed records the run that made each edit; a foreground turn that saved
  // its own learning resets the session's review counter.
  void import("./library.js")
    .then(({ listWorkshopChanges }) =>
      listWorkshopChanges(params.ctx.foregroundPromptContext.agentId, { runId, limit: 1 }),
    )
    .then((changes) =>
      defaultScheduler.schedule({ ...params, workshopMutated: changes.length > 0 }),
    )
    .catch((error: unknown) => {
      log.warn(`skill experience review scheduling failed: ${formatErrorMessage(error)}`);
    });
}

/**
 * Archives an agent's long-unused learned skills, at most once a day per agent. Runs detached
 * from the finished turn and never affects its result; no scheduler owns this work.
 */
export function scheduleUnusedWorkshopSkillArchive(config: OpenClawConfig, agentId: string): void {
  if (resolveSkillWorkshopConfig(config).autonomous.mode !== "auto") {
    return;
  }
  const nowMs = Date.now();
  const lastMs = lastUnusedArchiveByAgent.get(agentId);
  if (lastMs !== undefined && nowMs - lastMs < UNUSED_ARCHIVE_INTERVAL_MS) {
    return;
  }
  lastUnusedArchiveByAgent.set(agentId, nowMs);
  void runWithGatewayDetachedWorkContinuation(async () => {
    // The archive pass loads the library and runtime policy; most turns never need them.
    const { archiveUnusedWorkshopSkills } = await import("./unused-archive.js");
    const archived = await archiveUnusedWorkshopSkills(config, agentId, nowMs);
    if (archived.length > 0) {
      log.info(
        `archived ${archived.length} unused learned skill(s) for ${agentId}: ${archived.map((change) => change.skillName).join(", ")}`,
      );
    }
  }, "skills:workshop-unused-archive").catch((error: unknown) => {
    log.warn(`unused skill archive failed: ${formatErrorMessage(error)}`);
  });
}
