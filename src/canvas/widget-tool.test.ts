import { access, readdir } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createDashboardTool } from "../agents/tools/dashboard-tool.js";
import * as gateway from "../agents/tools/in-process-gateway.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import type { BoardReport } from "../boards/board-report.js";
import { readBoardHtml, createTestBoardStore } from "../boards/board-store.test-support.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.js";
import { createBoardHandlers } from "../gateway/server-methods/board.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { readCanvasDocumentHtmlSource, resolveCanvasDocumentsDir } from "./documents.js";
import {
  asGatewayCaller,
  createBoardPutCaller,
  currentPresenter,
  useWidgetHarness,
  runWidget as run,
  widgetPayload as payload,
  widget,
  type WidgetToolOptions,
} from "./widget-tool.test-support.js";
import { buildWidgetDocument } from "./wrap.js";

const WIDGET_HTML_MAX_UTF8_BYTES = 10 * 1024 * 1024;
const WIDGET_MAX_PER_SCOPE = 32;
const harness = useWidgetHarness();
const { createTool, documentDir, expectNoDocument } = harness;

function createLiveBoardCaller(
  store: ReturnType<typeof createTestBoardStore>,
  broadcast = vi.fn(),
  cfg: OpenClawConfig = { agents: { entries: { main: {} } } },
): InProcessGatewayCaller {
  const handlers = createBoardHandlers(store);
  const context = {
    broadcast,
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    getRuntimeConfig: () => cfg,
  } as unknown as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  const callGateway = asGatewayCaller(async (method, params) => {
    const respond = vi.fn<RespondFn>();
    await handlers[method]!({
      req: { type: "req", id: "show-widget", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });
    return respond;
  });
  vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(callGateway);
  return callGateway;
}

const failingPresenter = () =>
  currentPresenter(async () => ({
    ok: false,
    error: { code: "presentation_error", message: "delivery rejected" },
  }));

async function executeWidget({
  agentId = "main",
  agentSessionKey,
  presenters,
  title = "Widget title",
  widgetCode,
  ...input
}: Pick<WidgetToolOptions, "agentId" | "agentSessionKey" | "presenters"> & {
  title?: string;
  widgetCode: string;
  pin?: boolean;
  name?: string;
  tab?: string;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  presentation?: {
    target?: "assistant_message" | "node_panel";
    frame?: "card" | "full-bleed" | "frameless";
  };
  capabilities?: { netOrigins?: string[]; tools?: string[] };
}) {
  const tool = createTool({ sessionId: "widget-session", agentId, agentSessionKey, presenters });
  const result = await tool.execute("widget-call", { title, widget_code: widgetCode, ...input });
  const parsed = payload(result) as {
    kind?: string;
    presentation?: { target?: string; title?: string; sandbox?: string };
    view?: { id?: string; url?: string; boardWidgetName?: string };
    text?: string;
  };
  const viewId = parsed.view?.id;
  const url = parsed.view?.url;
  if (parsed.kind !== "canvas" || !viewId || !url) {
    throw new Error("expected canvas preview handle");
  }
  return { ...parsed, view: { ...parsed.view, id: viewId, url } };
}

const pinner =
  (agentSessionKey = "agent:main:pinned") =>
  (title: string, widgetCode: string) =>
    executeWidget({ agentSessionKey, title, widgetCode, pin: true });

it("uses board-only delivery when inline hosting is disabled", async () => {
  createBoardPutCaller();
  const tool = createTool({ agentSessionKey: "agent:main:board-only", inlineHostEnabled: false });

  await expect(run(tool)).rejects.toThrow(
    "inline widget hosting is disabled; set pin=true to place the widget on the session dashboard",
  );
  await expectNoDocument();

  expect(payload(await run(tool, { pin: true }))).toMatchObject({
    status: "pinned",
    boardWidgetName: "status",
  });
  await expectNoDocument();
});

it("routes node-panel presentation and reports the selected device", async () => {
  let hostedUrl: string | undefined;
  const result = await executeWidget({
    title: "Status",
    widgetCode: "<p>ready</p>",
    agentSessionKey: "agent:main:status",
    presentation: { target: "node_panel" },
    presenters: [
      {
        target: "node_panel",
        description: "Show on a connected device panel",
        availability: async (context) => {
          expect(context).toEqual({ sessionKey: "agent:main:status" });
          return { ok: true, value: { available: true } };
        },
        present: async ({ document }) => {
          hostedUrl = document.hostedUrl;
          expect(document.html).toContain("<p>ready</p>");
          return { ok: true, value: { kind: "node", nodeId: "mac-panel", nodeName: "Studio" } };
        },
      },
    ],
  });

  expect(hostedUrl).toBe(result.view.url);
  expect(result).toMatchObject({
    presentation: { target: "node_panel" },
    text: expect.stringContaining("presented on Studio (mac-panel)"),
  });
});

it.each([false, true])(
  "falls back inline when node presenter exists=%s but cannot present",
  async (registered) => {
    const unavailable: WidgetPresenter = {
      target: "node_panel",
      description: "Unavailable panel",
      availability: async () => ({
        ok: false,
        error: { code: "no_eligible_node", message: "No connected device." },
      }),
      present: async () => {
        throw new Error("present must not run");
      },
    };
    const result = await executeWidget({
      widgetCode: "<p>inline fallback</p>",
      presentation: { target: "node_panel" },
      presenters: registered ? [unavailable] : [],
    });

    expect(result).toMatchObject({
      presentation: { target: "assistant_message" },
      text: expect.stringContaining(
        registered ? "No connected device." : "No widget presenter is registered",
      ),
    });
    expect(result.text).toContain("available inline here");
    expect(result.text).toMatch(
      /Pair a canvas-capable device|Retry the requested presentation destination/u,
    );
    await access(documentDir(result.view.id));
  },
);

it("enforces current-presenter source kinds and byte limits in core", async () => {
  const presenter = currentPresenter(
    async () => {
      throw new Error("present must not run");
    },
    { capabilities: { sourceKinds: ["html"], maxSourceBytes: 8 } },
  );
  const tool = createTool({
    inlineClientAvailable: false,
    presenters: [presenter],
    presenterContext: {},
  });
  expect(tool.parameters).toHaveProperty("properties.kind.enum", ["html"]);
  await expect(run(tool, { widget_code: "123456789" })).rejects.toThrow(
    "widget_code exceeds maximum size (8 bytes)",
  );
  await expect(run(tool, { kind: "diagram" })).rejects.toThrow(
    'Unsupported widget kind "diagram"; use kind "html"',
  );
});

it("fails visibly without inline fallback and uses a real inline route when available", async () => {
  const options = { presenters: [failingPresenter()], presenterContext: {} };
  const noInline = createTool({ ...options, inlineClientAvailable: false });
  await expect(noInline.execute("no-inline", widget)).rejects.toThrow(
    "Widget presentation failed: delivery rejected",
  );

  const withInline = createTool(options);
  expect(payload(await run(withInline))).toMatchObject({
    kind: "canvas",
    presentation: { target: "assistant_message" },
    text: expect.stringContaining("delivery rejected. The widget is available inline here."),
  });
});

it("reports pin success and presentation failure as an explicit partial outcome", async () => {
  createBoardPutCaller();
  const tool = createTool({
    agentSessionKey: "agent:main:partial",
    inlineClientAvailable: false,
    presenters: [failingPresenter()],
    presenterContext: {},
  });
  expect(payload(await run(tool, { pin: true }))).toMatchObject({
    status: "partial",
    boardWidgetName: "status",
    presentation: {
      target: "current_channel",
      status: "failed",
      error: { code: "presentation_error", message: "delivery rejected" },
    },
    text: expect.stringContaining(
      "pinned to dashboard tab main as status, but presentation failed",
    ),
  });
});

it.each([
  ["empty code", { widget_code: "   " }, "widget_code required"],
  [
    "oversized code",
    { widget_code: "x".repeat(WIDGET_HTML_MAX_UTF8_BYTES + 1) },
    `widget_code exceeds maximum size (${WIDGET_HTML_MAX_UTF8_BYTES} bytes)`,
  ],
  ["pinning without a session", { pin: true }, "pin requires an agent session"],
  [
    "unpinned capabilities",
    { capabilities: { netOrigins: ["https://api.open-meteo.com"] } },
    "capabilities require pin=true",
  ],
] satisfies Array<[string, Record<string, unknown>, string]>)(
  "rejects %s before materializing a document",
  async (_label, args, error) => {
    await expect(run(createTool(), args)).rejects.toThrow(error);
    await expectNoDocument();
  },
);

it.each([true, false])(
  "rejects multibyte input over the wrapped UTF-8 budget (pin=%s)",
  async (pin) => {
    const callGateway = vi.fn();
    vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(callGateway);
    const title = "Multibyte";
    const wrapperBytes = Buffer.byteLength(buildWidgetDocument(title, ""), "utf8");
    const widgetCode = "é".repeat(Math.floor((WIDGET_HTML_MAX_UTF8_BYTES - wrapperBytes) / 2) + 1);
    expect(Buffer.byteLength(widgetCode, "utf8")).toBeLessThan(WIDGET_HTML_MAX_UTF8_BYTES);
    expect(Buffer.byteLength(buildWidgetDocument(title, widgetCode), "utf8")).toBeGreaterThan(
      WIDGET_HTML_MAX_UTF8_BYTES,
    );
    const tool = createTool({
      sessionId: "wrapped-budget",
      agentSessionKey: "agent:main:wrapped-budget",
    });

    await expect(tool.execute("pin", { title, widget_code: widgetCode, pin })).rejects.toThrow(
      pin
        ? `pin exceeds effective dashboard budget (${WIDGET_HTML_MAX_UTF8_BYTES} UTF-8 bytes after wrapping)`
        : `widget document after wrapping exceeds maximum size (${WIDGET_HTML_MAX_UTF8_BYTES} bytes)`,
    );
    expect(callGateway).not.toHaveBeenCalled();
    await expectNoDocument();
  },
);

it("does not create an inline Canvas document when dashboard pinning fails", async () => {
  const callGateway = vi.fn(async () => {
    throw new Error("board tab not found: missing");
  });
  vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(callGateway);

  await expect(
    executeWidget({
      agentSessionKey: "agent:main:failed-pin",
      widgetCode: "<p>never materialized</p>",
      pin: true,
      tab: "missing",
    }),
  ).rejects.toThrow("board tab not found: missing");
  expect(callGateway).toHaveBeenCalledOnce();
  await expectNoDocument();
});

it.each([
  ["Research global with retained Main", "global", "research", true],
  ["large HTML", "agent:main:large-widget", "main", false],
] as const)(
  "creates and refreshes pinned HTML in %s",
  async (_label, sessionKey, agentId, retainedMain) => {
    const store = createTestBoardStore({ stateDir: harness.stateDir });
    const broadcast = vi.fn();
    const target = { sessionKey, agentId };
    const sibling = { sessionKey: "global", agentId: agentId === "main" ? "research" : "main" };
    const siblingBefore = await store.getSnapshot(sibling);
    const boardBroadcastScope = { sessionKeys: [sessionKey], agentId };
    const eventSessionKey = sessionKey === "global" ? `agent:${agentId}:global` : sessionKey;
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      session: { scope: "global" },
    };
    if (retainedMain) {
      retainLegacyDefaultAgentId(cfg, "main");
    }
    const callGateway = createLiveBoardCaller(store, broadcast, cfg);
    const title = "Release Status ".repeat(8).trim();

    const pinWidget = (widgetCode: string, withPlacement = false) =>
      executeWidget({
        agentId,
        agentSessionKey: sessionKey,
        title,
        widgetCode,
        pin: true,
        name: "release-status",
        ...(withPlacement
          ? { tab: "main", size: "lg" as const, presentation: { frame: "frameless" as const } }
          : {}),
      });
    const initialHtml =
      _label === "large HTML" ? `<p>${"é".repeat(2 * 1024 * 1024)}</p>` : "<p>ready</p>";
    const result = await pinWidget(initialHtml, true);
    const pinnedTitle = Array.from(title).slice(0, 80).join("");

    const expectPinned = async (source: string, revision: number) => {
      expect(await readBoardHtml(store, target, "release-status")).toMatchObject({
        html: buildWidgetDocument(pinnedTitle, source),
        revision,
      });
      expect(broadcast).toHaveBeenCalledWith(
        "board.changed",
        { sessionKey: eventSessionKey, revision, widget: "release-status" },
        boardBroadcastScope,
      );
    };
    await expectPinned(initialHtml, 1);
    expect((await store.getSnapshot(target)).widgets[0]).toMatchObject({
      title: pinnedTitle,
      presentation: "frameless",
    });
    expect(result.text).toContain("pinned to dashboard tab main as release-status (lg)");
    expect(result.view.boardWidgetName).toBe("release-status");
    expect((await readCanvasDocumentHtmlSource(result.view.id)).html).toContain(initialHtml);

    await expect(
      callGateway("board.widget.put", {
        ...target,
        name: "release-status",
        content: { kind: "plugin", pluginKind: "workboard:card" },
      }),
    ).rejects.toThrow(/same content kind.*remove/i);
    expect((await readBoardHtml(store, target, "release-status"))?.revision).toBe(1);

    const refreshed = await pinWidget("<p>refreshed</p>");

    await expectPinned("<p>refreshed</p>", 2);
    expect(refreshed.view.boardWidgetName).toBe("release-status");
    expect(await store.getSnapshot(sibling)).toEqual(siblingBefore);
  },
);

