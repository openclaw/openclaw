import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { resolveCronSession } from "./isolated-agent/session.js";
import { toPublicCronJob } from "./public-job.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronAddOptions } from "./service/state.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "./skill-collection-review-monitor.js";
import { loadCronStore } from "./store.js";
import type { CronJob, CronJobCreate } from "./types.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-declarative-" });
installCronTestHooks({ logger });
const services = new Set<CronService>();
afterEach(() => {
  for (const service of services) {
    service.stop();
  }
  services.clear();
});

function createCronService(storePath: string, cronEnabled = true) {
  const service = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  services.add(service);
  return service;
}

async function setup() {
  const { storePath } = await makeStorePath();
  const cron = createCronService(storePath);
  await cron.start();
  return { cron, storePath };
}

function declaration(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "daily report",
    declarationKey: "agent:ops:daily-report",
    displayName: "Daily report",
    owner: { agentId: "ops", sessionKey: "agent:ops:main" },
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "report" },
    delivery: { mode: "announce", channel: "last" },
    ...overrides,
  };
}

async function add(cron: CronService, input = declaration(), options?: CronAddOptions) {
  const result = await cron.add(input, options);
  if (!("job" in result)) {
    throw new Error("expected declarative cron result");
  }
  return result;
}

const retiredTriggerState = {
  triggerState: { owner: "retired" },
  triggerEvalCount: 7,
  lastTriggerEvalAtMs: 111,
  lastTriggerFireAtMs: 222,
  lastRunAtMs: 333,
};

type TriggerStateOwner = "condition" | "script" | "none";

function ownedDeclaration(params: {
  declarationKey: string;
  owner: TriggerStateOwner;
  script?: string;
  once?: boolean;
  state?: CronJobCreate["state"];
  sameOwnerEdit?: boolean;
}): CronJobCreate {
  const script = params.script ?? 'return "original"';
  return declaration({
    declarationKey: params.declarationKey,
    delivery: { mode: "none" },
    trigger:
      params.owner === "condition"
        ? { script, ...(params.once !== undefined ? { once: params.once } : {}) }
        : undefined,
    payload:
      params.owner === "script"
        ? { kind: "script", script, ...(params.sameOwnerEdit ? { timeoutSeconds: 45 } : {}) }
        : { kind: "agentTurn", message: "report" },
    ...(params.state ? { state: params.state } : {}),
    ...(params.sameOwnerEdit ? { displayName: "Updated report" } : {}),
  });
}

