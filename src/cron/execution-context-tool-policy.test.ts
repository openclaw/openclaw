import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { useWidgetHarness } from "../canvas/widget-tool.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronStoredJob } from "./types.js";

// Stands in for the Gateway transport under the automations tool's real request
// guard: records every dispatched RPC, answers cron.list with the run's job and a
// sibling, and can hold cron.get open so a test can close the run mid-call.
const gateway = vi.hoisted(() => ({
  dispatches: [] as { method: string; params: unknown }[],
  holdGet: undefined as Promise<void> | undefined,
}));
vi.mock("../agents/tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/tools/gateway.js")>()),
  callGatewayTool: async (method: string, _opts: unknown, params: unknown) => {
    gateway.dispatches.push({ method, params });
    if (method === "cron.get") {
      await gateway.holdGet;
    }
    if (method !== "cron.list") {
      return { ok: true };
    }
    const jobs = [{ id: "job-1" }, { id: "sibling-job" }];
    return {
      jobs,
      total: jobs.length,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
      snapshotRevision: "rev",
    };
  },
}));

// The resident profile catalog is the profile requester's owner check; this
// requester's profile is current, so an owner child gets the owner scope.
vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: () => ({ assertCurrent: () => {} }),
}));

const { consumeCronNextCheckProposal } = await import("../infra/agent-run-registry.automation.js");
const { claimAgentRunContext, releaseAgentRunContext } =
  await import("../infra/agent-run-registry.js");
const { resolveAdmittedRunActiveAssertion } = await import("../agents/admitted-run-context.js");
const { createOpenClawCodingToolsInternalAsync } = await import("../agents/agent-tools.js");
const { resolveGatewayScopedTools } = await import("../gateway/tool-resolution.js");
const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { resolveScheduledSenderBit } = await import("./execution-context-registry.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");

const PARENT_KEY = "agent:main:dashboard:parent";
const RUN_KEY = "agent:main:cron:job-1:run:s1";
const PROFILE = { type: "human", source: "profile", id: "profile-requester" } as const;
const CFG: OpenClawConfig = {};
const SCOPE_ERROR = "Automations tool is restricted to the current automation.";
const dispatched = () => gateway.dispatches.map((call) => call.method);

function job(overrides: Partial<CronStoredJob>): CronStoredJob {
  return {
    id: "job-1",
    agentId: "main",
    name: "Tool policy",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "work" },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  } as CronStoredJob;
}

