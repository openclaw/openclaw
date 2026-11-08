import { afterEach, expect, it, vi } from "vitest";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { resolveCronSession } from "./isolated-agent/session.js";
import { toPublicCronJob } from "./public-job.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronAddOptions } from "./service/state.js";
import { loadCronStore } from "./store.js";
import type { CronJob, CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "openclaw-cron-declarative-" });
const services = new Set<CronService>();
afterEach(() => {
  services.forEach((service) => service.stop());
  services.clear();
});

function createCronService(storePath: string, cronEnabled = true) {
  const service = new CronService(cronTestDeps({ storePath, cronEnabled, log: logger }));
  services.add(service);
  return service;
}

async function setup() {
  const { storePath } = await makeStorePath();
  const cron = createCronService(storePath);
  await cron.start();
  return { cron, storePath };
}

async function storedJob(storePath: string, id?: string) {
  return (await loadCronStore(storePath)).jobs.find((job) => !id || job.id === id)!;
}

const declaration = (overrides: Partial<CronJobCreate> = {}) =>
  cronTestInput({
    name: "daily report",
    declarationKey: "agent:ops:daily-report",
    displayName: "Daily report",
    owner: { agentId: "ops", sessionKey: "agent:ops:main" },
    payload: { kind: "agentTurn", message: "report" },
    delivery: { mode: "announce", channel: "last" },
    ...overrides,
  });

async function add(cron: CronService, input = declaration(), options?: CronAddOptions) {
  const result = await cron.add(input, options);
  if (!("job" in result)) {
    throw new Error("expected declarative cron result");
  }
  return result;
}

function expectUpdate(result: Awaited<ReturnType<typeof add>>, id: string, job?: unknown) {
  expect(result).toMatchObject({ created: false, updated: true, id, ...(job ? { job } : {}) });
}

const retiredTriggerState = {
  triggerState: { owner: "retired" },
  triggerEvalCount: 7,
  lastTriggerEvalAtMs: 111,
  lastTriggerFireAtMs: 222,
  lastRunAtMs: 333,
};

type TriggerStateOwner = "condition" | "script" | "none";

function ownedDeclaration(
  owner: TriggerStateOwner,
  params: {
    declarationKey?: string;
    script?: string;
    once?: boolean;
    state?: CronJobCreate["state"];
    sameOwnerEdit?: boolean;
  },
): CronJobCreate {
  const script = params.script ?? 'return "original"';
  return declaration({
    declarationKey: params.declarationKey,
    delivery: { mode: "none" },
    trigger:
      owner === "condition"
        ? { script, ...(params.once !== undefined ? { once: params.once } : {}) }
        : undefined,
    payload:
      owner === "script"
        ? { kind: "script", script, ...(params.sameOwnerEdit ? { timeoutSeconds: 45 } : {}) }
        : { kind: "agentTurn", message: "report" },
    ...(params.state ? { state: params.state } : {}),
    ...(params.sameOwnerEdit ? { displayName: "Updated report" } : {}),
  });
}

it("rejects malformed declared triggers without changing persisted jobs", async () => {
  const { cron } = await setup();
  const rejectsTrigger = () =>
    expect(cron.add(declaration({ trigger: { script: "const x = ;" } }))).rejects.toThrow(
      "cron trigger script has a syntax error: Unexpected token (line 1, column 10)",
    );
  await rejectsTrigger();
  expect(await cron.list()).toEqual([]);
  const validTrigger = { script: "return { fire: true }" };
  const created = await add(cron, declaration({ trigger: validTrigger }));
  await rejectsTrigger();
  expect(await cron.readJob(created.id)).toMatchObject({ trigger: validTrigger });
  expect(await cron.list()).toEqual([expect.objectContaining({ trigger: validTrigger })]);
});

