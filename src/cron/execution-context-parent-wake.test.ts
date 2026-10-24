import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWidgetHarness } from "../canvas/widget-tool.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import type { RespondFn } from "../gateway/server-methods/types.js";
import type { CronStoredJob } from "./types.js";

vi.mock("../agents/openclaw-plugin-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: () => [],
}));
// The requester's profile is current, so the occurrence passes its owner check.
vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: () => ({ assertCurrent: () => {} }),
}));
// In-process dispatch runs the real `wake` handler and hands it the caller's
// commit guard, as the Gateway does. The cron service's wake runs that guard
// at its commit point before recording the event.
const wakes = vi.hoisted(() => ({ committed: [] as Array<Record<string, unknown>> }));
vi.mock("../agents/tools/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/tools/gateway.js")>();
  return {
    ...actual,
    shouldUseInProcessGatewayTool: () => true,
    callGatewayTool: async (
      method: string,
      _opts: unknown,
      params: Record<string, unknown>,
      extra?: { sessionMutationCommitGuard?: () => void },
    ) => {
      if (method !== "wake") {
        throw new Error(`unexpected ${method}`);
      }
      // Loaded at call time: the handler's graph imports this mocked module.
      const { cronWakeHandler } = await import("../gateway/server-methods/cron-wake.js");
      const respond = vi.fn<RespondFn>();
      await cronWakeHandler({
        req: { type: "req", id: "wake", method, params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond,
        sessionMutationCommitGuard: extra?.sessionMutationCommitGuard,
        context: {
          getRuntimeConfig: () => ({}),
          cron: {
            getDefaultAgentId: () => "main",
            wake: async (request: Record<string, unknown> & { commitGuard: () => void }) => {
              request.commitGuard();
              const { commitGuard: _guard, ...event } = request;
              wakes.committed.push(event);
              return { ok: true };
            },
          },
        } as never,
      });
      const [ok, value, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error?.message ?? "wake failed");
      }
      return value;
    },
  };
});

const { createOpenClawTools } = await import("../agents/openclaw-tools.js");
const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { readScheduledToolTargets } = await import("./execution-context-registry.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");

const PARENT_KEY = "agent:main:dashboard:parent";
const RUN_KEY = "agent:main:cron:job-1:run:s1";
const BASE_JOB = {
  id: "job-1",
  agentId: "main",
  name: "PR babysitter",
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 0,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "check the PR", toolsAllow: ["automations"] },
  delivery: { mode: "none" },
  state: {},
} as unknown as CronStoredJob;
const OWNER_CHILD_JOB = {
  ...BASE_JOB,
  owner: { agentId: "main", sessionKey: PARENT_KEY, accountId: "default" },
  sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" },
  createdActor: { type: "human", source: "profile", id: "owner-profile" },
} as CronStoredJob;

// Real session rows and generation leases live in this state directory.
useWidgetHarness();
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

function seedSessions() {
  wakes.committed = [];
  replaceSessionEntrySync(
    { sessionKey: PARENT_KEY },
    { sessionId: "parent-session", lifecycleRevision: "rev-1", updatedAt: Date.now() },
  );
  replaceSessionEntrySync(
    { sessionKey: RUN_KEY },
    { sessionId: "run-session", updatedAt: Date.now() },
  );
}

// A `/new` reset of the parent conversation through the real lifecycle owner.
async function resetParent() {
  await resetSessionEntryLifecycle({
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    target: { canonicalKey: PARENT_KEY, storeKeys: [PARENT_KEY] },
    buildNextEntry: () => ({
      sessionId: "replacement-session",
      lifecycleRevision: "rev-2",
      updatedAt: Date.now(),
    }),
  });
}

