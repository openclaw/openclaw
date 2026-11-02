import { expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  disableCronJobsBoundToSessions,
  resolveCronJobSessionBindings,
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
    expect([
      ...resolveCronJobSessionBindings(
        { id: "job1", sessionTarget, sessionKey },
        { cfg: {}, defaultAgentId },
      ).keys(),
    ]).toEqual(expected);
  },
);

test("shares binding facts across interleaved session-routing contexts", () => {
  const definition = { id: "shared", sessionTarget: "main" as const };
  const contexts = [
    { cfg: {}, defaultAgentId: "ops" },
    { cfg: {}, defaultAgentId: "research" },
    { cfg: { session: { scope: "global" as const } }, defaultAgentId: "ops" },
  ];
  const expected = ["agent:ops:main", "agent:research:main", "global"];
  const first = contexts.map((opts, index) => {
    const keys = resolveCronJobSessionBindings(definition, opts);
    expect([...keys]).toEqual([[expected[index], ["ops", "research", "ops"][index]]]);
    return keys;
  });
  for (let round = 0; round < 3; round++) {
    contexts.forEach((opts, index) => {
      expect(resolveCronJobSessionBindings(definition, opts)).toBe(first[index]);
    });
  }
});

test("refreshes binding facts after job edits and agent/session routing changes", () => {
  const definition = job({
    id: "changing",
    sessionKey: "delivery",
    sourceConversation: { sessionKey: "source", sessionId: "creator" },
  });
  const cfg: OpenClawConfig = { session: { mainKey: "home" } };
  const opts = { cfg, defaultAgentId: "ops" as string | undefined };
  const check = (expected: string[]) => {
    const keys = resolveCronJobSessionBindings(definition, opts);
    expect([...keys.keys()]).toEqual(expected);
    expect(resolveCronJobSessionBindings(definition, opts)).toBe(keys);
  };
  check(["agent:ops:cron:changing", "agent:ops:delivery", "agent:ops:source"]);
  definition.sessionTarget = "session:other";
  check(["agent:ops:other", "agent:ops:delivery", "agent:ops:source"]);
  definition.sessionKey = "agent:research:delivery";
  check(["agent:research:other", "agent:research:delivery", "agent:research:source"]);
  definition.agentId = "writer";
  definition.sourceConversation!.sessionKey = "new-source";
  check(["agent:writer:other", "agent:research:delivery", "agent:writer:new-source"]);
  definition.agentId = undefined;
  definition.sessionKey = undefined;
  definition.sourceConversation = undefined;
  opts.defaultAgentId = "rebound";
  check(["agent:rebound:other"]);
  definition.sessionTarget = "main";
  check(["agent:rebound:home"]);
  cfg.session!.mainKey = "inbox";
  check(["agent:rebound:inbox"]);
  cfg.session!.scope = "global";
  check(["global"]);
  opts.defaultAgentId = undefined;
  check([]);
  opts.defaultAgentId = "ops";
  definition.sessionTarget = "isolated";
  definition.id = "replaced";
  check(["agent:ops:cron:replaced"]);
  definition.sessionTarget = "session: ";
  check([]);
});

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
  expect(update.mock.calls.map((call) => call[0])).toEqual(["vanished", "bound"]);
});

test.each([
  ["global", "global"],
  ["per-sender", "agent:ops:global"],
] as const)("retains physical ownership and qualified targets in %s scope", (scope, key) => {
  const bindings = resolveCronJobSessionBindings(
    {
      id: "selected",
      agentId: "ops",
      sessionTarget: "session:global",
      sessionKey: "agent:research:global",
      sourceConversation: { sessionKey: "global", sessionId: "creator" },
    },
    { cfg: { session: { scope } }, defaultAgentId: "main" },
  );
  expect(bindings).toEqual(
    new Map([
      [key, "ops"],
      ["agent:research:global", "research"],
    ]),
  );
});
