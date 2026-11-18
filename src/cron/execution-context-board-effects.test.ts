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
import { makeCronJob } from "./delivery.test-helpers.js";
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
const TOOLS = ["dashboard", "show_widget"];
const LINKED_JOB = {
  ...makeCronJob({}),
  agentId: "main",
  createdAtMs: 0,
  updatedAtMs: 0,
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "report", toolsAllow: TOOLS },
  delivery: { mode: "none" },
  owner: { agentId: "main", sessionKey: PARENT.sessionKey, accountId: "default" },
  sourceConversation: { sessionKey: PARENT.sessionKey, sessionId: "parent-session" },
} as unknown as CronStoredJob;

useWidgetHarness();

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
      toolsAllow: TOOLS,
    }),
  });
  const admitted = await admission.preparedRunAdmission.admit("embedded");
  const tools = createOpenClawTools({
    agentSessionKey: "agent:main:cron:job-1",
    runSessionKey: RUN_KEY,
    gatewayCallerScheduled: true,
    runtimeToolAllowlist: TOOLS,
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
const boardTarget = (sessionKey: string) => ({ sessionKey, agentId: "main" });
const widgetTitles = async () =>
  (await boardStore.getSnapshot(PARENT)).widgets.map((entry) => entry.title);
const scopedTools = (
  admittedRunContext: Awaited<ReturnType<typeof admitChildRun>>["admitted"],
  toolsAllow?: string[],
) =>
  resolveGatewayScopedTools({
    cfg: {},
    sessionKey: RUN_KEY,
    senderIsOwner: false,
    surface: "loopback",
    admittedRunContext,
    toolsAllow,
  });

it("authors the parent's board while the parent conversation is current", async () => {
  const store = useBoard();
  const run = await admitChildRun();
  await run.dashboard.execute("tab", createTab);
  await run.widget.execute("pin", pinReport);
  const board = await store.getSnapshot(PARENT);
  expect(board.tabs.map((tab) => tab.tabId)).toContain("report");
  expect(board.widgets.map((widget) => widget.title)).toEqual(["Status"]);
  const runBoard = await store.getSnapshot(boardTarget(RUN_KEY));
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
    (await store.getSnapshot(boardTarget(sessionKey))).tabs.map((tab) => tab.tabId);
  expect(await tabsOf(RUN_KEY)).toContain("report");
  expect(await tabsOf(PARENT.sessionKey)).not.toContain("report");
});

it.each(["parent reset", "reset at commit", "settled occurrence"] as const)(
  "refuses board writes after %s",
  async (revocation) => {
    const store = useBoard();
    const run = await admitChildRun();
    const before = await store.getSnapshot(PARENT);
    if (revocation === "parent reset") {
      await resetParent();
    } else if (revocation === "reset at commit") {
      const applyOps = store.applyOps.bind(store);
      vi.spyOn(store, "applyOps").mockImplementation(async (...args) => {
        await resetParent();
        return await applyOps(...args);
      });
    } else {
      run.settle();
    }
    await expect(run.dashboard.execute("tab", createTab)).rejects.toThrow();
    if (revocation !== "reset at commit") {
      await expect(run.widget.execute("pin", pinReport)).rejects.toThrow();
    }
    expect(await store.getSnapshot(PARENT)).toEqual(before);
    if (revocation !== "settled occurrence") {
      run.settle();
    }
  },
);

it("offers a CLI child pinned authoring on its parent's board through the loopback", async () => {
  useBoard();
  const run = await admitChildRun();
  // The CLI MCP loopback resolves the run's tools from its grant: the admitted run and its tool cap.
  const scoped = await scopedTools(run.admitted, TOOLS);
  const widget = scoped.tools.find((tool) => tool.name === "show_widget");
  expect(widget?.parameters).toMatchObject({ properties: { pin: { const: true } } });
  await widget!.execute("pin", pinReport);
  expect(await widgetTitles()).toEqual(["Status"]);
  // After a real parent reset the same CLI tool refuses, leaving the parent board unchanged.
  await resetParent();
  await expect(
    widget!.execute("pin-after-reset", { ...pinReport, title: "Late" }),
  ).rejects.toThrow();
  expect(await widgetTitles()).toEqual(["Status"]);
  // Without the grant's cap the scheduled run keeps the inline-client requirement.
  const uncapped = await scopedTools(run.admitted);
  expect(uncapped.tools.find((tool) => tool.name === "show_widget")?.parameters).not.toMatchObject({
    properties: { pin: { const: true } },
  });
  run.settle();
});