describe("CronService declarative jobs", () => {
  it("rejects malformed declared triggers without changing persisted jobs", async () => {
    const { cron } = await setup();

    const invalidTrigger = { script: "const x = ;" };
    const expectedError =
      "cron trigger script has a syntax error: Unexpected token (line 1, column 10)";

    await expect(cron.add(declaration({ trigger: invalidTrigger }))).rejects.toThrow(expectedError);
    expect(await cron.list()).toEqual([]);

    const validTrigger = { script: "return { fire: true }" };
    const created = await add(cron, declaration({ trigger: validTrigger }));

    await expect(cron.add(declaration({ trigger: invalidTrigger }))).rejects.toThrow(expectedError);
    expect(await cron.readJob(created.id)).toMatchObject({ trigger: validTrigger });
    expect(await cron.list()).toEqual([expect.objectContaining({ trigger: validTrigger })]);
  });

  it("creates, no-ops, and converges in place while preserving state and enablement", async () => {
    const { cron } = await setup();

    const created = await add(cron, declaration({ declarationKey: "  agent:ops:daily-report  " }), {
      enabledExplicit: true,
    });
    expect(created.created).toBe(true);
    expect(created).not.toHaveProperty("updated");
    expect(created.job).toMatchObject({
      declarationKey: "agent:ops:daily-report",
      displayName: "Daily report",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
      payload: { toolsAllow: ["*"] },
    });

    const identical = await add(cron, declaration(), { enabledExplicit: true });
    expect(identical).toMatchObject({
      created: false,
      updated: false,
      id: created.id,
    });

    await cron.update(created.id, { state: { consecutiveErrors: 2 } });
    const alreadyEnabled = await add(cron, declaration(), { enabledExplicit: true });
    expect(alreadyEnabled).toMatchObject({
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
    expect(converged).toMatchObject({ created: false, updated: true, id: created.id });
    expect(converged.job).toMatchObject({
      ...summary,
      id: created.id,
      enabled: false,
      state: previousFailure,
    });
    const explicitlyEnabled = await add(cron, declaration(summary), { enabledExplicit: true });
    expect(explicitlyEnabled).toMatchObject({
      created: false,
      updated: true,
      id: created.id,
      enabled: true,
    });
    const cleared = await cron.update(created.id, { displayName: null });
    expect(cleared).not.toHaveProperty("displayName");
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
      const job = (await loadCronStore(storePath)).jobs[0]!;
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
      const persisted = (await loadCronStore(storePath)).jobs[0]!;
      expect(persisted.state.autoDisabled).toBeUndefined();
      expect(persisted.state.streamRestartExhausted).toBeUndefined();
      if (failure === "stream-exhausted") {
        expect(persisted.state.streamConsecutiveFailures).toBe(0);
        expect(persisted.state.streamError).toBeUndefined();
      }
      expect((await add(cron, input, { enabledExplicit: true })).updated).toBe(false);
    },
  );

  it("persists an ineligible review and reconciles recovery without replacing its job", async () => {
    const { cron, storePath } = await setup();
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: "openai/gpt-blocked" },
        list: [
          {
            id: "main",
            models: { "openai/gpt-blocked": { agentRuntime: { id: "unsupported-harness" } } },
          },
        ],
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    };
    const project = () => {
      const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
      return spec!.input;
    };
    const created = await add(cron, project(), { enabledExplicit: true, systemOwned: true });
    expect(created.job).toMatchObject({
      enabled: false,
      displayName: expect.stringContaining("no-rooted-runtime"),
    });
    expect(created.job.state.nextRunAtMs).toBeUndefined();
    expect(
      (await loadCronStore(storePath)).jobs.find((job) => job.id === created.id),
    ).toMatchObject({ enabled: false, displayName: created.job.displayName });
    cfg.agents!.defaults!.model = "anthropic/claude-sonnet-4-6";
    const recovered = await add(cron, project(), { enabledExplicit: true, systemOwned: true });
    expect(recovered).toMatchObject({
      id: created.id,
      created: false,
      updated: true,
      enabled: true,
    });
    expect(recovered.job.displayName).toBe("Skill collection review (main)");
    expect(recovered.job.state.nextRunAtMs).toEqual(expect.any(Number));
    expect(
      (await loadCronStore(storePath)).jobs.find((job) => job.id === created.id),
    ).toMatchObject({ enabled: true, displayName: "Skill collection review (main)" });
  });

  it("keeps the first creator across declaration convergence and restart", async () => {
    const { cron: writer, storePath } = await setup();
    const selections = [
      {
        skillId: "00000000-0000-4000-8000-000000000001",
        revision: "a".repeat(64),
        name: "s_report_00000000000040008000",
        ownerProfileId: "profile-ada",
      },
    ];

    const created = await add(writer, declaration(), {
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      skillLibrarySelections: selections,
    });
    expect(created.job).toMatchObject({
      createdActor: { type: "human", id: "profile-ada" },
    });

    const converged = await add(writer, declaration({ displayName: "Updated report" }), {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      skillLibrarySelections: [],
    });
    expect(converged).toMatchObject({ created: false, updated: true, id: created.id });
    expect(converged.job).toMatchObject({
      createdActor: { type: "human", id: "profile-ada" },
    });
    writer.stop();

    const reader = createCronService(storePath, false);
    await expect(reader.readJob(created.id)).resolves.toMatchObject({
      createdActor: { type: "human", id: "profile-ada" },
      skillLibrarySelections: selections,
    });
    const job = (await loadCronStore(storePath)).jobs.find((stored) => stored.id === created.id)!;
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
    const restarted = resolveCronSession({
      ...session,
      store: { [session.sessionKey]: first.sessionEntry },
      skillLibrarySelections: [],
    });
    expect(restarted.sessionEntry.skillLibrarySelections).toEqual(selections);
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
      type Transition = {
        replaceScript?: boolean;
        nextOnce?: boolean;
        sameOwnerEdit?: boolean;
        replacementState?: CronJobCreate["state"];
      };
      const cases: Array<[string, TriggerStateOwner, TriggerStateOwner, Transition]> = [
        ["condition to script", "condition", "script", {}],
        ["script replacement", "script", "script", { replaceScript: true }],
        ["script removal", "script", "none", {}],
        ["same condition", "condition", "condition", { sameOwnerEdit: true }],
        ["same script", "script", "script", { sameOwnerEdit: true }],
        ["same absent owner", "none", "none", { sameOwnerEdit: true }],
        ["once made explicit false", "condition", "condition", { nextOnce: false }],
        ["once enabled", "condition", "condition", { nextOnce: true }],
        [
          "explicit null state",
          "condition",
          "condition",
          {
            replaceScript: true,
            replacementState: { triggerState: null, triggerEvalCount: 0 },
          },
        ],
        [
          "explicit timestamps",
          "condition",
          "script",
          {
            replacementState: { lastTriggerEvalAtMs: 444, lastTriggerFireAtMs: 555 },
          },
        ],
      ];
      const expectedJobs: Array<{ id: string; state: CronJob["state"]; name: string }> = [];
      const expectState = (
        actual: CronJob["state"] | undefined,
        expected: CronJob["state"],
        name: string,
      ) => {
        expect(actual, name).toMatchObject(expected);
        for (const field of [
          "triggerState",
          "triggerEvalCount",
          "lastTriggerEvalAtMs",
          "lastTriggerFireAtMs",
        ] as const) {
          expect(actual?.[field], `${name}: ${field}`).toEqual(expected[field]);
        }
      };
      for (const [index, [name, previous, next, changes]] of cases.entries()) {
        const declarationKey = `trigger-owner:${index}`;
        const input = ownedDeclaration({
          declarationKey,
          owner: previous,
          state: retiredTriggerState,
        });
        if (mutationPath === "ordinary update") {
          delete input.declarationKey;
        }
        const created = await cron.add(input);
        expect(created.state, `${name}: create preserves explicit state`).toMatchObject(
          retiredTriggerState,
        );
        const replacement = ownedDeclaration({
          declarationKey,
          owner: next,
          script: changes.replaceScript ? 'return "replacement"' : undefined,
          once: changes.nextOnce,
          state: changes.replacementState,
          sameOwnerEdit: changes.sameOwnerEdit,
        });
        if (mutationPath === "ordinary update") {
          await cron.update(created.id, {
            trigger: replacement.trigger ?? null,
            payload: replacement.payload,
            displayName: replacement.displayName,
            ...(changes.replacementState ? { state: changes.replacementState } : {}),
          });
        } else {
          await cron.add(replacement);
        }
        const expected = changes.sameOwnerEdit
          ? retiredTriggerState
          : {
              lastRunAtMs: retiredTriggerState.lastRunAtMs,
              ...changes.replacementState,
            };
        const persisted = (await loadCronStore(storePath)).jobs.find(
          (entry) => entry.id === created.id,
        );
        expectState(persisted?.state, expected, `${name}: durable state`);
        expectedJobs.push({ id: created.id, state: expected, name });
      }
      cron.stop();
      const restarted = createCronService(storePath, false);
      for (const expected of expectedJobs) {
        expectState(
          (await restarted.readJob(expected.id))?.state,
          expected.state,
          `${expected.name}: restart`,
        );
      }
    },
  );

  it("rejects concurrent stale-owner updates across service instances sharing SQLite", async () => {
    const { cron: first, storePath } = await setup();
    const second = createCronService(storePath);
    await second.start();

    const created = await add(
      first,
      ownedDeclaration({
        declarationKey: "trigger-owner:concurrent",
        owner: "condition",
        state: retiredTriggerState,
      }),
    );
    await second.readJob(created.id);
    const staleRevision = resolveCronJobConfigRevision(created.job);
    const replacementState = { triggerState: { owner: "replacement" }, triggerEvalCount: 23 };
    const commitGuard = vi.fn();

    await expect(
      first.add(
        ownedDeclaration({
          declarationKey: "trigger-owner:concurrent",
          owner: "condition",
          script: 'return "invalid"',
          state: { lastTriggerEvalAtMs: -1 },
        }),
        { commitGuard },
      ),
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
        (current) => {
          if (resolveCronJobConfigRevision(current) !== staleRevision) {
            throw new Error("revision conflict");
          }
        },
      ),
    ]);

    expect(replacement.status).toBe("fulfilled");
    expect(stale).toMatchObject({ status: "rejected", reason: new Error("revision conflict") });
    const persisted = await second.readJob(created.id);
    expect(persisted?.state).toMatchObject(replacementState);
    expect(persisted?.state.lastTriggerEvalAtMs).toBeUndefined();
    expect(persisted?.state.lastTriggerFireAtMs).toBeUndefined();
    expect(persisted?.displayName).toBe("Daily report");
    expect(persisted?.trigger).toEqual({ script: 'return "replacement"' });

    const currentRevision = resolveCronJobConfigRevision(persisted!);
    await second.updateWithPrecondition(created.id, { displayName: "Current owner" }, (current) => {
      if (resolveCronJobConfigRevision(current) !== currentRevision) {
        throw new Error("revision conflict");
      }
    });
    expect((await first.readJob(created.id))?.state).toMatchObject(replacementState);
  });

  it("converges delivery while retaining the declared session target", async () => {
    const { cron } = await setup();

    const created = await cron.add(
      declaration({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "wake" },
        delivery: undefined,
      }),
    );
    // Session target is identity-adjacent and stays outside declaration
    // convergence; delivery converges, and main + webhook is a supported
    // shipped combination.
    const converged = await cron.add(
      declaration({
        sessionTarget: "isolated",
        payload: { kind: "systemEvent", text: "wake" },
        delivery: { mode: "webhook", to: "https://example.invalid/hook" },
      }),
    );
    expect(converged).toMatchObject({ created: false, updated: true });
    expect(await cron.readJob(created.id)).toMatchObject({
      sessionTarget: "main",
      delivery: { mode: "webhook", to: "https://example.invalid/hook" },
    });
  });

  it("persists declaration metadata and rejects blank or duplicate reserved ids", async () => {
    const { cron: writer, storePath } = await setup();
    const created = await add(writer, declaration({ id: "reserved-id" }), {
      enabledExplicit: true,
    });
    await expect(writer.add(declaration({ declarationKey: undefined, id: "  " }))).rejects.toThrow(
      "id must not be blank",
    );
    await expect(
      writer.add(declaration({ declarationKey: undefined, id: created.id })),
    ).rejects.toThrow("already exists");
    await expect(writer.add(declaration({ displayName: "   " }))).rejects.toThrow(
      "displayName must not be blank",
    );
    await expect(writer.update(created.id, { displayName: "   " })).rejects.toThrow(
      "displayName must not be blank",
    );
    for (const id of ["nested/job", "..\\job", "nul\0job"]) {
      await expect(writer.add(declaration({ declarationKey: undefined, id }))).rejects.toThrow(
        "invalid cron run job id",
      );
    }
    writer.stop();

    const reader = createCronService(storePath, false);
    const persisted = await reader.readJob(created.id);
    expect(persisted).toMatchObject({
      declarationKey: "agent:ops:daily-report",
      displayName: "Daily report",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
    } satisfies Partial<CronJob>);
  });
});