it("hosts sandboxed SVG and keeps pinned network grants out of its inline preview", async () => {
  const store = createTestBoardStore({ stateDir: harness.stateDir });
  createLiveBoardCaller(store);
  const result = await executeWidget({
    agentSessionKey: "agent:main:weather",
    title: "Weather",
    widgetCode: '  <SvG viewBox="0 0 10 10"><circle r="4" /></SvG>  ',
    pin: true,
    capabilities: { netOrigins: ["https://api.open-meteo.com"], tools: ["health", "prompt"] },
  });
  expect(result.view.id).toMatch(/^cv_[a-f0-9]{32}$/);
  expect(result.view.url).toBe(`/__openclaw__/canvas/documents/${result.view.id}/index.html`);
  expect(result.presentation).toEqual({
    target: "assistant_message",
    title: "Weather",
    sandbox: "scripts",
  });
  const { html: inlineHtml, cspSandbox } = await readCanvasDocumentHtmlSource(result.view.id);
  expect(cspSandbox).toBe("scripts");
  expect(inlineHtml).toContain('<body class="svg-widget"><script>');
  const pinned = await readBoardHtml(store, { sessionKey: "agent:main:weather" }, "weather");

  expect(inlineHtml).toContain("connect-src 'none'");
  expect(pinned).toMatchObject({
    grantState: "granted",
    declared: { netOrigins: ["https://api.open-meteo.com"], tools: ["health", "prompt"] },
  });
  expect(pinned && "html" in pinned ? pinned.html : "").toContain(
    "connect-src https://api.open-meteo.com",
  );
});

