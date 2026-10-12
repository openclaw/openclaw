// Core inline widget validation, materialization, and retention.
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { readBoardHtml, createTestBoardStore } from "../boards/board-store.test-support.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.js";
import { createBoardHandlers } from "../gateway/server-methods/board.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { readCanvasDocumentHtmlSource, resolveCanvasDocumentsDir } from "./documents.js";
import { registerTestWidgetContentKind as registerDiagramContentKind } from "./widget-tool.content-kinds.test-support.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { createBoardPutCaller } from "./widget-tool.test-support.js";
import { buildWidgetDocument } from "./wrap.js";

const WIDGET_HTML_MAX_UTF8_BYTES = 10 * 1024 * 1024;
const PINNED_WIDGET_MAX_UTF8_BYTES = WIDGET_HTML_MAX_UTF8_BYTES;
const WIDGET_MAX_PER_SCOPE = 32;
const tempDirs: string[] = [];

beforeEach(() => {
  resetPluginRuntimeStateForTest();
});

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStateDir(): Promise<string> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-widget-tool-"));
  tempDirs.push(stateDir);
  return stateDir;
}

function createLiveBoardTestContext(
  broadcast: ReturnType<typeof vi.fn> = vi.fn(),
  cfg: OpenClawConfig = { agents: { entries: { main: {} } } },
): GatewayRequestContext {
  const context = {
    broadcast,
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    getRuntimeConfig: () => cfg,
  } as unknown as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  return context;
}

function createLiveBoardCaller(
  store: ReturnType<typeof createTestBoardStore>,
  broadcast = vi.fn(),
  cfg: OpenClawConfig = { agents: { entries: { main: {} } } },
): InProcessGatewayCaller {
  const handlers = createBoardHandlers(store);
  return async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    let result: unknown;
    let failure: Error | undefined;
    const respond: RespondFn = (ok, payload, error) => {
      if (ok) {
        result = payload;
      } else {
        failure = new Error(error?.message ?? "board request failed");
      }
    };
    await handlers[method]!({
      req: { type: "req", id: "show-widget", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: createLiveBoardTestContext(broadcast, cfg),
    });
    if (failure) {
      throw failure;
    }
    return result as T;
  };
}

function resolveCanvasDocumentDir(stateDir: string, documentId: string): string {
  return path.join(resolveCanvasDocumentsDir(stateDir), documentId);
}

async function executeWidget(params: {
  stateDir: string;
  sessionId?: string;
  title?: string;
  widgetCode: string;
  agentId?: string;
  agentSessionKey?: string;
  callGateway?: InProcessGatewayCaller;
  pin?: boolean;
  name?: string;
  tab?: string;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  presentation?: {
    target?: "assistant_message" | "node_panel";
    frame?: "card" | "full-bleed" | "frameless";
  };
  presenters?: readonly WidgetPresenter[];
  after?: string;
  capabilities?: { netOrigins?: string[]; tools?: string[] };
  kind?: string;
}) {
  const tool = createShowWidgetTool({
    stateDir: params.stateDir,
    sessionId: params.sessionId ?? "widget-session",
    agentId: params.agentId ?? "main",
    agentSessionKey: params.agentSessionKey,
    callGateway: params.callGateway,
    presenters: params.presenters,
  });
  const result = await tool.execute("widget-call", {
    title: params.title ?? "Widget title",
    widget_code: params.widgetCode,
    ...(params.pin !== undefined ? { pin: params.pin } : {}),
    ...(params.name ? { name: params.name } : {}),
    ...(params.tab ? { tab: params.tab } : {}),
    ...(params.size ? { size: params.size } : {}),
    ...(params.presentation ? { presentation: params.presentation } : {}),
    ...(params.after ? { after: params.after } : {}),
    ...(params.capabilities ? { capabilities: params.capabilities } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
  });
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("expected widget tool text result");
  }
  const parsed = JSON.parse(text) as {
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
    sandbox: parsed.presentation?.sandbox,
    resultText: parsed.text,
    boardWidgetName: parsed.view?.boardWidgetName,
    target: parsed.presentation?.target,
    text,
  };
}

