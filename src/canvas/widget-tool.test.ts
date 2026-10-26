import { access, readFile, readdir } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import * as gateway from "../agents/tools/in-process-gateway.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { readBoardHtml, createTestBoardStore } from "../boards/board-store.test-support.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.js";
import { createBoardHandlers } from "../gateway/server-methods/board.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
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
const { createTool, documentDir, documentFile, expectNoDocument } = harness;

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

const html = { title: "Diagram", widget_code: "<p>ready</p>", kind: "html" };
const failingPresenter = () =>
  currentPresenter(async () => ({
    ok: false,
    error: { code: "presentation_error", message: "delivery rejected" },
  }));

async function executeWidget(
  params: Pick<WidgetToolOptions, "agentId" | "agentSessionKey" | "presenters"> & {
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
  },
) {
  const {
    agentId = "main",
    agentSessionKey,
    presenters,
    title = "Widget title",
    widgetCode,
    ...input
  } = params;
  const tool = createTool({
    sessionId: "widget-session",
    agentId,
    agentSessionKey,
    presenters,
  });
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
  return {
    viewId,
    url,
    resultText: parsed.text,
    boardWidgetName: parsed.view?.boardWidgetName,
    target: parsed.presentation?.target,
    parsed,
  };
}

function pinner(agentSessionKey = "agent:main:pinned") {
  return (title: string, widgetCode: string) =>
    executeWidget({ agentSessionKey, title, widgetCode, pin: true });
}

it("uses board-only delivery when inline hosting is disabled", async () => {
  const { mock: callGatewayMock } = createBoardPutCaller();
  const tool = createTool({
    agentSessionKey: "agent:main:board-only",
    inlineHostEnabled: false,
  });

  expect(tool.description).toContain(
    "Inline previews are unavailable this turn; set pin=true to save to the session dashboard",
  );
  expect(tool.description).not.toContain("Keep one-off visualizations inline");
  await expect(tool.execute("unpinned", html)).rejects.toThrow(
    "inline widget hosting is disabled; set pin=true to place the widget on the session dashboard",
  );
  await expectNoDocument();

  const result = await tool.execute("pinned", { ...html, pin: true });
  expect(payload(result)).toEqual({
    status: "pinned",
    boardWidgetName: "diagram",
    capabilityState: "none",
    text: "Widget pinned to dashboard tab main as diagram. Open this dashboard tab in Control UI to view it.",
  });
  expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(
    "board.widget.put",
    expect.objectContaining({
      content: { kind: "html", html: "<p>ready</p>" },
    }),
  );
  await expectNoDocument();
});

it("routes node-panel presentation and reports the selected device", async () => {
  const availability = vi.fn(async () => ({
    ok: true as const,
    value: { available: true as const },
  }));
  const present = vi.fn(async () => ({
    ok: true as const,
    value: { kind: "node" as const, nodeId: "mac-panel", nodeName: "Studio" },
  }));
  const result = await executeWidget({
    title: "Status",
    widgetCode: "<p>ready</p>",
    agentSessionKey: "agent:main:status",
    presentation: { target: "node_panel" },
    presenters: [
      {
        target: "node_panel",
        description: "Show on a connected device panel",
        availability,
        present,
      },
    ],
  });

  expect(result).toMatchObject({
    target: "node_panel",
    resultText: expect.stringContaining("presented on Studio (mac-panel)"),
  });
  expect(availability).toHaveBeenCalledWith({ sessionKey: "agent:main:status" });
  expect(present).toHaveBeenCalledWith({
    document: {
      kind: "html",
      html: expect.stringContaining("<p>ready</p>"),
      hostedUrl: result.url,
    },
    title: "Status",
    context: { sessionKey: "agent:main:status" },
  });
});