it("keeps generated pin names distinct when titles cannot fit a plain slug", async () => {
  createBoardPutCaller();
  const pinWidget = pinner();
  const unicodeA = await pinWidget("状态", "<p>one</p>");
  const unicodeB = await pinWidget("天气", "<p>two</p>");
  const longA = await pinWidget(`${"shared ".repeat(20)}alpha`, "<p>three</p>");
  const longB = await pinWidget(`${"shared ".repeat(20)}beta`, "<p>four</p>");

  expect(unicodeA.view.boardWidgetName).toMatch(/^widget-[a-f0-9]{8}$/u);
  expect(unicodeB.view.boardWidgetName).toMatch(/^widget-[a-f0-9]{8}$/u);
  expect(unicodeA.view.boardWidgetName).not.toBe(unicodeB.view.boardWidgetName);
  expect(longA.view.boardWidgetName).not.toBe(longB.view.boardWidgetName);
  expect(longA.view.boardWidgetName).toHaveLength(64);
  expect(longB.view.boardWidgetName).toHaveLength(64);
});

it("keeps colliding generated pins distinct and canonical spellings stable", async () => {
  const store = createTestBoardStore({ stateDir: harness.stateDir });
  const sessionKey = "agent:main:generated-collision";
  createLiveBoardCaller(store);
  const pinWidget = pinner(sessionKey);
  const [slash, plus] = await Promise.all([
    pinWidget("Revenue / Cost", "<p>slash</p>"),
    pinWidget("Revenue + Cost", "<p>plus</p>"),
  ]);
  expect(new Set([slash.view.boardWidgetName, plus.view.boardWidgetName]).size).toBe(2);
  expect((await store.getSnapshot({ sessionKey })).widgets).toHaveLength(2);

  const composed = await pinWidget("Café Menu".normalize("NFC"), "<p>one</p>");
  const decomposed = await pinWidget("Café Menu".normalize("NFD"), "<p>two</p>");
  expect(decomposed.view.boardWidgetName).toBe(composed.view.boardWidgetName);
  expect(
    await readBoardHtml(store, { sessionKey }, composed.view.boardWidgetName ?? ""),
  ).toMatchObject({ revision: 2 });
});

