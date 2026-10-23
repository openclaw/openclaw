import { expect, it, vi } from "vitest";
import type { BoardSessionTarget } from "../boards/board-store.js";
import { useWidgetHarness } from "../canvas/widget-tool.test-support.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import { boardStore } from "../gateway/board-store.js";
import { createBoardHarness } from "../gateway/server-methods/board.test-support.js";
import type { RespondFn } from "../gateway/server-methods/types.js";
import type { CronStoredJob } from "./types.js";

vi.mock("../agents/openclaw-plugin-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: () => [],
}));
// In-process dispatch hands the caller's commit guard to the method, as the Gateway does.
const dispatch = vi.hoisted(() => ({
  call: undefined as
    | ((method: string, params: Record<string, unknown>, guard?: () => void) => Promise<unknown>)
    | undefined,
}));
vi.mock("../agents/tools/in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/tools/in-process-gateway.js")>()),
  callInProcessGatewayTool: (
    method: string,
    params: Record<string, unknown>,
    options?: { sessionMutationCommitGuard?: () => void },
  ) => dispatch.call!(method, params, options?.sessionMutationCommitGuard),
}));

const { createOpenClawTools } = await import("../agents/openclaw-tools.js");
const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { readScheduledToolTargets } = await import("./execution-context-registry.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");
const { resolveGatewayScopedTools } = await import("../gateway/tool-resolution.js");

const PARENT: BoardSessionTarget = { sessionKey: "agent:main:dashboard:parent", agentId: "main" };
const RUN_KEY = "agent:main:cron:job-1:run:s1";
const LINKED_JOB = {
  id: "job-1",
  agentId: "main",
  name: "Board report",
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 0,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "report", toolsAllow: ["dashboard", "show_widget"] },
  delivery: { mode: "none" },
  state: {},
  owner: { agentId: "main", sessionKey: PARENT.sessionKey, accountId: "default" },
  sourceConversation: { sessionKey: PARENT.sessionKey, sessionId: "parent-session" },
} as unknown as CronStoredJob;

// Real session rows, generation leases and board store live in this state directory.
useWidgetHarness();

// Writes the parent conversation and the run session the way the Gateway persists them.
function seedSessions() {
  replaceSessionEntrySync(
    { sessionKey: PARENT.sessionKey },
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
    target: { canonicalKey: PARENT.sessionKey, storeKeys: [PARENT.sessionKey] },
    buildNextEntry: () => ({
      sessionId: "replacement-session",
      lifecycleRevision: "rev-2",
      updatedAt: Date.now(),
    }),
  });
}

