import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayDetachedWorkContinuation,
} from "../../process/gateway-work-admission.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  createSkillExperienceReviewScheduler,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";

const log = createSubsystemLogger("skills/workshop");
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60_000;
const lastMaintenanceByAgent = new Map<string, number>();

const defaultScheduler = createSkillExperienceReviewScheduler({
  isSystemActive: async () => {
    const { getActiveSessionRunCount } =
      await import("../../sessions/session-controller.queries.js");
    return getActiveSessionRunCount() > 0;
  },
  runReview: async (candidate, signal) => {
    const { getRuntimeConfig } = await import("../../config/config.js");
    const { prepareSkillExperienceReviewCandidate, runSkillExperienceReview } =
      await import("./experience-review.js");
    const prepared = await prepareSkillExperienceReviewCandidate(candidate, getRuntimeConfig());
    if (prepared) {
      await runSkillExperienceReview(prepared, { abortSignal: signal });
    }
  },
});

/** Counts the finished turn toward a background review; never affects the turn's result. */
export function scheduleSkillExperienceReview(
  params: Omit<SkillExperienceReviewParams, "workshopMutated">,
): void {
  const runId = params.ctx.runId?.trim();
  if (resolveSkillWorkshopConfig(params.config).autonomous.mode === "off" || !runId) {
    defaultScheduler.schedule(params);
    return;
  }
  // The change feed records the run that made each edit; a foreground turn that saved
  // its own learning resets the session's review counter.
  void import("./library.js")
    .then(({ listWorkshopChanges }) => listWorkshopChanges(params.ctx.agentId, { runId, limit: 1 }))
    .then((changes) =>
      defaultScheduler.schedule({ ...params, workshopMutated: changes.length > 0 }),
    )
    .catch((error: unknown) => {
      log.warn(`skill experience review scheduling failed: ${formatErrorMessage(error)}`);
    });
}

/**
 * Explicit Stop bridge: drops every stopped session's queued review, aborts its in-flight
 * review, and suppresses the stopped runs until their own aborted completions arrive.
 * Best-effort so review bookkeeping never fails Stop; callers apply it only after the Stop's
 * live authority is confirmed, so a rejected Stop leaves review state untouched.
 */
export function stopSkillExperienceReview(params: {
  sessions: readonly { agentId?: string; sessionKey?: string }[];
  runIds: Iterable<string>;
}): void {
  for (const session of params.sessions) {
    if (!session.agentId || !session.sessionKey) {
      continue;
    }
    try {
      defaultScheduler.cancelSession({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
      });
    } catch (error) {
      log.warn(`skill experience review cancellation failed: ${formatErrorMessage(error)}`);
    }
  }
  try {
    defaultScheduler.suppressRuns(params.runIds);
  } catch (error) {
    log.warn(`skill experience review suppression failed: ${formatErrorMessage(error)}`);
  }
}

/**
 * Daily Workshop maintenance in auto mode, at most once a day per agent: archive long-unused
 * learned skills, then diet one oversized skill. An agent whose tool policy denies
 * skill_workshop opted out and gets no maintenance. Runs detached from the finished turn and
 * never affects its result; no scheduler owns this work.
 */
export function scheduleDailyWorkshopMaintenance(config: OpenClawConfig, agentId: string): void {
  if (resolveSkillWorkshopConfig(config).autonomous.mode !== "auto") {
    return;
  }
  const nowMs = Date.now();
  const lastMs = lastMaintenanceByAgent.get(agentId);
  if (lastMs !== undefined && nowMs - lastMs < MAINTENANCE_INTERVAL_MS) {
    return;
  }
  lastMaintenanceByAgent.set(agentId, nowMs);
  void runWithGatewayDetachedWorkContinuation(async () => {
    // Maintenance loads the library and runtime policy; most turns never need them.
    const { isSkillWorkshopDeniedForAgent } = await import("./tool-policy-diagnostic.js");
    if (isSkillWorkshopDeniedForAgent(config, agentId)) {
      return;
    }
    const { archiveUnusedWorkshopSkills } = await import("./unused-archive.js");
    const archived = await archiveUnusedWorkshopSkills(config, agentId, nowMs).catch(
      (error: unknown) => {
        log.warn(`unused skill archive failed: ${formatErrorMessage(error)}`);
        return [];
      },
    );
    if (archived.length > 0) {
      log.info(
        `archived ${archived.length} unused learned skill(s) for ${agentId}: ${archived.map((change) => change.skillName).join(", ")}`,
      );
    }
    const { runWorkshopSkillDiet } = await import("./skill-diet.js");
    const dieted = await runWorkshopSkillDiet({
      config,
      agentId,
      nowMs,
      abortSignal: getGatewayRestartDrainSignal(),
    });
    if (dieted) {
      log.info(`dieted learned skill ${dieted.skillName} for ${agentId}: ${dieted.summary}`);
    }
  }, "skills:workshop-maintenance").catch((error: unknown) => {
    log.warn(`workshop maintenance failed: ${formatErrorMessage(error)}`);
  });
}
