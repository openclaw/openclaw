import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { WorkshopChange } from "./changes.kernel.js";
import {
  archiveWorkshopSkill,
  listWorkshopArchive,
  listWorkshopChanges,
  listWorkshopSkills,
  restoreWorkshopSkill,
  WorkshopWriteError,
  type WorkshopMutationContext,
} from "./library.js";

const REVIEW_RUN_PREFIX = "skill-workshop-review:";
const UNDO_RUN_PREFIX = "skill-workshop-undo:";
// The change feed retains at most this many rows per agent, so one page holds a whole run.
const MAX_RUN_CHANGES = 500;

/** Run id of one background review; `reviewId` is the id `/learn undo` takes. */
export function workshopReviewRunId(reviewId: string): string {
  return `${REVIEW_RUN_PREFIX}${reviewId}`;
}

export function workshopReviewIdOf(runId: string): string | undefined {
  return runId.startsWith(REVIEW_RUN_PREFIX) && runId.length > REVIEW_RUN_PREFIX.length
    ? runId.slice(REVIEW_RUN_PREFIX.length)
    : undefined;
}

/** The review id names no recorded change; callers word this differently from other refusals. */
export class WorkshopReviewNotFoundError extends WorkshopWriteError {
  override name = "WorkshopReviewNotFoundError";
}

export type WorkshopReviewUndoResult = {
  status: "undone" | "already-undone";
  /** Revert changes made by this call; empty when an earlier undo already reverted the review. */
  changes: WorkshopChange[];
};

/** "restored `a`; archived `b`" for the revert changes of one undo. */
export function describeWorkshopReviewUndo(changes: readonly WorkshopChange[]): string {
  return changes
    .map(
      (change) =>
        `${change.action === "archive" ? "archived" : "restored"} \`${change.skillName}\``,
    )
    .join("; ");
}

function notifyReviewedSession(
  ctx: WorkshopMutationContext,
  reviewChanges: readonly WorkshopChange[],
  reviewId: string,
  reverted: readonly WorkshopChange[],
) {
  const sessionKey = reviewChanges.find((change) => change.sessionKey)?.sessionKey;
  if (!sessionKey || reverted.length === 0) {
    return;
  }
  // The review's notice event told the agent how to revert; without this it would do it again.
  enqueueSystemEvent(
    `The user already undid background skill review ${reviewId} from its notice (${describeWorkshopReviewUndo(reverted)}). That skill change is reverted; do not revert it again if asked to undo it.`,
    { sessionKey: resolveSystemEventQueueKey(sessionKey, ctx.agentId) },
  );
}

async function revertReview(
  ctx: WorkshopMutationContext,
  runId: string,
  reviewId: string,
): Promise<WorkshopReviewUndoResult> {
  // Newest first; reversed, the first entry per skill is the review's first change of it.
  const reviewChanges = (
    await listWorkshopChanges(ctx.agentId, { runId, limit: MAX_RUN_CHANGES })
  ).toReversed();
  const reviewStart = reviewChanges[0];
  if (!reviewStart) {
    throw new WorkshopReviewNotFoundError(`No skill changes recorded for review ${runId}.`);
  }
  // The feed drops its oldest rows past the cap. If it is full and nothing older than this
  // review's first retained row is left, the review's first changes may be gone, and their
  // revert anchors with them; refuse rather than restore the wrong version.
  const feed = await listWorkshopChanges(ctx.agentId, { limit: MAX_RUN_CHANGES });
  const oldestRetained = feed.at(-1);
  if (
    feed.length >= MAX_RUN_CHANGES &&
    oldestRetained &&
    oldestRetained.createdAtMs >= reviewStart.createdAtMs
  ) {
    throw new WorkshopWriteError(
      `Review ${reviewId} is too old to undo in one step: part of its history was pruned. Restore its skills one by one in the Skill Workshop.`,
    );
  }
  const undoRunId = `${UNDO_RUN_PREFIX}${reviewId}`;
  const undone = new Set(
    (await listWorkshopChanges(ctx.agentId, { runId: undoRunId, limit: MAX_RUN_CHANGES })).map(
      (change) => change.skillName,
    ),
  );
  const firstBySkill = new Map<string, WorkshopChange>();
  for (const change of reviewChanges) {
    if (!firstBySkill.has(change.skillName)) {
      firstBySkill.set(change.skillName, change);
    }
  }
  // A created skill that is no longer live was already reverted, e.g. by the agent after a chat "undo".
  const live = new Set(
    (await listWorkshopSkills(ctx.config, ctx.agentId)).map((skill) => skill.name),
  );
  const targets = [...firstBySkill.values()].filter(
    ({ skillName, versionId }) => !undone.has(skillName) && (versionId || live.has(skillName)),
  );
  // Check every saved version before the first write, so a pruned one refuses the whole undo.
  const retained = new Map(
    (await listWorkshopArchive(ctx.config, ctx.agentId)).map((skill) => [
      skill.name,
      new Set(skill.versions.map((version) => version.id)),
    ]),
  );
  const pruned = targets.find(
    ({ skillName, versionId }) => versionId && !retained.get(skillName)?.has(versionId),
  );
  if (pruned) {
    throw new WorkshopWriteError(
      `Cannot undo review ${reviewId}: the version of "${pruned.skillName}" saved before it is no longer kept. Restore that skill from the Skill Workshop.`,
    );
  }
  const undoCtx = { ...ctx, runId: undoRunId };
  const changes: WorkshopChange[] = [];
  try {
    for (const { skillName: name, versionId } of targets) {
      // No saved version before the review's first change means the review created the skill.
      changes.push(
        versionId
          ? await restoreWorkshopSkill(undoCtx, {
              name,
              versionId,
              summary: "undid background review",
            })
          : await archiveWorkshopSkill(undoCtx, { name, reason: "undo" }),
      );
    }
  } catch (error) {
    if (changes.length === 0) {
      throw error;
    }
    // Reverts already committed stay; report them and tell the agent, then surface the refusal.
    notifyReviewedSession(ctx, reviewChanges, reviewId, changes);
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkshopWriteError(
      `Partly undone (${describeWorkshopReviewUndo(changes)}); ${reason}`,
      { cause: error },
    );
  }
  if (changes.length === 0) {
    return { status: "already-undone", changes };
  }
  notifyReviewedSession(ctx, reviewChanges, reviewId, changes);
  return { status: "undone", changes };
}

const inFlight = new Map<string, Promise<WorkshopReviewUndoResult>>();

/**
 * Reverts every skill one background review changed: restores the version saved before the
 * review's first change of it, or archives a skill the review created. Reverts are recorded
 * under the review's undo run id, so a repeated undo skips skills already reverted.
 */
export async function undoWorkshopReview(
  ctx: WorkshopMutationContext,
  params: { runId: string },
): Promise<WorkshopReviewUndoResult> {
  const reviewId = workshopReviewIdOf(params.runId);
  if (!reviewId) {
    throw new WorkshopReviewNotFoundError(`No skill changes recorded for review ${params.runId}.`);
  }
  // A double-pressed Undo waits for the first press, then finds the review already undone.
  const key = `${ctx.agentId}\0${reviewId}`;
  const previous = inFlight.get(key);
  const run = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => revertReview(ctx, params.runId, reviewId));
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === run) {
      inFlight.delete(key);
    }
  }
}
