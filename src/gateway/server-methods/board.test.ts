import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetPutParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resetBoardEventNoticeStateForTest } from "../../boards/board-notices.js";
import { readBoardHtml } from "../../boards/board-store.test-support.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  createBoardHarness as createHarness,
  createMcpAppDependencies,
} from "./board.test-support.js";

const mainTarget = { sessionKey: "agent:main:main" };
type Widget = BoardSnapshot["widgets"][number];

function widgetHarness(...args: Parameters<typeof createHarness>) {
  const harness = createHarness(...args);
  const get = async () => {
    const response = await harness.invoke("board.get", mainTarget);
    return response.mock.calls[0]![1] as BoardSnapshot;
  };
  const put = (
    name: string,
    content: BoardWidgetPutParams["content"],
    declared?: BoardWidgetPutParams["declared"],
  ) =>
    harness.invoke("board.widget.put", {
      ...mainTarget,
      name,
      content,
      ...(declared ? { declared } : {}),
    });
  const grant = (widget: Widget, decision: "granted" | "rejected" = "granted") =>
    harness.invoke("board.widget.grant", {
      ...mainTarget,
      name: widget.name,
      decision,
      revision: widget.revision,
      instanceId: widget.instanceId,
    });
  const appView = (widget: Widget) =>
    harness.invoke("board.widget.appView", {
      ...mainTarget,
      name: widget.name,
      revision: widget.revision,
      instanceId: widget.instanceId,
    });
  return { ...harness, get, put, grant, appView };
}
const appSource = { kind: "mcp-app", viewId: "mcp-app-source" } as const;
const activeView = {
  viewId: "mcp-app-source",
  serverName: "server",
  toolName: "tool",
  uiResourceUri: "ui://resource",
  toolCallId: "call",
};