it("uses opaque ids and evicts the oldest widget within a session scope", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-07T00:00:00.000Z"));
  const first = await executeWidget({ widgetCode: "<p>0</p>" });
  expect(first.text).toBe(`Widget hosted at ${first.view.url}`);
  for (let index = 1; index <= WIDGET_MAX_PER_SCOPE; index += 1) {
    vi.setSystemTime(new Date(`2026-07-07T00:00:${String(index).padStart(2, "0")}.000Z`));
    await executeWidget({ widgetCode: `<p>${index}</p>` });
  }

  await expect(access(documentDir(first.view.id))).rejects.toThrow();
  const entries = await readdir(resolveCanvasDocumentsDir(harness.stateDir));
  expect(entries).toHaveLength(WIDGET_MAX_PER_SCOPE);
});

const createReportTool = (options: WidgetToolOptions = {}) =>
  createTool({ agentSessionKey: "agent:main:report", ...options });
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

it("pins, updates and reopens a report for a global agent without a document", async () => {
  const target = { sessionKey: "global", agentId: "research" };
  const name = "community-pulse";
  const store = createTestBoardStore({ stateDir: harness.stateDir });
  const sibling = { sessionKey: "global", agentId: "main" };
  const siblingBefore = await store.getSnapshot(sibling);
  const callGateway = createLiveBoardCaller(store, vi.fn(), {
    agents: { ownership: "explicit", entries: { main: {}, research: {} } },
  });
  const tool = createReportTool({ agentSessionKey: target.sessionKey, agentId: target.agentId });
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
  const snapshot = await callGateway<{ widgets: Array<Record<string, unknown>> }>(
    "board.get",
    target,
  );
  expect(snapshot.widgets[0]).toMatchObject({
    pluginKind: "session:report",
    props: updated,
    revision: 2,
  });
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
  const tool = createReportTool();
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
  const tool = createReportTool();
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
  expect(mock.mock.calls[0]).toMatchObject([
    "board.widget.put",
    { content: { kind: "html", html: "<main>dashboard</main>" } },
  ]);
});