const linked = { sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" } };

/** One stored job per placement and owner kind, with the session its run uses. */
const RUNS = [
  {
    name: "owner child (self-and-parent-wake scope)",
    job: job({ ...linked, createdActor: PROFILE }),
    runKey: RUN_KEY,
    placement: "child",
  },
  {
    name: "non-owner child (no recorded requester)",
    job: job({
      ...linked,
      scheduledToolPolicy: {
        mode: "account",
        ownerSessionKey: PARENT_KEY,
        ownerAccountId: "default",
      },
    } as Partial<CronStoredJob>),
    runKey: RUN_KEY,
    placement: "child",
  },
  {
    name: "detached operator job",
    job: job({ scheduledToolPolicy: { mode: "trusted" } } as Partial<CronStoredJob>),
    runKey: RUN_KEY,
    placement: "detached",
  },
  {
    name: "session: job",
    job: job({ sessionTarget: `session:${PARENT_KEY}` }),
    runKey: PARENT_KEY,
    placement: "in-session",
  },
] as const;

useWidgetHarness();

beforeEach(() => {
  setRuntimeConfigSnapshot(CFG);
  gateway.dispatches.length = 0;
  gateway.holdGet = undefined;
  replaceSessionEntrySync(
    { sessionKey: PARENT_KEY },
    { sessionId: "parent-session", lifecycleRevision: "rev-1", updatedAt: Date.now() },
  );
  replaceSessionEntrySync(
    { sessionKey: RUN_KEY },
    { sessionId: "run-session", updatedAt: Date.now() },
  );
});

const settles: (() => void)[] = [];
afterEach(() => {
  for (const settle of settles.splice(0)) {
    settle();
  }
});

// Admits an occurrence and its run the way the cron executor does.
async function admitRun(stored: CronStoredJob, runKey: string, toolsAllow: string[]) {
  const occurrence = await admitScheduledOccurrence({
    cfg: CFG,
    job: stored,
    agentId: "main",
    trigger: "cron",
  });
  const scheduledExecution = occurrence.mint({
    cfg: CFG,
    agentId: "main",
    runId: "run-1",
    runSessionKey: runKey,
    toolsAllow,
  });
  const admission = prepareCronRunAdmission({
    cfg: CFG,
    agentId: "main",
    runId: "run-1",
    sessionKey: runKey,
    jobId: stored.id,
    deliveryAttemptFence: null,
    scheduledExecution,
  });
  const admitted = await admission.preparedRunAdmission.admit("embedded");
  const result = scheduledExecution.result;
  if (result.status !== "ready") {
    throw new Error(`expected a ready context, got ${result.status}`);
  }
  settles.push(() => {
    admission.close();
    occurrence.release();
  });
  return {
    admitted,
    runKey,
    toolsAllow,
    automationsScope: result.facts.toolPolicy.automations.scope,
    senderIsOwner: resolveScheduledSenderBit(result)?.senderIsOwner,
  };
}

type Run = Awaited<ReturnType<typeof admitRun>>;

async function embeddedTools(
  run: Run,
  onYield = () => {},
  turn: { trigger?: "cron" | "event"; jobId?: string } = { trigger: "cron", jobId: "job-1" },
) {
  return await createOpenClawCodingToolsInternalAsync({
    config: CFG,
    agentId: "main",
    sessionKey: run.runKey,
    sessionId: "run-session",
    runId: "run-1",
    ...turn,
    operationalRunInstance: run.admitted.operationalRunInstance,
    ...(run.senderIsOwner !== undefined ? { senderIsOwner: run.senderIsOwner } : {}),
    runtimeToolAllowlist: run.toolsAllow,
    onYield,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  });
}

// The CLI grant coerces an absent bit to `false`; the loopback takes the run's
// bit from its context.
async function cliTools(run: Run, onYield = () => {}) {
  const scoped = await resolveGatewayScopedTools({
    cfg: CFG,
    sessionKey: run.runKey,
    sessionId: "run-session",
    runId: "run-1",
    senderIsOwner: false,
    surface: "loopback",
    admittedRunContext: run.admitted,
    toolsAllow: run.toolsAllow,
    onYield,
  });
  return scoped.tools;
}

// Registers the run's automation invocation the way the cron runner does before
// the runtime starts (src/cron/isolated-agent/run.ts). The returned close settles
// it the same way: the invocation is marked closed, then the context released.
function claimAutomationRun(run: Run, nextCheckEnabled = false) {
  const assertAdmitted = resolveAdmittedRunActiveAssertion(run.admitted);
  if (!assertAdmitted) {
    throw new Error("expected an admitted run assertion");
  }
  const invocation: { nextCheckEnabled: boolean; assertCurrent: () => void; closed?: boolean } = {
    nextCheckEnabled,
    assertCurrent: assertAdmitted,
  };
  const claim = claimAgentRunContext(
    "run-1",
    { sessionKey: run.runKey, cronRunsByJobId: new Map([["job-1", invocation]]) },
    { trackOwner: true, ownsContext: true },
  );
  let released = false;
  const close = () => {
    if (!released) {
      released = true;
      invocation.closed = true;
      releaseAgentRunContext("run-1", claim);
    }
  };
  settles.push(close);
  return close;
}

function readActionEnum(tool: AnyAgentTool): string[] {
  const action = (tool.parameters as { properties?: { action?: { enum?: unknown } } } | undefined)
    ?.properties?.action;
  return Array.isArray(action?.enum) ? (action.enum as string[]) : [];
}

async function callError(tool: AnyAgentTool, params: Record<string, unknown>) {
  try {
    await tool.execute("probe", params, undefined, undefined);
    return undefined;
  } catch (error) {
    return String(error);
  }
}

describe("scheduled automations scope", () => {
  it("keeps next_check and self scope when a session continuation carries only admitted job identity", async () => {
    const run = await admitRun(
      job({
        sessionTarget: `session:${PARENT_KEY}`,
        schedule: { kind: "at", at: "2026-11-01T18:00:00Z" },
      }),
      PARENT_KEY,
      ["*"],
    );
    claimAutomationRun(run, true);
    // Embedded session turns carry the admission but no separate jobId projection.
    const automations = (await embeddedTools(run, undefined, { trigger: "cron" })).find(
      (tool) => tool.name === AUTOMATIONS_TOOL_NAME,
    )!;
    await expect(
      automations.execute("next", { action: "next_check", in: "5m" }),
    ).resolves.toMatchObject({ details: { ok: true, delayMs: 300_000 } });
    expect(await callError(automations, { action: "runs", jobId: "sibling-job" })).toContain(
      SCOPE_ERROR,
    );
    expect(dispatched()).toEqual([]);
    expect(consumeCronNextCheckProposal("run-1", "job-1")).toBe(300_000);
  });

  describe.each(RUNS)("$name", (entry) => {
    it.each(["embedded", "cli"] as const)("%s run acts only on its own job", async (runtime) => {
      const run = await admitRun(entry.job, entry.runKey, ["*"]);
      const tools = runtime === "embedded" ? await embeddedTools(run) : await cliTools(run);
      const automations = tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
      expect(automations, "automations tool offered").toBeDefined();
      const actions = readActionEnum(automations!);
      expect(actions).toEqual(expect.arrayContaining(["status", "list", "get", "remove", "runs"]));
      // Conversation schemas stay stable; execution enforces the scheduled scope.
      for (const action of ["add", "update", "run", "wake", "bind"]) {
        expect(await callError(automations!, { action })).toContain(SCOPE_ERROR);
      }
      for (const action of ["get", "remove", "runs"]) {
        expect(await callError(automations!, { action, jobId: "sibling-job" })).toContain(
          SCOPE_ERROR,
        );
      }
      expect(dispatched()).toEqual([]);
      const listed = await automations!.execute("list", { action: "list" }, undefined, undefined);
      const jobs = (listed.details as { jobs?: { id: string }[] }).jobs ?? [];
      expect(jobs.map((listedJob) => listedJob.id)).toEqual(["job-1"]);
      expect(dispatched()).toEqual(["cron.list"]);
    });

    it.each(["embedded", "cli"] as const)("%s run ends on yield", async (runtime) => {
      const run = await admitRun(entry.job, entry.runKey, ["*"]);
      const onYield = vi.fn();
      const tools =
        runtime === "embedded" ? await embeddedTools(run, onYield) : await cliTools(run, onYield);
      const yieldTool = tools.find((tool) => tool.name === "sessions_yield");
      expect(yieldTool).toBeDefined();
      const result = await yieldTool!.execute("yield", {}, undefined, undefined);
      expect(result.details).toMatchObject({
        status: "yielded",
        note: expect.stringContaining("scheduler"),
      });
      expect(onYield).toHaveBeenCalledExactlyOnceWith("Turn yielded.", undefined, undefined);
    });
  });

  it("a run whose tool cap excludes automations cannot call it on either runtime", async () => {
    const run = await admitRun(job({ ...linked, createdActor: PROFILE }), RUN_KEY, [
      "sessions_list",
    ]);
    for (const tools of [await embeddedTools(run), await cliTools(run)]) {
      const automations = tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
      // A denied owner-only tool may stay listed, but answers with a gated refusal.
      if (automations) {
        const result = await automations.execute("probe", { action: "status" });
        expect((result.details as { gated?: boolean } | undefined)?.gated).toBe(true);
      }
    }
    expect(dispatched()).toEqual([]);
  });

  it("a session: run keeps its session's CLI tool catalog", async () => {
    const run = await admitRun(job({ sessionTarget: `session:${PARENT_KEY}` }), PARENT_KEY, ["*"]);
    const scheduled = (await cliTools(run)).map((tool) => tool.name);
    const ordinary = (
      await resolveGatewayScopedTools({
        cfg: CFG,
        sessionKey: PARENT_KEY,
        sessionId: "parent-session",
        runId: "turn-1",
        senderIsOwner: true,
        surface: "loopback",
        onYield: () => {},
      })
    ).tools.map((tool) => tool.name);
    expect(scheduled).toContain("sessions_yield");
    expect(ordinary).toContain("sessions_yield");
  });

  it("control: a session turn without a scheduled context keeps sessions_yield", async () => {
    const tools = await createOpenClawCodingToolsInternalAsync({
      config: CFG,
      agentId: "main",
      sessionKey: PARENT_KEY,
      sessionId: "parent-session",
      runId: "turn-1",
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });
    expect(tools.map((tool) => tool.name)).toContain("sessions_yield");
  });
});

// The context can name a parent wake for an owner child, but the wake action is
// deferred to the automations wake design (openclaw-0d5.9 / 0d5.23). Until then
// the scope offers exactly the self actions.
describe("self-and-parent-wake scope before the wake action lands", () => {
  it.each(["embedded", "cli"] as const)(
    "%s run gets its own job only, no sibling access and no wake",
    async (runtime) => {
      const run = await admitRun(job({ ...linked, createdActor: PROFILE }), RUN_KEY, ["*"]);
      expect(run.automationsScope).toBe("self-and-parent-wake");
      const tools = runtime === "embedded" ? await embeddedTools(run) : await cliTools(run);
      const automations = tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME)!;
      expect(readActionEnum(automations)).not.toContain("wake");
      for (const call of [
        { action: "wake", text: "wake the parent" },
        { action: "wake", mode: "now", text: "wake the parent" },
        { action: "update", jobId: "sibling-job", patch: { enabled: false } },
        { action: "update", jobId: "job-1", patch: { enabled: false } },
        { action: "remove", jobId: "sibling-job" },
        { action: "add", job: { name: "new" } },
      ]) {
        expect(await callError(automations, call), JSON.stringify(call)).toContain(SCOPE_ERROR);
      }
      expect(dispatched()).toEqual([]);
      const listed = await automations.execute("list", { action: "list" }, undefined, undefined);
      const jobs = (listed.details as { jobs?: { id: string }[] }).jobs ?? [];
      expect(jobs.map((listedJob) => listedJob.id)).toEqual(["job-1"]);
    },
  );
});