// Admits one occurrence the way cron does and builds the run's automations tool from it.
async function admitRun(
  job: CronStoredJob,
  trigger: { trigger: "cron" } | { trigger: "event"; ingressBoundary: string } = {
    trigger: "cron",
  },
) {
  seedSessions();
  const occurrence = await admitScheduledOccurrence({ cfg: {}, job, agentId: "main", ...trigger });
  const admission = prepareCronRunAdmission({
    cfg: {},
    agentId: "main",
    runId: "run-1",
    sessionKey: RUN_KEY,
    jobId: job.id,
    deliveryAttemptFence: null,
    ...(trigger.trigger === "event" ? { ingressBoundary: trigger.ingressBoundary } : {}),
    scheduledExecution: occurrence.mint({
      cfg: {},
      agentId: "main",
      runId: "run-1",
      runSessionKey: RUN_KEY,
      toolsAllow: ["automations"],
      operatorAuthorityRestored: false,
    }),
  } as Parameters<typeof prepareCronRunAdmission>[0]);
  const admitted = await admission.preparedRunAdmission.admit("embedded");
  const targets = readScheduledToolTargets(admitted);
  const automations = createOpenClawTools({
    agentSessionKey: "agent:main:cron:job-1",
    runSessionKey: RUN_KEY,
    gatewayCallerScheduled: true,
    runtimeToolAllowlist: ["automations"],
    cronSelfRemoveOnlyJobId: job.id,
    ...(targets ? { scheduledToolTargets: targets } : {}),
  }).find((tool) => tool.name === "automations")!;
  return {
    targets,
    automations,
    settle: () => {
      admission.close();
      occurrence.release();
    },
  };
}

const wake = { action: "wake", text: "CI is green", mode: "now" };

it("wakes the parent conversation from an owner's scheduled child", async () => {
  const run = await admitRun(OWNER_CHILD_JOB);
  expect(run.targets?.parentWake?.sessionKey).toBe(PARENT_KEY);
  expect(run.automations.parameters).toHaveProperty(
    "properties.action.enum",
    expect.arrayContaining(["wake"]),
  );
  await run.automations.execute("wake", wake);
  expect(wakes.committed).toEqual([
    { mode: "now", text: "CI is green", sessionKey: PARENT_KEY, agentId: "main" },
  ]);
  run.settle();
});

it("refuses a child's wake that names any other session", async () => {
  const run = await admitRun(OWNER_CHILD_JOB);
  await expect(
    run.automations.execute("wake", { ...wake, sessionKey: "agent:main:dashboard:other" }),
  ).rejects.toThrow("can wake only the conversation that created its automation");
  expect(wakes.committed).toEqual([]);
  run.settle();
});

it("refuses the wake once the parent conversation resets", async () => {
  const run = await admitRun(OWNER_CHILD_JOB);
  await resetParent();
  await expect(run.automations.execute("wake", wake)).rejects.toThrow();
  expect(wakes.committed).toEqual([]);
  run.settle();
});

it("refuses the wake when the parent resets between the tool's check and the commit", async () => {
  const run = await admitRun(OWNER_CHILD_JOB);
  // The reset lands after the tool's own check; the handler's commit guard refuses it.
  const tools = await import("../agents/tools/gateway.js");
  const call = tools.callGatewayTool;
  vi.spyOn(tools, "callGatewayTool").mockImplementation(async (...args) => {
    await resetParent();
    return await call(...args);
  });
  await expect(run.automations.execute("wake", wake)).rejects.toThrow();
  expect(wakes.committed).toEqual([]);
  run.settle();
});

it("refuses the wake from a tool that outlives its settled occurrence", async () => {
  const run = await admitRun(OWNER_CHILD_JOB);
  run.settle();
  await expect(run.automations.execute("wake", wake)).rejects.toThrow();
  expect(wakes.committed).toEqual([]);
});

it.each([
  ["an operator job", BASE_JOB, { trigger: "cron" as const }],
  [
    "a child without a recorded requester",
    { ...OWNER_CHILD_JOB, createdActor: undefined } as CronStoredJob,
    { trigger: "cron" as const },
  ],
  [
    "an event-triggered hook turn",
    OWNER_CHILD_JOB,
    { trigger: "event" as const, ingressBoundary: "gateway.hooks.agent" },
  ],
])("keeps %s self-scoped without wake", async (_name, job, trigger) => {
  const run = await admitRun(job, trigger);
  expect(run.targets).toBeDefined();
  expect(run.targets?.parentWake).toBeUndefined();
  expect(run.automations.parameters).not.toHaveProperty("properties.text");
  await expect(run.automations.execute("wake", wake)).rejects.toThrow(
    "Automations tool is restricted to the current automation.",
  );
  expect(wakes.committed).toEqual([]);
  run.settle();
});