it.each([
  {
    name: "has no registered presenter",
    presenters: [] as WidgetPresenter[],
    expected: "No widget presenter is registered",
  },
  {
    name: "has no eligible node",
    presenters: [
      {
        target: "node_panel" as const,
        description: "Show on a connected device panel",
        availability: async () => ({
          ok: false as const,
          error: { code: "no_eligible_node" as const, message: "No connected device." },
        }),
        present: async () => {
          throw new Error("present must not run");
        },
      },
    ],
    expected: "No connected device.",
  },
])(
  "falls back inline with an actionable message when node presentation $name",
  async ({ presenters, expected }) => {
    const result = await executeWidget({
      widgetCode: "<p>inline fallback</p>",
      presentation: { target: "node_panel" },
      presenters,
    });

    expect(result).toMatchObject({
      target: "assistant_message",
      resultText: expect.stringContaining(expected),
    });
    expect(result.resultText).toContain("available inline here");
    expect(result.resultText).toMatch(
      /Pair a canvas-capable device|Retry the requested presentation destination/u,
    );
    await access(documentDir(result.viewId));
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
  await expect(
    tool.execute("oversized-current", { title: "Large", widget_code: "123456789" }),
  ).rejects.toThrow("widget_code exceeds maximum size (8 bytes)");
  await expect(tool.execute("unsupported-current", { ...html, kind: "diagram" })).rejects.toThrow(
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

it("wraps SVG widgets with the stable result and sandbox contracts", async () => {
  const { viewId, url, parsed } = await executeWidget({
    title: "<Status>",
    widgetCode: '  <SvG viewBox="0 0 10 10"><circle r="4" /></SvG>  ',
  });

  expect(viewId).toMatch(/^cv_[a-f0-9]{32}$/);
  expect(url).toBe(`/__openclaw__/canvas/documents/${viewId}/index.html`);
  expect(parsed).toMatchObject({
    kind: "canvas",
    presentation: { target: "assistant_message", title: "<Status>", sandbox: "scripts" },
    text: `Widget hosted at ${url}`,
  });
  const documentHtml = await readFile(documentFile(viewId), "utf8");
  expect(documentHtml).toContain(
    `Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdnjs.cloudflare.com`,
  );
  expect(documentHtml).toContain("font-src data:");
  expect(documentHtml).toContain("img-src data:; media-src data: https: blob:; connect-src 'none'");
  expect(documentHtml).toContain("<title>&lt;Status&gt;</title>");
  expect(documentHtml).toContain("--accent:#bd4531");
  expect(documentHtml).toContain("--accent:#ff5c5c");
  expect(documentHtml).toContain("--accent-fill:#d13c3c");
  expect(documentHtml).toContain('<body class="svg-widget"><script>');
  expect(documentHtml).toContain("openclaw:widget-size");
  const manifest = JSON.parse(await readFile(documentFile(viewId, "manifest.json"), "utf8")) as {
    cspSandbox?: string;
  };
  expect(manifest.cspSandbox).toBe("scripts");
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

    expect(await readBoardHtml(store, target, "release-status")).toMatchObject({
      html: buildWidgetDocument(pinnedTitle, initialHtml),
      revision: 1,
    });
    expect((await store.getSnapshot(target)).widgets[0]).toMatchObject({
      title: pinnedTitle,
      presentation: "frameless",
    });
    expect(result.resultText).toContain("pinned to dashboard tab main as release-status (lg)");
    expect(result.boardWidgetName).toBe("release-status");
    expect((await readCanvasDocumentHtmlSource(result.viewId)).html).toContain(initialHtml);
    expect(broadcast).toHaveBeenCalledWith(
      "board.changed",
      { sessionKey: eventSessionKey, revision: 1, widget: "release-status" },
      boardBroadcastScope,
    );

    await expect(
      callGateway("board.widget.put", {
        ...target,
        name: "release-status",
        content: { kind: "plugin", pluginKind: "workboard:card" },
      }),
    ).rejects.toThrow(/same content kind.*remove/i);
    expect((await readBoardHtml(store, target, "release-status"))?.revision).toBe(1);

    const refreshed = await pinWidget("<p>refreshed</p>");

    expect(await readBoardHtml(store, target, "release-status")).toMatchObject({
      html: buildWidgetDocument(pinnedTitle, "<p>refreshed</p>"),
      revision: 2,
    });
    expect(refreshed.boardWidgetName).toBe("release-status");
    expect(broadcast).toHaveBeenCalledWith(
      "board.changed",
      { sessionKey: eventSessionKey, revision: 2, widget: "release-status" },
      boardBroadcastScope,
    );
    expect(await store.getSnapshot(sibling)).toEqual(siblingBefore);
  },
);

it("pins a granted-CSP document and declaration without networking in the inline preview", async () => {
  const store = createTestBoardStore({ stateDir: harness.stateDir });
  createLiveBoardCaller(store);
  const result = await executeWidget({
    agentSessionKey: "agent:main:weather",
    title: "Weather",
    widgetCode: "<p>weather</p>",
    pin: true,
    capabilities: {
      netOrigins: ["https://api.open-meteo.com"],
      tools: ["health", "prompt"],
    },
  });
  const inlineHtml = await readFile(documentFile(result.viewId), "utf8");
  const pinned = await readBoardHtml(store, { sessionKey: "agent:main:weather" }, "weather");

  expect(inlineHtml).toContain("connect-src 'none'");
  expect(pinned).toMatchObject({
    grantState: "granted",
    declared: {
      netOrigins: ["https://api.open-meteo.com"],
      tools: ["health", "prompt"],
    },
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

  expect(unicodeA.boardWidgetName).toMatch(/^widget-[a-f0-9]{8}$/u);
  expect(unicodeB.boardWidgetName).toMatch(/^widget-[a-f0-9]{8}$/u);
  expect(unicodeA.boardWidgetName).not.toBe(unicodeB.boardWidgetName);
  expect(longA.boardWidgetName).not.toBe(longB.boardWidgetName);
  expect(longA.boardWidgetName).toHaveLength(64);
  expect(longB.boardWidgetName).toHaveLength(64);
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
  expect(new Set([slash.boardWidgetName, plus.boardWidgetName]).size).toBe(2);
  expect((await store.getSnapshot({ sessionKey })).widgets).toHaveLength(2);

  const composed = await pinWidget("Café Menu".normalize("NFC"), "<p>one</p>");
  const decomposed = await pinWidget("Café Menu".normalize("NFD"), "<p>two</p>");
  expect(decomposed.boardWidgetName).toBe(composed.boardWidgetName);
  expect(await readBoardHtml(store, { sessionKey }, composed.boardWidgetName ?? "")).toMatchObject({
    revision: 2,
  });
});

it("uses opaque ids and evicts the oldest widget within a session scope", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-07T00:00:00.000Z"));
  const first = await executeWidget({ widgetCode: "<p>0</p>" });
  for (let index = 1; index <= WIDGET_MAX_PER_SCOPE; index += 1) {
    vi.setSystemTime(new Date(`2026-07-07T00:00:${String(index).padStart(2, "0")}.000Z`));
    await executeWidget({ widgetCode: `<p>${index}</p>` });
  }

  await expect(access(documentDir(first.viewId))).rejects.toThrow();
  const entries = await readdir(resolveCanvasDocumentsDir(harness.stateDir));
  expect(entries).toHaveLength(WIDGET_MAX_PER_SCOPE);
});
