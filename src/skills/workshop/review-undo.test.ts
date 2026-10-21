import { beforeEach, expect, it, vi } from "vitest";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import type { WorkshopChange } from "./changes.kernel.js";
import type { WorkshopMutationContext } from "./library.js";
import {
  undoWorkshopReview,
  WorkshopReviewNotFoundError as NotFound,
  workshopReviewRunId,
} from "./review-undo.js";

type ChangeInput = Pick<WorkshopChange, "skillName" | "action"> & Partial<WorkshopChange>;
const { feed, record, library, enqueueSystemEvent } = vi.hoisted(() => {
  const changes: WorkshopChange[] = [];
  function append(ctx: WorkshopMutationContext, change: ChangeInput): WorkshopChange {
    const row: WorkshopChange = {
      id: `c${changes.length + 1}`,
      agentId: ctx.agentId,
      actor: ctx.actor,
      summary: change.action,
      createdAtMs: changes.length + 1,
      ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...change,
    };
    changes.push(row);
    return row;
  }
  const mutate =
    (action: "restore" | "archive") =>
    async (ctx: WorkshopMutationContext, { name }: { name: string }) =>
      append(ctx, { skillName: name, action });
  return {
    feed: changes,
    record: append,
    enqueueSystemEvent: vi.fn(() => true),
    library: {
      listWorkshopChanges: vi.fn(
        async (id: string, { runId, limit }: { runId?: string; limit: number }) =>
          changes
            .filter((row) => row.agentId === id && (runId === undefined || row.runId === runId))
            .toReversed()
            .slice(0, limit),
      ),
      listWorkshopArchive: vi.fn(async () => [
        { name: "deploy", versions: [{ id: "v-before-review" }, { id: "v-after-first-patch" }] },
      ]),
      listWorkshopSkills: vi.fn(async () =>
        [...new Map(changes.map(({ skillName, action }) => [skillName, action]))]
          .filter(([, action]) => action !== "archive")
          .map(([name]) => ({ name })),
      ),
      restoreWorkshopSkill: vi.fn(mutate("restore")),
      archiveWorkshopSkill: vi.fn(mutate("archive")),
    },
  };
});
vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent,
}));
vi.mock("./library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library.js")>()),
  ...library,
}));

const REVIEW_RUN_ID = workshopReviewRunId("review");
const REVIEWED_SESSION = "agent:main:telegram:direct:42";
const user: WorkshopMutationContext = { config: {}, agentId: "main", actor: "user" };
const undo = (runId = REVIEW_RUN_ID) => undoWorkshopReview(user, { runId });
function expectNotice(text: string) {
  expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(text), {
    sessionKey: resolveSystemEventQueueKey(REVIEWED_SESSION, "main"),
  });
}
async function expectRefusal(error: Error | RegExp, runId = REVIEW_RUN_ID) {
  await expect(undo(runId)).rejects.toThrow(error);
  expect(library.restoreWorkshopSkill).not.toHaveBeenCalled();
  expect(library.archiveWorkshopSkill).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  feed.length = 0;
  const review = { ...user, actor: "review" as const, sessionKey: REVIEWED_SESSION };
  const ctx = { ...review, runId: REVIEW_RUN_ID };
  record(ctx, { skillName: "deploy", action: "patch", versionId: "v-before-review" });
  record(ctx, { skillName: "release", action: "create" });
  record(ctx, { skillName: "deploy", action: "patch", versionId: "v-after-first-patch" });
});

it("restores edited skills, archives created ones, and tells the reviewed session", async () => {
  const result = await undo();
  const undoCtx = { ...user, runId: "skill-workshop-undo:review" };
  expect(library.restoreWorkshopSkill).toHaveBeenCalledExactlyOnceWith(undoCtx, {
    name: "deploy",
    versionId: "v-before-review",
    summary: "undid background review",
  });
  expect(library.archiveWorkshopSkill).toHaveBeenCalledExactlyOnceWith(undoCtx, {
    name: "release",
    reason: "undo",
  });
  expect(result).toMatchObject({
    status: "undone",
    changes: [
      { skillName: "deploy", action: "restore", actor: "user" },
      { skillName: "release", action: "archive", actor: "user" },
    ],
  });
  expectNotice("do not revert it again");
});
it("lets a concurrent second press find the review already undone", async () => {
  const [first, second] = await Promise.all([undo(), undo()]);
  expect([first.status, second.status]).toEqual(["undone", "already-undone"]);
  expect(library.archiveWorkshopSkill).toHaveBeenCalledTimes(1);
});
it("refuses a review id with no recorded changes", async () => {
  const runId = workshopReviewRunId("missing");
  await expectRefusal(new NotFound(`No skill changes recorded for review ${runId}.`), runId);
  await expect(undo("foreground-run")).rejects.toBeInstanceOf(NotFound);
  expect(library.restoreWorkshopSkill).not.toHaveBeenCalled();
});
it("refuses a review whose first changes were pruned from the full feed", async () => {
  feed.splice(1, 1);
  while (feed.length < 500) {
    record({ ...user, runId: "later" }, { skillName: `other-${feed.length}`, action: "patch" });
  }
  await expectRefusal(/too old to undo in one step/);
});
it("refuses before any write when a saved version is no longer kept", async () => {
  library.listWorkshopArchive.mockResolvedValueOnce([]);
  await expectRefusal(/version of "deploy" saved before it is no longer kept/);
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
});
it("reports and announces the reverts that committed before a later one failed", async () => {
  library.archiveWorkshopSkill.mockRejectedValueOnce(new Error("Learning is off."));
  await expect(undo()).rejects.toThrow("Partly undone (restored `deploy`); Learning is off.");
  expectNotice("restored `deploy`");
});