// Wires the real board handlers and Gateway board store behind the in-process gateway caller.
function useBoard() {
  const store = boardStore;
  const { handlers, context } = createBoardHarness(undefined, {}, store);
  seedSessions();
  dispatch.call = async (method, params, guard) => {
    const respond = vi.fn<RespondFn>();
    await handlers[method]!({
      req: { type: "req", id: "test", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
      sessionMutationCommitGuard: guard,
    });
    const [ok, value, error] = respond.mock.calls[0]!;
    if (!ok) {
      throw new Error(error?.message ?? `${method} failed`);
    }
    return value;
  };
  return store;
}

// Admits one scheduled occurrence the way cron does and builds the run's tools from it.
async function admitChildRun() {
  const occurrence = await admitScheduledOccurrence({
    cfg: {},
    job: LINKED_JOB,
    agentId: "main",
    trigger: "cron",
  });
  const admission = prepareCronRunAdmission({
    cfg: {},
    agentId: "main",
    runId: "run-1",
    sessionKey: RUN_KEY,
    jobId: "job-1",
    deliveryAttemptFence: null,
    scheduledExecution: occurrence.mint({
      cfg: {},
      agentId: "main",
      runId: "run-1",
      runSessionKey: RUN_KEY,
      toolsAllow: ["dashboard", "show_widget"],
      operatorAuthorityRestored: false,
    }),
  });
  const admitted = await admission.preparedRunAdmission.admit("embedded");
  const tools = createOpenClawTools({
    agentSessionKey: "agent:main:cron:job-1",
    runSessionKey: RUN_KEY,
    gatewayCallerScheduled: true,
    runtimeToolAllowlist: ["dashboard", "show_widget"],
    scheduledToolTargets: readScheduledToolTargets(admitted),
  });
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
  return {
    admitted,
    dashboard: tool("dashboard"),
    widget: tool("show_widget"),
    settle: () => {
      admission.close();
      occurrence.release();
    },
  };
}

const createTab = { action: "tab_create", tabId: "report", title: "Report" };
const pinReport = { title: "Status", widget_code: "<p>ready</p>", pin: true };

it("authors the parent's board while the parent conversation is current", async () => {
  const store = useBoard();
  const run = await admitChildRun();
  await run.dashboard.execute("tab", createTab);
  await run.widget.execute("pin", pinReport);
  const board = await store.getSnapshot(PARENT);
  expect(board.tabs.map((tab) => tab.tabId)).toContain("report");
  expect(board.widgets.map((widget) => widget.title)).toEqual(["Status"]);
  const runBoard = await store.getSnapshot({ sessionKey: RUN_KEY, agentId: "main" });
  expect(runBoard.tabs.map((tab) => tab.tabId)).not.toContain("report");
  expect(runBoard.widgets).toEqual([]);
  run.settle();
});

it("keeps the run session's board for a run admitted without a context", async () => {
  const store = useBoard();
  const dashboard = createOpenClawTools({
    agentSessionKey: "agent:main:cron:job-1",
    runSessionKey: RUN_KEY,
    gatewayCallerScheduled: true,
    runtimeToolAllowlist: ["dashboard"],
  }).find((tool) => tool.name === "dashboard")!;
  await dashboard.execute("tab", createTab);
  const tabsOf = async (sessionKey: string) =>
    (await store.getSnapshot({ sessionKey, agentId: "main" })).tabs.map((tab) => tab.tabId);
  expect(await tabsOf(RUN_KEY)).toContain("report");
  expect(await tabsOf(PARENT.sessionKey)).not.toContain("report");
});

it("refuses board writes after the parent resets mid-run", async () => {
  const store = useBoard();
  const run = await admitChildRun();
  const before = await store.getSnapshot(PARENT);
  await resetParent();
  await expect(run.dashboard.execute("tab", createTab)).rejects.toThrow();
  await expect(run.widget.execute("pin", pinReport)).rejects.toThrow();
  expect(await store.getSnapshot(PARENT)).toEqual(before);
  run.settle();
});

it("refuses a write when the parent resets between the tool's check and the commit", async () => {
  const store = useBoard();
  const run = await admitChildRun();
  const before = await store.getSnapshot(PARENT);
  const applyOps = store.applyOps.bind(store);
  vi.spyOn(store, "applyOps").mockImplementation(async (...args) => {
    await resetParent();
    return await applyOps(...args);
  });
  await expect(run.dashboard.execute("tab", createTab)).rejects.toThrow();
  expect(await store.getSnapshot(PARENT)).toEqual(before);
  run.settle();
});

it("refuses writes from tools that outlive their settled occurrence", async () => {
  const store = useBoard();
  const run = await admitChildRun();
  const before = await store.getSnapshot(PARENT);
  run.settle();
  await expect(run.dashboard.execute("tab", createTab)).rejects.toThrow();
  await expect(run.widget.execute("pin", pinReport)).rejects.toThrow();
  expect(await store.getSnapshot(PARENT)).toEqual(before);
});

it("offers a CLI child pinned authoring on its parent's board through the loopback", async () => {
  const store = useBoard();
  const run = await admitChildRun();
  // The CLI MCP loopback resolves the run's tools from its grant: the admitted run and its tool cap.
  const scoped = await resolveGatewayScopedTools({
    cfg: {},
    sessionKey: RUN_KEY,
    senderIsOwner: false,
    surface: "loopback",
    admittedRunContext: run.admitted,
    toolsAllow: ["dashboard", "show_widget"],
  });
  const widget = scoped.tools.find((tool) => tool.name === "show_widget");
  expect(widget?.parameters).toMatchObject({ properties: { pin: { const: true } } });
  await widget!.execute("pin", pinReport);
  expect((await store.getSnapshot(PARENT)).widgets.map((entry) => entry.title)).toEqual(["Status"]);
  // After a real parent reset the same CLI tool refuses, leaving the parent board unchanged.
  await resetParent();
  await expect(
    widget!.execute("pin-after-reset", { ...pinReport, title: "Late" }),
  ).rejects.toThrow();
  expect((await store.getSnapshot(PARENT)).widgets.map((entry) => entry.title)).toEqual(["Status"]);
  // Without the grant's cap the scheduled run keeps the inline-client requirement.
  const uncapped = await resolveGatewayScopedTools({
    cfg: {},
    sessionKey: RUN_KEY,
    senderIsOwner: false,
    surface: "loopback",
    admittedRunContext: run.admitted,
  });
  expect(uncapped.tools.find((tool) => tool.name === "show_widget")?.parameters).not.toMatchObject({
    properties: { pin: { const: true } },
  });
  run.settle();
});
