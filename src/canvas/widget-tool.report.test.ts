import { expect, it, vi } from "vitest";
import { createDashboardTool } from "../agents/tools/dashboard-tool.js";
import * as gateway from "../agents/tools/in-process-gateway.js";
import type { BoardReport } from "../boards/board-report.js";
import { readBoardHtml, createTestBoardStore } from "../boards/board-store.test-support.js";
import { createBoardHarness } from "../gateway/server-methods/board.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { registerTestWidgetContentKind } from "./widget-tool.content-kinds.test-support.js";
import {
  asGatewayCaller,
  createBoardPutCaller,
  useWidgetHarness,
} from "./widget-tool.test-support.js";

const harness = useWidgetHarness();
const { expectNoDocument } = harness;
const createTool = (options: Parameters<typeof harness.createTool>[0] = {}) =>
  harness.createTool({ agentSessionKey: "agent:main:report", ...options });
const copies = <T>(length: number, make: () => T) => Array.from({ length }, make);
const report: BoardReport = {
  blocks: [
    { type: "text", title: "Community pulse", text: "Activity is steady." },
    { type: "metrics", items: [{ label: "Authors", value: "312", detail: "This week" }] },
    { type: "table", columns: ["Topic", "Threads"], rows: [["Support", "160"]] },
    { type: "chart", style: "line", points: [{ label: "Mon", value: 12 }] },
    { type: "links", items: [{ label: "Details", url: "https://example.com/details" }] },
  ],
};

it("preserves plugin source kinds named report alongside native report data", async () => {
  registerTestWidgetContentKind("report");
  const { mock } = createBoardPutCaller();
  const tool = createTool();
  const result = await tool.execute("registered-report", {
    title: "Plugin report",
    kind: "report",
    widget_code: "diagram:ready",
    pin: true,
  });
  expect(result.details).toMatchObject({ kind: "canvas", view: { id: expect.any(String) } });
  expect(mock).toHaveBeenCalledWith(
    "board.widget.put",
    expect.objectContaining({
      content: { kind: "registered", contentKind: "report", source: "diagram:ready" },
    }),
  );
});

it("pins, updates and reopens a report for a global agent without a document", async () => {
  const target = { sessionKey: "global", agentId: "research" };
  const name = "community-pulse";
  const store = createTestBoardStore({ stateDir: harness.stateDir });
  const sibling = { sessionKey: "global", agentId: "main" };
  const siblingBefore = await store.getSnapshot(sibling);
  const { invoke } = createBoardHarness(undefined, {}, store, {
    getRuntimeConfig: () => ({
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
    }),
  });
  const callGateway = asGatewayCaller(invoke);
  vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(callGateway);
  const tool = createTool({
    agentSessionKey: target.sessionKey,
    agentId: target.agentId,
  });
  const result = await tool.execute("create-report", {
    title: "Community pulse",
    name,
    pin: true,
    report,
  });
  expect(result.details).toMatchObject({ status: "pinned", boardWidgetName: name });
  expect((await store.getSnapshot(target)).widgets[0]).toMatchObject({
    name,
    contentKind: "plugin",
    contentOwner: "plugin",
    pluginKind: "session:report",
    props: report,
    grantState: "none",
    revision: 1,
  });
  const updated = { blocks: [{ type: "text", text: "Refreshed from the agent." }] };
  await createDashboardTool({
    agentSessionKey: target.sessionKey,
    agentId: target.agentId,
  }).execute("update-report", {
    action: "widget_put",
    name,
    pluginKind: "session:report",
    props: updated,
  });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  expect((await store.getSnapshot(target)).widgets[0]).toMatchObject({
    props: updated,
    revision: 2,
  });
  const view = await invoke("board.get", target);
  expect(view.mock.calls[0]?.[0]).toBe(true);
  const snapshot = view.mock.calls[0]?.[1] as { widgets: Array<Record<string, unknown>> };
  expect(snapshot.widgets[0]).toMatchObject({ pluginKind: "session:report", props: updated });
  expect(snapshot.widgets[0]).not.toHaveProperty("frameUrl");
  expect(snapshot.widgets[0]).not.toHaveProperty("viewTicket");
  expect(await readBoardHtml(store, target, name)).toBeUndefined();
  expect(await store.getSnapshot(sibling)).toEqual(siblingBefore);
  await expectNoDocument();
});

it.each([
  ["executable fields", [{ type: "text", text: "Hello", script: "ignored" }]],
  ["unsupported blocks", [{ type: "image", url: "https://example.com/image.png" }]],
  ["script links", [{ type: "links", items: [{ label: "Invalid", url: "javascript:void(0)" }] }]],
  ["mismatched table rows", [{ type: "table", columns: ["A", "B"], rows: [["one"]] }]],
  ["too many points", [{ type: "chart", points: copies(41, () => ({ label: "A", value: 1 })) }]],
  ["oversized UTF-8 data", copies(3, () => ({ type: "text", text: "é".repeat(2_000) }))],
])("rejects %s without changing the saved report", async (_label, blocks) => {
  const store = createTestBoardStore();
  const target = { sessionKey: "agent:main:report" };
  const content = { kind: "plugin" as const, pluginKind: "session:report", props: report };
  await store.putWidget({ ...target, name: "report", content });
  const before = await store.getSnapshot(target);
  await expect(
    store.putWidget({ ...target, name: "report", content: { ...content, props: { blocks } } }),
  ).rejects.toThrow();
  expect(await store.getSnapshot(target)).toEqual(before);
});

it("rejects report capabilities before any write", async () => {
  const callGateway = vi.fn();
  vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(callGateway);
  const tool = createTool();
  await expect(
    tool.execute("invalid-report", {
      title: "Report",
      report,
      pin: true,
      capabilities: { tools: ["prompt"] },
    }),
  ).rejects.toThrow("Reports require pin=true");
  expect(callGateway).not.toHaveBeenCalled();
});

it("accepts HTML widget payload when report is an empty object", async () => {
  const { mock } = createBoardPutCaller();
  const tool = createTool();
  const result = await tool.execute("empty-report-with-html", {
    title: "SaaS Operations",
    pin: true,
    report: {},
    widget_code: "<main>dashboard</main>",
    kind: "html",
    capabilities: {},
    presentation: { target: "assistant_message", frame: "card" },
  });
  expect(result.details).toMatchObject({
    kind: "canvas",
    view: { boardWidgetName: "saas-operations" },
  });
  expect(mock).toHaveBeenCalledWith(
    "board.widget.put",
    expect.objectContaining({
      content: expect.objectContaining({ kind: "html", html: "<main>dashboard</main>" }),
    }),
  );
});