describe("retained CLI self-management authority", () => {
  async function cliAutomations() {
    const run = await admitRun(job({ ...linked, createdActor: PROFILE }), RUN_KEY, ["*"]);
    const release = claimAutomationRun(run);
    const automations = (await cliTools(run)).find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
    expect(automations).toBeDefined();
    return { automations: automations!, release };
  }

  it("removes its own job while the run is current", async () => {
    const { automations } = await cliAutomations();
    await automations.execute("remove", { action: "remove", jobId: "job-1" }, undefined, undefined);
    expect(gateway.dispatches).toEqual([{ method: "cron.remove", params: { id: "job-1" } }]);
  });

  it("refuses its own job's removal after the run closes, before any Gateway call", async () => {
    const { automations, release } = await cliAutomations();
    release();
    expect(await callError(automations, { action: "remove", jobId: "job-1" })).toContain(
      "Automation invocation is no longer active",
    );
    expect(dispatched()).toEqual([]);
  });

  it("refuses the result and the next mutation when the run closes during an awaited call", async () => {
    const { automations, release } = await cliAutomations();
    let resume = () => {};
    gateway.holdGet = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const pending = callError(automations, { action: "get", jobId: "job-1" });
    await vi.waitFor(() => expect(dispatched()).toEqual(["cron.get"]));
    release();
    resume();
    expect(await pending).toContain("Automation invocation is no longer active");
    expect(await callError(automations, { action: "remove", jobId: "job-1" })).toContain(
      "Automation invocation is no longer active",
    );
    expect(dispatched()).toEqual(["cron.get"]);
  });
});