describe("board gateway methods", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    resetBoardEventNoticeStateForTest();
    resetSystemEventsForTest();
    return () => resetPluginRuntimeStateForTest();
  });

  it("scopes bare boards by explicit owner and rejects ambiguous ownerless requests", async () => {
    const { invoke, store } = createHarness(undefined, undefined, undefined, {
      getRuntimeConfig: () => ({
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
      }),
    });
    const work = await invoke("board.widget.put", {
      sessionKey: "global",
      agentId: "work",
      name: "owner",
      content: { kind: "html", html: "work" },
    });
    expect(work).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "agent:work:global" }),
    );
    expect(await store.getSnapshot({ sessionKey: "global", agentId: "work" })).toMatchObject({
      sessionKey: "global",
      revision: 1,
      widgets: [{ name: "owner" }],
    });

    const main = await invoke("board.get", { sessionKey: "global", agentId: "main" });
    expect(main).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "agent:main:global", revision: 0 }),
    );
    expect((await store.getSnapshot({ sessionKey: "global", agentId: "main" })).widgets).toEqual(
      [],
    );

    const ambiguous = await invoke("board.get", { sessionKey: "global" });
    expect(ambiguous).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("adds fresh frames from prepared metadata only for admitted widgets, starting the sandbox once", async () => {
    let sandboxPort: number | undefined;
    const ensureSandboxHostPort = vi.fn(async () => (sandboxPort = 18790));
    const { put, grant, get, store } = widgetHarness(undefined, undefined, undefined, {
      getMcpAppSandboxPort: () => sandboxPort,
      ensureSandboxHostPort,
    });
    await put(
      "status",
      { kind: "html", html: "status" },
      { netOrigins: ["https://status.example"], tools: ["status.refresh"] },
    );
    await put("app", appSource);
    await put("plain", { kind: "html", html: "plain" });
    const pending = await get();
    const status = pending.widgets.find((widget) => widget.name === "status")!;
    expect(status).not.toHaveProperty("frameUrl");
    await grant(status);
    const rejected = await put(
      "rejected",
      { kind: "html", html: "no" },
      { tools: ["status.reject"] },
    );
    await grant(
      (rejected.mock.calls[0]![1] as BoardSnapshot).widgets.find(
        (widget) => widget.name === "rejected",
      )!,
      "rejected",
    );
    const preparedRead = vi.spyOn(store, "getSnapshotWithHtmlViewMetadata");
    const documentRead = vi.spyOn(store, "useWidgetDocument");
    const host = observeHostDataSql();
    let first: BoardSnapshot;
    try {
      first = await get();
      expect(
        host.queries.filter((sql) => /\bfrom\s+"?board_(?:tabs|widgets)"?\b/iu.test(sql)),
      ).toEqual([]);
    } finally {
      host.restore();
    }
    expect(ensureSandboxHostPort).toHaveBeenCalledOnce();
    expect(preparedRead).toHaveBeenCalledOnce();
    expect(documentRead).not.toHaveBeenCalled();
    for (const name of ["plain", "status"]) {
      const widget = first.widgets.find((candidate) => candidate.name === name)!;
      expect(widget.frameUrl).toMatch(
        new RegExp(`^/__openclaw__/board/agent%3Amain%3Amain/${name}/index\\.html\\?bt=v1\\.`),
      );
      expect(widget).toMatchObject({
        viewTicket: expect.stringMatching(/^v1\./u),
        viewTicketTtlMs: 1_200_000,
        viewGeneration: expect.stringMatching(/^[a-f0-9]{32}$/u),
        sandboxUrl: expect.stringMatching(/^\/mcp-app-sandbox\?csp=/u),
        sandboxPort: 18790,
      });
    }
    expect(first.widgets.find((widget) => widget.name === "status")?.declaredSummary).toEqual([
      "Network access: https://status.example",
      "Tool access: status.refresh",
    ]);
    for (const name of ["app", "rejected"]) {
      expect(first.widgets.find((widget) => widget.name === name)).not.toHaveProperty("frameUrl");
    }
    const second = await get();
    for (const name of ["plain", "status"]) {
      expect(second.widgets.find((widget) => widget.name === name)?.frameUrl).not.toBe(
        first.widgets.find((widget) => widget.name === name)?.frameUrl,
      );
    }
  });

  it("never upgrades a restart-reconstructed read-only source", async () => {
    const mcpApp = createMcpAppDependencies();
    vi.mocked(mcpApp.resolveActiveView).mockResolvedValueOnce({
      runtime: { getCatalog: vi.fn() },
      view: { ...activeView, allowedAppToolNames: new Set(), readOnly: true },
    } as never);
    vi.mocked(mcpApp.resolveAllowedToolNames).mockResolvedValueOnce([]);
    const { put, grant, appView, store } = widgetHarness(undefined, mcpApp);
    const response = await put("restored", appSource);
    const widget = (response.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
    expect(widget.grantState).toBe("none");
    expect(await store.readWidgetMcpApp(mainTarget, "restored")).toMatchObject({
      interactive: false,
      declaredTools: [],
    });
    expect((await grant(widget)).mock.calls[0]?.[0]).toBe(false);
    await appView(widget);
    expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ readOnly: true, allowedAppToolNames: new Set() }),
    );
  });

  it("downgrades an MCP App pin when its grant is revoked during tool resolution", async () => {
    const started = createDeferred();
    const release = createDeferred<string[]>();
    let grantActive = true;
    const authorizeAppInteraction = vi.fn(async () => grantActive);
    const mcpApp = createMcpAppDependencies();
    vi.mocked(mcpApp.resolveActiveView).mockResolvedValueOnce({
      runtime: { getCatalog: vi.fn() },
      view: {
        ...activeView,
        allowedAppToolNames: new Set(["server.refresh"]),
        authorizeAppInteraction,
      },
    } as never);
    vi.mocked(mcpApp.resolveAllowedToolNames).mockImplementationOnce(() => {
      started.resolve();
      return release.promise;
    });
    const { put, store } = widgetHarness(undefined, mcpApp);
    const pending = put("revoked", appSource);
    await started.promise;
    expect(authorizeAppInteraction).toHaveBeenCalledOnce();
    grantActive = false;
    release.resolve(["server.refresh"]);
    const response = await pending;
    expect(response.mock.calls[0]?.[0]).toBe(true);
    expect(authorizeAppInteraction).toHaveBeenCalledTimes(2);
    expect(response.mock.calls[0]?.[1]).toMatchObject({
      widgets: [{ name: "revoked", grantState: "none" }],
    });
    expect(await store.readWidgetMcpApp(mainTarget, "revoked")).toMatchObject({
      interactive: false,
      declaredTools: [],
    });
  });

  it("keeps zero-tool MCP Apps read-only until an explicit grant", async () => {
    const mcpApp = createMcpAppDependencies();
    vi.mocked(mcpApp.resolveAllowedToolNames).mockResolvedValue([]);
    const { put, grant, appView } = widgetHarness(undefined, mcpApp);
    const response = await put("message-app", appSource);
    const widget = (response.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
    expect(widget.grantState).toBe("pending");
    await appView(widget);
    expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowedAppToolNames: new Set(), readOnly: true }),
    );
    await grant(widget);
    const host = observeHostDataSql();
    try {
      expect((await appView(widget)).mock.calls[0]?.[0]).toBe(true);
      const interactive = vi.mocked(mcpApp.mintFromTranscript).mock.calls.at(-1)?.[0];
      expect(interactive).toEqual(
        expect.objectContaining({ allowedAppToolNames: new Set(), readOnly: false }),
      );
      expect(await interactive?.authorizeAppInteraction?.()).toBe(true);
      expect(
        host.queries.filter((sql) => /\bfrom\s+"?board_(?:tabs|widgets)"?\b/iu.test(sql)),
      ).toEqual([]);
    } finally {
      host.restore();
    }
  });

  it.each([{ sessionKey: "global", agentId: "work" }])(
    "captures MCP App tools and binds fresh leases to $agentId/$sessionKey",
    async (target) => {
      const { invoke, mcpApp, store } = createHarness(undefined, {}, undefined, {
        getRuntimeConfig: () => ({
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
          mcp: { apps: { enabled: true } },
          tools: { exec: { mode: "ask" } },
        }),
      });
      const content = { kind: "mcp-app", viewId: "mcp-app-source" };

      const put = await invoke("board.widget.put", {
        ...target,
        name: "server-app",
        content,
      });
      expect(put).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          widgets: [
            expect.objectContaining({
              name: "server-app",
              grantState: "pending",
              declaredSummary: ["Tool access: server.refresh", "Tool access: server.search"],
            }),
          ],
        }),
      );
      expect(mcpApp.resolveActiveView).toHaveBeenCalledWith(
        expect.objectContaining({ ...target, viewId: "mcp-app-source" }),
      );
      const originalInstanceId = (await store.getSnapshot(target)).widgets[0]?.instanceId;
      expect(originalInstanceId).toMatch(/^[a-f0-9]{32}$/u);

      const readOnly = await invoke("board.widget.appView", {
        ...target,
        name: "server-app",
        revision: 1,
        instanceId: originalInstanceId,
      });
      expect(readOnly).toHaveBeenCalledWith(true, {
        viewId: "mcp-app-board-1",
        expiresAtMs: 10_001,
      });
      expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ...target,
          allowedAppToolNames: new Set(),
          readOnly: true,
        }),
      );

      await invoke("board.widget.grant", {
        ...target,
        name: "server-app",
        decision: "granted",
        revision: 1,
        instanceId: originalInstanceId,
      });
      const interactive = await invoke("board.widget.appView", {
        ...target,
        name: "server-app",
        revision: 1,
        instanceId: originalInstanceId,
      });
      expect(interactive).toHaveBeenCalledWith(true, {
        viewId: "mcp-app-board-2",
        expiresAtMs: 10_002,
      });
      expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
        expect.objectContaining({
          allowedAppToolNames: new Set(["server.refresh", "server.search"]),
          readOnly: false,
        }),
      );
      const authorizeAppInteraction = vi
        .mocked(mcpApp.mintFromTranscript)
        .mock.calls.at(-1)?.[0]?.authorizeAppInteraction;
      if (!authorizeAppInteraction) {
        throw new Error("interactive board lease must carry a grant check");
      }
      expect(await authorizeAppInteraction()).toBe(true);

      await invoke("board.update", {
        ...target,
        ops: [{ kind: "widget_remove", name: "server-app" }],
      });
      expect(await authorizeAppInteraction()).toBe(false);

      await invoke("board.widget.put", {
        ...target,
        name: "server-app",
        content,
      });
      const replacementInstanceId = (await store.getSnapshot(target)).widgets[0]?.instanceId;
      const staleGrant = await invoke("board.widget.grant", {
        ...target,
        name: "server-app",
        decision: "granted",
        revision: 1,
        instanceId: originalInstanceId,
      });
      expect(staleGrant.mock.calls[0]?.[0]).toBe(false);
      await invoke("board.widget.grant", {
        ...target,
        name: "server-app",
        decision: "granted",
        revision: 1,
        instanceId: replacementInstanceId,
      });
      expect(replacementInstanceId).not.toBe(originalInstanceId);
      expect(await authorizeAppInteraction()).toBe(false);
    },
  );

  it("rejects app-view requests for a replaced widget revision", async () => {
    const { put, appView, mcpApp, store } = widgetHarness();
    const response = await put("server-app", appSource);
    const widget = (response.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
    expect((await appView({ ...widget, revision: 2 })).mock.calls[0]?.[0]).toBe(false);
    expect(mcpApp.mintFromTranscript).not.toHaveBeenCalled();
    expect((await store.getSnapshot(mainTarget)).widgets[0]?.revision).toBe(1);
  });

  it("installs the trusted bridge before arbitrary complete HTML", async () => {
    const { invoke, store } = createHarness();
    const untrusted = '<!doctype html><script>void window.openclaw?.prompt.send("forged")</script>';

    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "complete-document",
      title: "Complete document",
      content: { kind: "html", html: untrusted },
      declared: {
        netOrigins: ["https://api.open-meteo.com"],
        tools: ["prompt"],
      },
    });

    expect(response.mock.calls[0]?.[0]).toBe(true);
    const stored = await readBoardHtml(
      store,
      { sessionKey: "session", agentId: "main" },
      "complete-document",
    );
    const html = stored && "html" in stored ? stored.html : "";
    expect(html).toContain("openclaw:widget-host-init-ack");
    expect(html.indexOf("openclaw:widget-bridge-port-offer")).toBeLessThan(html.indexOf(untrusted));
    expect(html).toContain("connect-src https://api.open-meteo.com");
  });

  it("rejects Canvas sources whose strict sandbox forbids scripts", async () => {
    const readCanvasDocument = vi.fn(async () => ({ html: "<script>unsafe()</script>" }));
    const { invoke, store, broadcast } = createHarness(readCanvasDocument);

    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "strict-canvas-widget",
      content: { kind: "canvas-doc", docId: "cv_strict" },
    });

    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect((await store.getSnapshot({ sessionKey: "session", agentId: "main" })).widgets).toEqual(
      [],
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects a resolved canvas document above the board HTML limit", async () => {
    const readCanvasDocument = vi.fn(async () => ({
      html: "x".repeat(10 * 1024 * 1024 + 1),
      cspSandbox: "scripts" as const,
    }));
    const { invoke, store, broadcast } = createHarness(readCanvasDocument);

    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "oversized-canvas-widget",
      content: { kind: "canvas-doc", docId: "cv_oversized" },
    });

    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect((await store.getSnapshot({ sessionKey: "session", agentId: "main" })).widgets).toEqual(
      [],
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("skips prompt confirmation only for an explicitly granted prompt tool", async () => {
    const { invoke, put, grant, get } = widgetHarness();
    await put("plain", { kind: "html", html: "plain" });
    const plain = await invoke("board.prompt.authorize", {
      ticket: (await get()).widgets[0]!.viewTicket,
    });
    expect(plain.mock.calls[0]?.[1]).toEqual({ confirmationRequired: true });
    const response = await put(
      "approved",
      { kind: "html", html: "approved" },
      { tools: ["prompt"] },
    );
    await grant(
      (response.mock.calls[0]![1] as BoardSnapshot).widgets.find(
        (widget) => widget.name === "approved",
      )!,
    );
    const approved = await invoke("board.prompt.authorize", {
      ticket: (await get()).widgets.find((widget) => widget.name === "approved")!.viewTicket,
    });
    expect(approved.mock.calls[0]?.[1]).toEqual({ confirmationRequired: false });
  });

  it("keeps identical global widget notices separate for each owner", async () => {
    const { invoke } = createHarness(undefined, {}, undefined, {
      getRuntimeConfig: () => ({
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        session: { scope: "global" },
      }),
    });
    for (const agentId of ["main", "work"]) {
      const target = { sessionKey: "global", agentId };
      await invoke("board.widget.put", {
        ...target,
        name: "counter",
        content: { kind: "html", html: "ok" },
      });
      const board = await invoke("board.get", target);
      const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
      const ticket = snapshot.widgets[0]?.viewTicket;
      const first = await invoke("board.event", { ticket, payload: { count: 1 } });
      const duplicate = await invoke("board.event", {
        ...target,
        widget: "counter",
        payload: { count: 1 },
      });
      expect(first.mock.calls[0]?.[1]).toEqual({ ok: true, appended: true });
      expect(duplicate.mock.calls[0]?.[1]).toEqual({ ok: true, appended: false });
    }
    for (const agentId of ["main", "work"]) {
      expect(peekSystemEventEntries(`agent:${agentId}:global`).map((event) => event.text)).toEqual([
        '[dashboard] {"count":1} on widget counter',
      ]);
    }
  });
});