it("creates, no-ops, and converges in place while preserving state and enablement", async () => {
  const { cron } = await setup();
  const created = await add(cron, declaration({ declarationKey: "  agent:ops:daily-report  " }), {
    enabledExplicit: true,
  });
  expect(created).toMatchObject({
    created: true,
    job: {
      declarationKey: "agent:ops:daily-report",
      displayName: "Daily report",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
      payload: { toolsAllow: ["*"] },
    },
  });
  expect(created).not.toHaveProperty("updated");
  expect(await add(cron, declaration(), { enabledExplicit: true })).toMatchObject({
    created: false,
    updated: false,
    id: created.id,
  });
  await cron.update(created.id, { state: { consecutiveErrors: 2 } });
  expect(await add(cron, declaration(), { enabledExplicit: true })).toMatchObject({
    updated: false,
    job: { enabled: true, state: { consecutiveErrors: 2 } },
  });
  const previousFailure: CronJob["state"] = {
    lastRunAtMs: 1234,
    lastRunStatus: "error",
    lastError: "previous failure",
  };
  await cron.update(created.id, { enabled: false, state: previousFailure });
  const summary = {
    displayName: "Daily summary",
    schedule: { kind: "every", everyMs: 120_000 },
    payload: { kind: "agentTurn", message: "summarize" },
    delivery: { mode: "none" },
  } satisfies Partial<CronJobCreate>;
  const converged = await add(cron, declaration(summary), { enabledExplicit: false });
  expectUpdate(converged, created.id, {
    ...summary,
    id: created.id,
    enabled: false,
    state: previousFailure,
  });
  expect(await add(cron, declaration(summary), { enabledExplicit: true })).toMatchObject({
    created: false,
    updated: true,
    id: created.id,
    enabled: true,
  });
  expect(await cron.update(created.id, { displayName: null })).not.toHaveProperty("displayName");
});

it.each(["auto-disabled", "stream-exhausted"] as const)(
  "resets %s state when a declaration explicitly re-enables the job",
  async (failure) => {
    const { storePath } = await makeStorePath();
    const input = declaration({
      delivery: { mode: "none" },
      ...(failure === "stream-exhausted"
        ? { schedule: { kind: "stream" as const, command: ["node", "events.mjs"] } }
        : {}),
    });
    const writer = createCronService(storePath);
    const created = await add(writer, input);
    writer.stop();
    const job = await storedJob(storePath);
    job.enabled = failure === "stream-exhausted";
    job.state.consecutiveErrors = 10;
    job.state.scheduleErrorCount = 3;
    if (failure === "auto-disabled") {
      job.state.autoDisabled = {
        reason: "consecutive-failures",
        atMs: Date.now(),
        consecutiveErrors: 10,
      };
    } else {
      job.state.streamRestartExhausted = true;
      job.state.streamConsecutiveFailures = 5;
      job.state.streamError = "source exited repeatedly";
    }
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const cron = createCronService(storePath);
    const unchanged = await add(cron, input, { enabledExplicit: false });
    expect(unchanged).toMatchObject({ updated: false, job: { enabled: job.enabled } });
    expect(unchanged.job.state).toEqual(job.state);
    const enabled = await add(cron, input, { enabledExplicit: true });
    expect(enabled).toMatchObject({
      id: created.id,
      updated: true,
      job: { enabled: true, state: { consecutiveErrors: 0, scheduleErrorCount: 0 } },
    });
    const persisted = await storedJob(storePath);
    expect([persisted.state.autoDisabled, persisted.state.streamRestartExhausted]).toEqual([
      undefined,
      undefined,
    ]);
    if (failure === "stream-exhausted") {
      expect([persisted.state.streamConsecutiveFailures, persisted.state.streamError]).toEqual([
        0,
        undefined,
      ]);
    }
    expect((await add(cron, input, { enabledExplicit: true })).updated).toBe(false);
  },
);