describe("show_widget", () => {
  it("builds a sorted kind enum and routes registered source through board put", async () => {
    registerDiagramContentKind();
    const stateDir = await createStateDir();
    const { mock: callGatewayMock, callGateway } = createBoardPutCaller();
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "registered",
      agentSessionKey: "agent:main:registered",
      callGateway,
    });
    const kindSchema = (tool.parameters as { properties?: { kind?: { enum?: string[] } } })
      .properties?.kind;

    expect(kindSchema?.enum).toEqual(["html", "diagram"]);
    await tool.execute("registered", {
      title: "Diagram",
      widget_code: "diagram:ready",
      kind: "diagram",
      pin: true,
    });
    expect(callGatewayMock).toHaveBeenCalledWith(
      "board.widget.put",
      expect.objectContaining({
        content: { kind: "registered", contentKind: "diagram", source: "diagram:ready" },
      }),
    );

    setActivePluginRegistry(createEmptyPluginRegistry());
    await expect(
      tool.execute("stale", {
        title: "Diagram",
        widget_code: "diagram:ready",
        kind: "diagram",
      }),
    ).rejects.toThrow(
      'widget kind "diagram" is unavailable; enable the plugin that provides it and retry',
    );
  });

  it("uses board-only delivery when inline hosting is disabled", async () => {
    registerDiagramContentKind();
    const stateDir = await createStateDir();
    const { mock: callGatewayMock, callGateway } = createBoardPutCaller();
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "board-only",
      agentSessionKey: "agent:main:board-only",
      inlineHostEnabled: false,
      callGateway,
    });

    expect(tool.description).toContain(
      "Inline previews are unavailable this turn; set pin=true to save to the session dashboard",
    );
    expect(tool.description).not.toContain("Keep one-off visualizations inline");
    await expect(
      tool.execute("unpinned", {
        title: "Diagram",
        widget_code: "diagram:ready",
        kind: "diagram",
      }),
    ).rejects.toThrow(
      "inline widget hosting is disabled; set pin=true to place the widget on the session dashboard",
    );
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();

    const result = await tool.execute("pinned", {
      title: "Diagram",
      widget_code: "diagram:ready",
      kind: "diagram",
      pin: true,
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    expect(JSON.parse(text ?? "null")).toEqual({
      status: "pinned",
      boardWidgetName: "diagram",
      capabilityState: "none",
      text: "Widget pinned to dashboard tab main as diagram. Open this dashboard tab in Control UI to view it.",
    });
    expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(
      "board.widget.put",
      expect.objectContaining({
        content: { kind: "registered", contentKind: "diagram", source: "diagram:ready" },
      }),
    );
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });

  it("routes node-panel presentation and reports the selected device", async () => {
    const stateDir = await createStateDir();
    const availability = vi.fn(async () => ({
      ok: true as const,
      value: { available: true as const },
    }));
    const present = vi.fn(async () => ({
      ok: true as const,
      value: { kind: "node" as const, nodeId: "mac-panel", nodeName: "Studio" },
    }));
    const result = await executeWidget({
      stateDir,
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

    expect(result.target).toBe("node_panel");
    expect(result.resultText).toContain("presented on Studio (mac-panel)");
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
      const stateDir = await createStateDir();
      const result = await executeWidget({
        stateDir,
        widgetCode: "<p>inline fallback</p>",
        presentation: { target: "node_panel" },
        presenters,
      });

      expect(result.target).toBe("assistant_message");
      expect(result.resultText).toContain(expected);
      expect(result.resultText).toContain("available inline here");
      expect(result.resultText).toMatch(
        /Pair a canvas-capable device|Retry the requested presentation destination/u,
      );
      await expect(
        access(resolveCanvasDocumentDir(stateDir, result.viewId)),
      ).resolves.toBeUndefined();
    },
  );

  it("enforces current-presenter source kinds and byte limits in core", async () => {
    registerDiagramContentKind();
    const presenter: WidgetPresenter = {
      target: "current_channel",
      description: "HTML-only current channel",
      capabilities: { sourceKinds: ["html"], maxSourceBytes: 8 },
      match: () => true,
      availability: async () => ({ ok: true, value: { available: true } }),
      present: async () => {
        throw new Error("present must not run");
      },
    };
    const tool = createShowWidgetTool({
      inlineClientAvailable: false,
      presenters: [presenter],
      presenterContext: {},
    });
    const kindSchema = (tool.parameters as { properties?: { kind?: { enum?: string[] } } })
      .properties?.kind;

    expect(kindSchema?.enum).toEqual(["html"]);
    expect(tool.description).not.toContain("registered kinds are diagram");
    await expect(
      tool.execute("oversized-current", { title: "Large", widget_code: "123456789" }),
    ).rejects.toThrow("widget_code exceeds maximum size (8 bytes)");
    await expect(
      tool.execute("unsupported-current", {
        title: "Diagram",
        widget_code: "diagram:ready",
        kind: "diagram",
      }),
    ).rejects.toThrow("inline widget hosting is disabled");
  });

  it("fails visibly without inline fallback and uses a real inline route when available", async () => {
    const presenter: WidgetPresenter = {
      target: "current_channel",
      description: "Failing current channel",
      capabilities: { sourceKinds: ["html"] },
      match: () => true,
      availability: async () => ({ ok: true, value: { available: true } }),
      present: async () => ({
        ok: false,
        error: { code: "presentation_error", message: "delivery rejected" },
      }),
    };
    const noInline = createShowWidgetTool({
      inlineClientAvailable: false,
      presenters: [presenter],
      presenterContext: {},
    });
    await expect(
      noInline.execute("no-inline", { title: "Status", widget_code: "<p>ready</p>" }),
    ).rejects.toThrow("Widget presentation failed: delivery rejected");

    const stateDir = await createStateDir();
    const withInline = createShowWidgetTool({
      stateDir,
      sessionId: "inline-fallback",
      inlineClientAvailable: true,
      presenters: [presenter],
      presenterContext: {},
    });
    const fallback = await withInline.execute("with-inline", {
      title: "Status",
      widget_code: "<p>ready</p>",
    });
    const parsed = JSON.parse(
      fallback.content[0]?.type === "text" ? fallback.content[0].text : "null",
    );
    expect(parsed).toMatchObject({
      kind: "canvas",
      presentation: { target: "assistant_message" },
      text: expect.stringContaining("delivery rejected. The widget is available inline here."),
    });
  });

  it("reports pin success and presentation failure as an explicit partial outcome", async () => {
    const { callGateway } = createBoardPutCaller();
    const presenter: WidgetPresenter = {
      target: "current_channel",
      description: "Failing current channel",
      capabilities: { sourceKinds: ["html"] },
      match: () => true,
      availability: async () => ({ ok: true, value: { available: true } }),
      present: async () => ({
        ok: false,
        error: { code: "presentation_error", message: "delivery rejected" },
      }),
    };
    const tool = createShowWidgetTool({
      agentSessionKey: "agent:main:partial",
      callGateway,
      inlineClientAvailable: false,
      presenters: [presenter],
      presenterContext: {},
    });
    const result = await tool.execute("partial", {
      title: "Status",
      widget_code: "<p>ready</p>",
      pin: true,
    });
    const parsed = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null");

    expect(parsed).toMatchObject({
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

  it("rejects empty and oversized widget code", async () => {
    const stateDir = await createStateDir();
    const tool = createShowWidgetTool({ stateDir, sessionId: "validation" });

    await expect(tool.execute("empty", { title: "Empty", widget_code: "   " })).rejects.toThrow(
      "widget_code required",
    );
    await expect(
      tool.execute("oversized", {
        title: "Too large",
        widget_code: "x".repeat(WIDGET_HTML_MAX_UTF8_BYTES + 1),
      }),
    ).rejects.toThrow(`widget_code exceeds maximum size (${WIDGET_HTML_MAX_UTF8_BYTES} bytes)`);
  });

  it("rejects pinning without a session before creating a Canvas document", async () => {
    const stateDir = await createStateDir();
    const tool = createShowWidgetTool({ stateDir, sessionId: "missing-agent-session" });

    await expect(
      tool.execute("pin", {
        title: "Pinned",
        widget_code: "<p>never materialized</p>",
        pin: true,
      }),
    ).rejects.toThrow("pin requires an agent session");
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });

  it.each([true, false])(
    "rejects multibyte input over the wrapped UTF-8 budget (pin=%s)",
    async (pin) => {
      const stateDir = await createStateDir();
      const callGateway = vi.fn();
      const title = "Multibyte";
      const wrapperBytes = Buffer.byteLength(buildWidgetDocument(title, ""), "utf8");
      const widgetCode = "é".repeat(
        Math.floor((PINNED_WIDGET_MAX_UTF8_BYTES - wrapperBytes) / 2) + 1,
      );
      expect(Buffer.byteLength(widgetCode, "utf8")).toBeLessThan(WIDGET_HTML_MAX_UTF8_BYTES);
      expect(Buffer.byteLength(buildWidgetDocument(title, widgetCode), "utf8")).toBeGreaterThan(
        PINNED_WIDGET_MAX_UTF8_BYTES,
      );
      const tool = createShowWidgetTool({
        stateDir,
        sessionId: "wrapped-budget",
        agentSessionKey: "agent:main:wrapped-budget",
        callGateway,
      });

      await expect(tool.execute("pin", { title, widget_code: widgetCode, pin })).rejects.toThrow(
        pin
          ? `pin exceeds effective dashboard budget (${PINNED_WIDGET_MAX_UTF8_BYTES} UTF-8 bytes after wrapping)`
          : `widget document after wrapping exceeds maximum size (${WIDGET_HTML_MAX_UTF8_BYTES} bytes)`,
      );
      expect(callGateway).not.toHaveBeenCalled();
      await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
    },
  );

  it("does not create an inline Canvas document when dashboard pinning fails", async () => {
    const stateDir = await createStateDir();
    const callGateway = vi.fn(async () => {
      throw new Error("board tab not found: missing");
    });

    await expect(
      executeWidget({
        stateDir,
        agentSessionKey: "agent:main:failed-pin",
        widgetCode: "<p>never materialized</p>",
        pin: true,
        tab: "missing",
        callGateway,
      }),
    ).rejects.toThrow("board tab not found: missing");
    expect(callGateway).toHaveBeenCalledOnce();
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });

  it("requires dashboard pinning for declared capabilities", async () => {
    const stateDir = await createStateDir();
    const tool = createShowWidgetTool({ stateDir, sessionId: "capabilities" });

    await expect(
      tool.execute("capabilities", {
        title: "Weather",
        widget_code: "<p>weather</p>",
        capabilities: { netOrigins: ["https://api.open-meteo.com"] },
      }),
    ).rejects.toThrow("capabilities require pin=true");
  });

  it("wraps SVG widgets with the stable result and sandbox contracts", async () => {
    const stateDir = await createStateDir();
    const { viewId, url, sandbox, text } = await executeWidget({
      stateDir,
      title: "<Status>",
      widgetCode: '  <SvG viewBox="0 0 10 10"><circle r="4" /></SvG>  ',
    });

    expect(viewId).toMatch(/^cv_[a-f0-9]{32}$/);
    expect(url).toBe(`/__openclaw__/canvas/documents/${viewId}/index.html`);
    expect(JSON.parse(text)).toMatchObject({
      kind: "canvas",
      presentation: { target: "assistant_message", title: "<Status>", sandbox: "scripts" },
      text: `Widget hosted at ${url}`,
    });
    expect(sandbox).toBe("scripts");
    const html = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, viewId), "index.html"),
      "utf8",
    );
    expect(html).toContain(
      `Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdnjs.cloudflare.com`,
    );
    expect(html).toContain("font-src data:");
    expect(html).toContain("img-src data:; media-src data: https: blob:; connect-src 'none'");
    expect(html).toContain("<title>&lt;Status&gt;</title>");
    expect(html).toContain("--accent:#bd4531");
    expect(html).toContain("--accent:#ff5c5c");
    expect(html).toContain("--accent-fill:#d13c3c");
    expect(html).toContain('<body class="svg-widget"><script>');
    expect(html).toContain("openclaw:widget-size");
    const manifest = JSON.parse(
      await readFile(
        path.join(resolveCanvasDocumentDir(stateDir, viewId), "manifest.json"),
        "utf8",
      ),
    ) as { cspSandbox?: string };
    expect(manifest.cspSandbox).toBe("scripts");
  });

  it.each([
    ["Research global with retained Main", "global", "research", true],
    ["large HTML", "agent:main:large-widget", "main", false],
  ] as const)(
    "creates and refreshes pinned HTML in %s",
    async (_label, sessionKey, agentId, retainedMain) => {
      const stateDir = await createStateDir();
      const store = createTestBoardStore({ stateDir });
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
          stateDir,
          agentId,
          agentSessionKey: sessionKey,
          title,
          widgetCode,
          pin: true,
          name: "release-status",
          ...(withPlacement
            ? { tab: "main", size: "lg" as const, presentation: { frame: "frameless" as const } }
            : {}),
          callGateway,
        });
      const initialHtml =
        _label === "large HTML" ? `<p>${"é".repeat(2 * 1024 * 1024)}</p>` : "<p>ready</p>";
      const result = await pinWidget(initialHtml, true);
      const pinnedTitle = Array.from(title).slice(0, 80).join("");

      expect(await readBoardHtml(store, target, "release-status")).toMatchObject({
        html: buildWidgetDocument(pinnedTitle, initialHtml),
        revision: 1,
      });
      expect((await store.getSnapshot(target)).widgets[0]?.title).toBe(pinnedTitle);
      expect((await store.getSnapshot(target)).widgets[0]?.presentation).toBe("frameless");
      expect(result.resultText).toContain("pinned to dashboard tab main as release-status (lg)");
      expect(result.boardWidgetName).toBe("release-status");
      expect((await readCanvasDocumentHtmlSource(result.viewId, { stateDir })).html).toContain(
        initialHtml,
      );
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
    const stateDir = await createStateDir();
    const store = createTestBoardStore({ stateDir });
    const callGateway = createLiveBoardCaller(store);

    const result = await executeWidget({
      stateDir,
      agentSessionKey: "agent:main:weather",
      title: "Weather",
      widgetCode: "<p>weather</p>",
      pin: true,
      capabilities: {
        netOrigins: ["https://api.open-meteo.com"],
        tools: ["health", "prompt"],
      },
      callGateway,
    });
    const inlineHtml = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, result.viewId), "index.html"),
      "utf8",
    );
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
    const stateDir = await createStateDir();
    const { callGateway } = createBoardPutCaller();
    const pinWidget = (title: string, widgetCode: string) =>
      executeWidget({
        stateDir,
        agentSessionKey: "agent:main:pinned",
        title,
        widgetCode,
        pin: true,
        callGateway,
      });
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
    const stateDir = await createStateDir();
    const store = createTestBoardStore({ stateDir });
    const callGateway = createLiveBoardCaller(store);
    const sessionKey = "agent:main:generated-collision";
    const pinWidget = (title: string, widgetCode: string) =>
      executeWidget({
        stateDir,
        agentSessionKey: sessionKey,
        title,
        widgetCode,
        pin: true,
        callGateway,
      });
    const [slash, plus] = await Promise.all([
      pinWidget("Revenue / Cost", "<p>slash</p>"),
      pinWidget("Revenue + Cost", "<p>plus</p>"),
    ]);
    expect(new Set([slash.boardWidgetName, plus.boardWidgetName]).size).toBe(2);
    expect((await store.getSnapshot({ sessionKey })).widgets).toHaveLength(2);

    const composed = await pinWidget("Café Menu".normalize("NFC"), "<p>one</p>");
    const decomposed = await pinWidget("Café Menu".normalize("NFD"), "<p>two</p>");
    expect(decomposed.boardWidgetName).toBe(composed.boardWidgetName);
    expect(
      await readBoardHtml(store, { sessionKey }, composed.boardWidgetName ?? ""),
    ).toMatchObject({
      revision: 2,
    });
  });

  it("keeps the host bridges ordered around HTML widget code", async () => {
    const stateDir = await createStateDir();
    const { viewId } = await executeWidget({
      stateDir,
      widgetCode: "<section><button>Run</button><script>document.title='ready'</script></section>",
    });
    const html = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, viewId), "index.html"),
      "utf8",
    );

    expect(html).not.toContain('<body class="svg-widget">');
    expect(html.indexOf("window.sendPrompt")).toBeLessThan(html.indexOf("<section>"));
    expect(html).toContain("openclaw:widget-theme");
    expect(html.indexOf("openclaw:widget-theme")).toBeLessThan(html.indexOf("<section>"));
    expect(html).toContain("openclaw:widget-snapshot-request");
    expect(html.indexOf("openclaw:widget-theme")).toBeLessThan(
      html.indexOf("openclaw:widget-snapshot-request"),
    );
    expect(html.indexOf("openclaw:widget-snapshot-request")).toBeLessThan(
      html.indexOf("<section>"),
    );
  });

  it("uses opaque ids and evicts the oldest widget within a session scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T00:00:00.000Z"));
    const stateDir = await createStateDir();
    const first = await executeWidget({ stateDir, widgetCode: "<p>0</p>" });
    for (let index = 1; index <= WIDGET_MAX_PER_SCOPE; index += 1) {
      vi.setSystemTime(new Date(`2026-07-07T00:00:${String(index).padStart(2, "0")}.000Z`));
      await executeWidget({ stateDir, widgetCode: `<p>${index}</p>` });
    }

    await expect(access(resolveCanvasDocumentDir(stateDir, first.viewId))).rejects.toThrow();
    const entries = await readdir(path.join(stateDir, "canvas", "documents"));
    expect(entries).toHaveLength(WIDGET_MAX_PER_SCOPE);
  });
});
