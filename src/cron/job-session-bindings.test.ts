import { expect, test, vi } from "vitest";
import {
  disableCronJobsBoundToSessions,
  resolveCronJobBoundSessionKeys,
} from "./job-session-bindings.js";
import type { CronJob, CronStoredJob } from "./types.js";

test.each([
  [
    "wake/delivery lanes",
    "main",
    "discord:channel:123",
    "main",
    ["agent:main:main", "agent:main:discord:channel:123"],
  ],
  [
    "scoped ownership over default",
    "isolated",
    "agent:ops:main",
    "research",
    ["agent:ops:cron:job1", "agent:ops:main"],
  ],
  ["malformed target", "session: ", undefined, "main", []],
] as const)(
  "resolves job session bindings: %s",
  (_name, sessionTarget, sessionKey, defaultAgentId, expected) => {
    expect(
      resolveCronJobBoundSessionKeys(
        { id: "job1", sessionTarget, sessionKey },
        { cfg: {}, defaultAgentId },
      ),
    ).toEqual(new Set(expected));
  },
);

function job(partial: Partial<CronStoredJob> & Pick<CronJob, "id">): CronStoredJob {
  return { enabled: true, sessionTarget: "isolated", ...partial } as CronJob;
}

function fakeUpdateWithPrecondition(currentJobs: () => CronJob[]) {
  return vi.fn(
    async (
      id: string,
      _patch: unknown,
      precondition: (job: CronJob, nowMs: number) => void | Promise<void>,
    ) => {
      const current = currentJobs().find((candidate) => candidate.id === id);
      if (!current) {
        throw new Error(`cron job not found: ${id}`);
      }
      await precondition(current, 0);
      return current;
    },
  );
}

async function disable(
  jobs: CronStoredJob[],
  updateWithPrecondition: ReturnType<typeof fakeUpdateWithPrecondition>,
  defaultAgentId: string | null = "main",
) {
  const sessionKey = "agent:main:cron:bound";
  const disabled = await disableCronJobsBoundToSessions({
    cron: {
      list: async () => jobs,
      updateWithPrecondition,
      getDefaultAgentId: () => defaultAgentId ?? undefined,
    },
    cfg: {},
    sessionKeys: [sessionKey],
  });
  return disabled.get(sessionKey) ?? [];
}

test("disables only enabled jobs bound to the archived session", async () => {
  const jobs = [
    job({ id: "bound" }),
    job({
      id: "created-here",
      sourceConversation: { sessionKey: "agent:main:cron:bound", sessionId: "creator" },
    }),
    job({ id: "other", sessionTarget: "session:agent:main:other" }),
    job({ id: "already-off", enabled: false, sessionKey: "cron:bound" }),
  ];
  const update = fakeUpdateWithPrecondition(() => jobs);
  expect(await disable(jobs, update)).toEqual(["bound", "created-here"]);
  expect(update).toHaveBeenCalledTimes(2);
  expect(update.mock.calls[0]?.slice(0, 2)).toEqual(["bound", { enabled: false }]);
});

test("leaves ownerless jobs unchanged when no canonical default is configured", async () => {
  const jobs = [job({ id: "bound" })];
  const update = fakeUpdateWithPrecondition(() => jobs);
  expect(await disable(jobs, update, null)).toEqual([]);
  expect(update).not.toHaveBeenCalled();
});

test("skips jobs retargeted between the list snapshot and the locked update", async () => {
  const listed = [job({ id: "bound" })];
  const update = fakeUpdateWithPrecondition(() => [
    job({ id: "bound", sessionTarget: "session:agent:main:elsewhere" }),
  ]);
  expect(await disable(listed, update)).toEqual([]);
  expect(update).toHaveBeenCalledTimes(1);
});

test("a failing job does not abort the remaining bound jobs", async () => {
  const listed = [job({ id: "vanished", sessionKey: "cron:bound" }), job({ id: "bound" })];
  const update = fakeUpdateWithPrecondition(() => [job({ id: "bound" })]);
  await expect(disable(listed, update)).rejects.toThrow(AggregateError);
  expect(update).toHaveBeenCalledTimes(2);
  expect(update.mock.calls.map((call) => call[0])).toEqual(["vanished", "bound"]);
});