it("keeps the first creator across declaration convergence and restart", async () => {
  const { cron: writer, storePath } = await setup();
  const sourceConversation = {
    sessionKey: "agent:ops:conversation",
    sessionId: "creating-session",
    lifecycleRevision: "generation-1",
  };
  const selections = [
    {
      skillId: "00000000-0000-4000-8000-000000000001",
      revision: "a".repeat(64),
      name: "s_report_00000000000040008000",
      ownerProfileId: "profile-ada",
    },
  ];
  const provenance = { createdActor: { type: "human", id: "profile-ada" }, sourceConversation };
  const created = await add(writer, declaration({ id: "reserved-id" }), {
    createdActor: { type: "human", source: "profile", id: "profile-ada" },
    sourceConversation,
    skillLibrarySelections: selections,
  });
  expect(created.job).toMatchObject(provenance);
  expect(
    await add(writer, declaration(), {
      sourceConversation: { ...sourceConversation, lifecycleRevision: "generation-2" },
    }),
  ).toMatchObject({ created: false, updated: false, job: { sourceConversation } });
  const converged = await add(writer, declaration({ displayName: "Updated report" }), {
    createdActor: { type: "human", source: "profile", id: "profile-bob" },
    sourceConversation: { sessionKey: "agent:ops:other", sessionId: "other-session" },
    skillLibrarySelections: [],
  });
  expectUpdate(converged, created.id, provenance);
  await writer.update(created.id, { sessionKey: "agent:ops:other" });
  writer.stop();
  const reader = createCronService(storePath, false);
  await expect(reader.readJob(created.id)).resolves.toMatchObject({
    id: "reserved-id",
    ...provenance,
    skillLibrarySelections: selections,
    declarationKey: "agent:ops:daily-report",
    displayName: "Updated report",
    owner: { agentId: "ops", sessionKey: "agent:ops:main" },
  });
  const job = await storedJob(storePath, created.id);
  expect(toPublicCronJob(job)).not.toHaveProperty("skillLibrarySelections");
  const session = {
    cfg: {},
    sessionKey: "agent:ops:cron:test",
    agentId: "ops",
    nowMs: Date.now(),
    forceNew: true,
    lifecycleTimestamps: {},
  };
  const first = resolveCronSession({
    ...session,
    store: {},
    skillLibrarySelections: job.skillLibrarySelections,
  });
  expect(first.sessionEntry.skillLibrarySelections).toEqual(selections);
});

it("keeps declaration-key uniqueness local to the caller visibility predicate", async () => {
  const { cron } = await setup();
  const key = "shared-key";
  const scopedAdd = (agentId: string, displayName = "Daily report") =>
    add(cron, declaration({ declarationKey: key, owner: { agentId }, displayName }), {
      matchesExisting: (job) => job.owner?.agentId === agentId,
    });
  const agentA = await scopedAdd("alpha");
  const agentB = await scopedAdd("beta");
  expect(agentB.id).not.toBe(agentA.id);
  await expect(cron.add(declaration({ declarationKey: key }))).rejects.toThrow(
    "ambiguous within caller scope",
  );
  const agentAUpdate = await scopedAdd("alpha", "Alpha report");
  expect(agentAUpdate).toMatchObject({
    created: false,
    updated: true,
    id: agentA.id,
    displayName: "Alpha report",
  });
  expect(await cron.list()).toHaveLength(2);
});

it.each(["ordinary update", "declarative convergence"] as const)(
  "persists trigger-state ownership transitions and explicit replacements through %s",
  async (mutationPath) => {
    const { cron, storePath } = await setup();
    type Transition = Parameters<typeof ownedDeclaration>[1];
    const script = 'return "replacement"';
    const nullState = { triggerState: null, triggerEvalCount: 0 };
    const timestamps = { lastTriggerEvalAtMs: 444, lastTriggerFireAtMs: 555 };
    const cases: Array<[string, TriggerStateOwner, TriggerStateOwner, Transition]> = [
      ["condition to script", "condition", "script", {}],
      ["script replacement", "script", "script", { script }],
      ["script removal", "script", "none", {}],
      ["same condition", "condition", "condition", { sameOwnerEdit: true }],
      ["same script", "script", "script", { sameOwnerEdit: true }],
      ["same absent owner", "none", "none", { sameOwnerEdit: true }],
      ["once made explicit false", "condition", "condition", { once: false }],
      ["once enabled", "condition", "condition", { once: true }],
      ["explicit null state", "condition", "condition", { script, state: nullState }],
      ["explicit timestamps", "condition", "script", { state: timestamps }],
    ];
    const expectedJobs: Array<{ id: string; state: CronJob["state"]; name: string }> = [];
    const stateFields = (state?: CronJob["state"]) => ({
      triggerState: state?.triggerState,
      triggerEvalCount: state?.triggerEvalCount,
      lastTriggerEvalAtMs: state?.lastTriggerEvalAtMs,
      lastTriggerFireAtMs: state?.lastTriggerFireAtMs,
      lastRunAtMs: state?.lastRunAtMs,
    });
    for (const [index, [name, previous, next, changes]] of cases.entries()) {
      const declarationKey = `trigger-owner:${index}`;
      const input = ownedDeclaration(previous, { declarationKey, state: retiredTriggerState });
      if (mutationPath === "ordinary update") {
        delete input.declarationKey;
      }
      const created = await cron.add(input);
      expect(created.state, `${name}: create preserves explicit state`).toMatchObject(
        retiredTriggerState,
      );
      const replacement = ownedDeclaration(next, { declarationKey, ...changes });
      if (mutationPath === "ordinary update") {
        await cron.update(created.id, {
          trigger: replacement.trigger ?? null,
          payload: replacement.payload,
          displayName: replacement.displayName,
          ...(changes.state ? { state: changes.state } : {}),
        });
      } else {
        await cron.add(replacement);
      }
      const expected = changes.sameOwnerEdit
        ? retiredTriggerState
        : { lastRunAtMs: 333, ...changes.state };
      const persisted = await storedJob(storePath, created.id);
      expect(stateFields(persisted?.state), `${name}: durable state`).toEqual(
        stateFields(expected),
      );
      expectedJobs.push({ id: created.id, state: expected, name });
    }
    cron.stop();
    const restarted = createCronService(storePath, false);
    for (const expected of expectedJobs) {
      expect(
        stateFields((await restarted.readJob(expected.id))?.state),
        `${expected.name}: restart`,
      ).toEqual(stateFields(expected.state));
    }
  },
);

it("rejects concurrent stale-owner updates across service instances sharing SQLite", async () => {
  const { cron: first, storePath } = await setup();
  const second = createCronService(storePath);
  await second.start();
  const input = (state: CronJobCreate["state"], script?: string) =>
    ownedDeclaration("condition", { declarationKey: "trigger-owner:concurrent", state, script });
  const guard = (revision: string) => (current: CronJob) => {
    if (resolveCronJobConfigRevision(current) !== revision) {
      throw new Error("revision conflict");
    }
  };
  const created = await add(first, input(retiredTriggerState));
  await second.readJob(created.id);
  const staleRevision = resolveCronJobConfigRevision(created.job);
  const replacementState = { triggerState: { owner: "replacement" }, triggerEvalCount: 23 };
  const commitGuard = vi.fn();
  await expect(
    first.add(input({ lastTriggerEvalAtMs: -1 }, 'return "invalid"'), { commitGuard }),
  ).rejects.toThrow("cron state.lastTriggerEvalAtMs must be a non-negative Date-valid integer");
  expect(commitGuard).not.toHaveBeenCalled();
  expect((await second.readJob(created.id))?.state).toMatchObject(retiredTriggerState);
  const [replacement, stale] = await Promise.allSettled([
    first.update(created.id, {
      trigger: { script: 'return "replacement"' },
      state: replacementState,
    }),
    second.updateWithPrecondition(
      created.id,
      {
        displayName: "Stale owner",
        trigger: { script: 'return "obsolete"' },
        state: { triggerState: { owner: "obsolete" }, triggerEvalCount: 99 },
      },
      guard(staleRevision),
    ),
  ]);
  expect(replacement.status).toBe("fulfilled");
  expect(stale).toMatchObject({ status: "rejected", reason: new Error("revision conflict") });
  const persisted = await second.readJob(created.id);
  expect(persisted).toMatchObject({ state: replacementState, displayName: "Daily report" });
  expect([persisted?.state.lastTriggerEvalAtMs, persisted?.state.lastTriggerFireAtMs]).toEqual([
    undefined,
    undefined,
  ]);
  expect(persisted?.trigger).toEqual({ script: 'return "replacement"' });
  await second.updateWithPrecondition(
    created.id,
    { displayName: "Current owner" },
    guard(resolveCronJobConfigRevision(persisted!)),
  );
  expect((await first.readJob(created.id))?.state).toMatchObject(replacementState);
});

it("rejects blank metadata and invalid or duplicate reserved ids", async () => {
  const { cron: writer } = await setup();
  const created = await add(writer, declaration({ id: "reserved-id" }), {
    enabledExplicit: true,
  });
  const invalid: Array<[Partial<CronJobCreate>, string]> = [
    [{ declarationKey: undefined, id: "  " }, "id must not be blank"],
    [{ declarationKey: undefined, id: created.id }, "already exists"],
    [{ displayName: "   " }, "displayName must not be blank"],
    ...["nested/job", "..\\job", "nul\0job"].map((id): [Partial<CronJobCreate>, string] => [
      { declarationKey: undefined, id },
      "invalid cron run job id",
    ]),
  ];
  for (const [input, error] of invalid) {
    await expect(writer.add(declaration(input))).rejects.toThrow(error);
  }
  await expect(writer.update(created.id, { displayName: "   " })).rejects.toThrow(
    "displayName must not be blank",
  );
});
