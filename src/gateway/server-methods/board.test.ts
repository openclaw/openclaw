import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetPutParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createDashboardTool } from "../../agents/tools/dashboard-tool.js";
import type { InProcessGatewayCaller } from "../../agents/tools/in-process-gateway.js";
import { resetBoardEventNoticeStateForTest } from "../../boards/board-notices.js";
import { readBoardHtml } from "../../boards/board-store.test-support.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import { makeClient } from "../server-broadcast.test-helpers.js";
import {
  createBoardHarness as createHarness,
  createMcpAppDependencies,
} from "./board.test-support.js";

const mainTarget = { sessionKey: "agent:main:main" };
type Widget = BoardSnapshot["widgets"][number];
type WidgetIdentity = Pick<Widget, "name" | "revision" | "instanceId">;
const explicitOwners = { ownership: "explicit", entries: { main: {}, work: {} } } as const;
const html = (markup: string) => ({ kind: "html", html: markup }) as const;
const responseBoard = (response: Awaited<ReturnType<ReturnType<typeof createHarness>["invoke"]>>) =>
  response.mock.calls[0]![1] as BoardSnapshot;
const findWidget = (board: BoardSnapshot, name: string) =>
  board.widgets.find((widget) => widget.name === name)!;
async function withoutBoardReads<T>(read: () => Promise<T>) {
  const host = observeHostDataSql();
  try {
    const result = await read();
    expect(
      host.queries.filter((sql) => /\bfrom\s+"?board_(?:tabs|widgets)"?\b/iu.test(sql)),
    ).toEqual([]);
    return result;
  } finally {
    host.restore();
  }
}

const widgetHarness = (...args: Parameters<typeof createHarness>) =>
  scopeWidgets(createHarness(...args), mainTarget);

function scopeWidgets(
  harness: ReturnType<typeof createHarness>,
  target: { sessionKey: string; agentId?: string },
) {
  const put = async (
    name: string,
    content: BoardWidgetPutParams["content"],
    declared?: BoardWidgetPutParams["declared"],
  ) => {
    const response = await harness.invoke("board.widget.put", {
      ...target,
      name,
      content,
      ...(declared ? { declared } : {}),
    });
    expect(response.mock.calls[0]?.[0]).toBe(true);
    const snapshot = responseBoard(response);
    return { widget: findWidget(snapshot, name), snapshot };
  };
  const identity = ({ name, revision, instanceId }: WidgetIdentity) => ({
    ...target,
    name,
    revision,
    instanceId,
  });
  return {
    ...harness,
    put,
    get: async () => responseBoard(await harness.invoke("board.get", target)),
    grant: (widget: WidgetIdentity, decision: "granted" | "rejected" = "granted") =>
      harness.invoke("board.widget.grant", { ...identity(widget), decision }),
    appView: (widget: WidgetIdentity) => harness.invoke("board.widget.appView", identity(widget)),
  };
}
const appSource = { kind: "mcp-app", viewId: "mcp-app-source" } as const;
const activeView = {
  viewId: "mcp-app-source",
  serverName: "server",
  toolName: "tool",
  uiResourceUri: "ui://resource",
  toolCallId: "call",
};
function expectLease(
  mcpApp: ReturnType<typeof createMcpAppDependencies>,
  readOnly: boolean,
  tools: string[] = [],
  target: Record<string, string> = {},
) {
  expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
    expect.objectContaining({ ...target, readOnly, allowedAppToolNames: new Set(tools) }),
  );
}

function sourceHarness(view: {
  allowedAppToolNames: Set<string>;
  readOnly?: true;
  authorizeAppInteraction?: () => Promise<boolean>;
}) {
  const mcpApp = createMcpAppDependencies();
  vi.mocked(mcpApp.resolveActiveView).mockResolvedValueOnce({
    runtime: { getCatalog: vi.fn() },
    view: { ...activeView, ...view },
  } as never);
  return mcpApp;
}

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
        agents: explicitOwners,
      }),
    });
    const work = await invoke("board.widget.put", {
      sessionKey: "global",
      agentId: "work",
      name: "owner",
      content: html("work"),
    });
    expect(work.mock.calls[0]).toMatchObject([true, { sessionKey: "agent:work:global" }]);
    expect(await store.getSnapshot({ sessionKey: "global", agentId: "work" })).toMatchObject({
      sessionKey: "global",
      revision: 1,
      widgets: [{ name: "owner" }],
    });

    const main = await invoke("board.get", { sessionKey: "global", agentId: "main" });
    expect(main.mock.calls[0]).toMatchObject([
      true,
      { sessionKey: "agent:main:global", revision: 0 },
    ]);
    expect(await store.getSnapshot({ sessionKey: "global", agentId: "main" })).toMatchObject({
      widgets: [],
    });

    const ambiguous = await invoke("board.get", { sessionKey: "global" });
    expect(ambiguous.mock.calls[0]).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
  });

  it("adds fresh frames from prepared metadata only for admitted widgets, starting the sandbox once", async () => {
    let sandboxPort: number | undefined;
    const { client } = makeClient("board-viewer", "operator", ["operator.read", "operator.write"]);
    const ensureSandboxHostPort = vi.fn(async () => (sandboxPort = 18790));
    const { put, grant, get, store } = widgetHarness(
      undefined,
      undefined,
      undefined,
      {
        getMcpAppSandboxPort: () => sandboxPort,
        ensureSandboxHostPort,
      },
      client,
    );
    await put("status", html("status"), {
      netOrigins: ["https://status.example"],
      tools: ["status.refresh"],
    });
    await put("app", appSource);
    await put("plain", html("plain"));
    const pending = await get();
    const status = findWidget(pending, "status");
    expect(status).not.toHaveProperty("frameUrl");
    await grant(status);
    const { widget: rejected } = await put("rejected", html("no"), { tools: ["status.reject"] });
    await grant(rejected, "rejected");
    const preparedRead = vi.spyOn(store, "getSnapshotWithHtmlViewMetadata");
    const documentRead = vi.spyOn(store, "useWidgetDocument");
    const first = await withoutBoardReads(get);
    expect(ensureSandboxHostPort).toHaveBeenCalledOnce();
    expect(preparedRead).toHaveBeenCalledOnce();
    expect(documentRead).not.toHaveBeenCalled();
    for (const name of ["plain", "status"]) {
      const widget = findWidget(first, name);
      expect(widget).toMatchObject({
        frameUrl: expect.stringMatching(
          new RegExp(`^/__openclaw__/board/agent%3Amain%3Amain/${name}/index\\.html\\?bt=v1\\.`),
        ),
        viewTicket: expect.stringMatching(/^v1\./u),
        viewTicketTtlMs: 1_200_000,
        viewGeneration: expect.stringMatching(/^[a-f0-9]{32}$/u),
        sandboxUrl: expect.stringMatching(/^\/mcp-app-sandbox\?csp=/u),
        sandboxPort: 18790,
      });
    }
    expect(findWidget(first, "status").declaredSummary).toEqual([
      "Network access: https://status.example",
      "Tool access: status.refresh",
    ]);
    for (const name of ["app", "rejected"]) {
      expect(findWidget(first, name)).not.toHaveProperty("frameUrl");
    }
    client.remoteControlUiIngress = createRemoteControlUiIngressTestContext();
    const second = await get();
    for (const name of ["plain", "status"]) {
      const widget = findWidget(second, name);
      expect(widget.frameUrl).not.toBe(findWidget(first, name).frameUrl);
      expect(new URL(widget.frameUrl!)).toMatchObject({
        origin: "https://ui.example.test",
        pathname: `/__openclaw__/board/agent%3Amain%3Amain/${name}/index.html`,
      });
      expect(widget).toMatchObject({ sandboxOrigin: "https://sandbox.example.test" });
      expect(new URL(widget.sandboxUrl!)).toMatchObject({
        origin: "https://sandbox.example.test",
        pathname: "/mcp-app-sandbox",
      });
    }
  });

  it("never upgrades a restart-reconstructed read-only source", async () => {
    const mcpApp = sourceHarness({ allowedAppToolNames: new Set(), readOnly: true });
    vi.mocked(mcpApp.resolveAllowedToolNames).mockResolvedValueOnce([]);
    const { put, grant, appView, store } = widgetHarness(undefined, mcpApp);
    const { widget } = await put("restored", appSource);
    expect(widget.grantState).toBe("none");
    expect(await store.readWidgetMcpApp(mainTarget, "restored")).toMatchObject({
      interactive: false,
      declaredTools: [],
    });
    expect((await grant(widget)).mock.calls[0]?.[0]).toBe(false);
    await appView(widget);
    expectLease(mcpApp, true);
  });

  it("downgrades an MCP App pin when its grant is revoked during tool resolution", async () => {
    const started = createDeferred();
    const release = createDeferred<string[]>();
    let grantActive = true;
    const authorizeAppInteraction = vi.fn(async () => grantActive);
    const mcpApp = sourceHarness({
      allowedAppToolNames: new Set(["server.refresh"]),
      authorizeAppInteraction,
    });
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
    const { snapshot } = await pending;
    expect(authorizeAppInteraction).toHaveBeenCalledTimes(2);
    expect(snapshot.widgets).toMatchObject([{ name: "revoked", grantState: "none" }]);
    expect(await store.readWidgetMcpApp(mainTarget, "revoked")).toMatchObject({
      interactive: false,
      declaredTools: [],
    });
  });

  it("keeps zero-tool MCP Apps read-only until an explicit grant", async () => {
    const mcpApp = createMcpAppDependencies();
    vi.mocked(mcpApp.resolveAllowedToolNames).mockResolvedValue([]);
    const { put, grant, appView } = widgetHarness(undefined, mcpApp);
    const { widget } = await put("message-app", appSource);
    expect(widget.grantState).toBe("pending");
    await appView(widget);
    expectLease(mcpApp, true);
    await grant(widget);
    await withoutBoardReads(async () => {
      expect((await appView(widget)).mock.calls[0]?.[0]).toBe(true);
      const interactive = vi.mocked(mcpApp.mintFromTranscript).mock.calls.at(-1)?.[0];
      expectLease(mcpApp, false);
      expect(await interactive?.authorizeAppInteraction?.()).toBe(true);
    });
  });

  it("captures MCP App tools and binds fresh leases to the explicit owner", async () => {
    const target = { sessionKey: "global", agentId: "work" };
    const harness = createHarness(undefined, {}, undefined, {
      getRuntimeConfig: () => ({
        agents: explicitOwners,
        mcp: { apps: { enabled: true } },
        tools: { exec: { mode: "ask" } },
      }),
    });
    const { invoke, mcpApp, store, put, grant, appView } = scopeWidgets(harness, target);

    const { snapshot, widget } = await put("server-app", appSource);
    expect(snapshot.widgets).toMatchObject([
      {
        name: "server-app",
        grantState: "pending",
        declaredSummary: ["Tool access: server.refresh", "Tool access: server.search"],
      },
    ]);
    expect(mcpApp.resolveActiveView).toHaveBeenCalledWith(
      expect.objectContaining({ ...target, viewId: "mcp-app-source" }),
    );
    const originalInstanceId = (await store.getSnapshot(target)).widgets[0]?.instanceId;
    expect(originalInstanceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(widget).toMatchObject({ revision: 1, instanceId: originalInstanceId });

    expect(await appView(widget)).toHaveBeenCalledWith(true, {
      viewId: "mcp-app-board-1",
      expiresAtMs: 10_001,
    });
    expectLease(mcpApp, true, [], target);

    await grant(widget);
    expect(await appView(widget)).toHaveBeenCalledWith(true, {
      viewId: "mcp-app-board-2",
      expiresAtMs: 10_002,
    });
    expectLease(mcpApp, false, ["server.refresh", "server.search"]);
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

    await put("server-app", appSource);
    const replacementInstanceId = (await store.getSnapshot(target)).widgets[0]?.instanceId;
    const staleGrant = await grant(widget);
    expect(staleGrant.mock.calls[0]?.[0]).toBe(false);
    await grant({ ...widget, instanceId: replacementInstanceId! });
    expect(replacementInstanceId).not.toBe(originalInstanceId);
    expect(await authorizeAppInteraction()).toBe(false);
  });

  it("rejects app-view requests for a replaced widget revision", async () => {
    const { put, appView, mcpApp, store } = widgetHarness();
    const { widget } = await put("server-app", appSource);
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
      content: html(untrusted),
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
    const document = stored && "html" in stored ? stored.html : "";
    expect(document).toContain("openclaw:widget-host-init-ack");
    expect(document.indexOf("openclaw:widget-bridge-port-offer")).toBeLessThan(
      document.indexOf(untrusted),
    );
    expect(document).toContain("connect-src https://api.open-meteo.com");
  });

  it.each([
    { name: "strict sandbox", document: () => ({ html: "<script>unsafe()</script>" }) },
    {
      name: "oversized HTML",
      document: () => ({ html: "x".repeat(10 * 1024 * 1024 + 1), cspSandbox: "scripts" as const }),
    },
  ])("rejects Canvas $name without publishing a widget", async ({ document }) => {
    const { invoke, store, broadcast } = createHarness(vi.fn(async () => document()));
    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "canvas",
      content: { kind: "canvas-doc", docId: "canvas-doc" },
    });
    expect(response.mock.calls[0]).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
    expect(await store.getSnapshot({ sessionKey: "session", agentId: "main" })).toMatchObject({
      widgets: [],
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("skips prompt confirmation only for an explicitly granted prompt tool", async () => {
    const { invoke, put, grant, get } = widgetHarness();
    await put("plain", html("plain"));
    const plain = await invoke("board.prompt.authorize", {
      ticket: (await get()).widgets[0]!.viewTicket,
    });
    expect(plain.mock.calls[0]?.[1]).toEqual({ confirmationRequired: true });
    const { widget: approvedWidget } = await put("approved", html("approved"), {
      tools: ["prompt"],
    });
    await grant(approvedWidget);
    const approved = await invoke("board.prompt.authorize", {
      ticket: findWidget(await get(), "approved").viewTicket,
    });
    expect(approved.mock.calls[0]?.[1]).toEqual({ confirmationRequired: false });
  });

  it("keeps identical global widget notices separate for each owner", async () => {
    const { invoke } = createHarness(undefined, {}, undefined, {
      getRuntimeConfig: () => ({
        agents: explicitOwners,
        session: { scope: "global" },
      }),
    });
    for (const agentId of ["main", "work"]) {
      const target = { sessionKey: "global", agentId };
      await invoke("board.widget.put", {
        ...target,
        name: "counter",
        content: html("ok"),
      });
      const snapshot = responseBoard(await invoke("board.get", target));
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

describe("website dashboard authoring", () => {
  const sessionKey = "agent:main:website";
  const website = {
    name: "status",
    title: "Status",
    pluginKind: "session:website",
    props: { url: "https://status.example/overview?view=queue#active" },
  };

  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  function createWebsiteHarness() {
    const harness = createHarness();
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ) => {
      const respond = await harness.invoke(method, params);
      const [ok, payload, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error?.message);
      }
      return payload as T;
    };
    const tool = createDashboardTool({ agentSessionKey: sessionKey, callGateway });
    return { ...harness, tool };
  }

  it("creates, reopens, and updates the live URL through the agent tool without frame credentials", async () => {
    const { tool, invoke, store } = createWebsiteHarness();
    const create = { ...website, action: "widget_put", size: "full" };
    const created = await tool.execute("create", create);
    expect(created.details).toMatchObject({
      sessionKey,
      revision: 1,
      widgets: [{ ...website, contentOwner: "plugin", sizeW: 12, grantState: "none" }],
    });

    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const reloaded = await invoke("board.get", { sessionKey });
    const board = reloaded.mock.calls[0]?.[1];
    expect(board).toMatchObject({ revision: 1, widgets: [{ props: create.props }] });
    expect(JSON.stringify(board)).not.toMatch(/viewTicket|frameUrl|sandboxUrl|declared/);

    const updatedProps = { url: "https://status.example/history" };
    await tool.execute("update", { ...create, title: "History", props: updatedProps });
    expect(await store.getSnapshot({ sessionKey })).toMatchObject({
      revision: 2,
      widgets: [{ name: "status", title: "History", revision: 2, props: updatedProps }],
    });
    await tool.execute("remove", { action: "widget_remove", name: "status" });
    expect((await store.getSnapshot({ sessionKey })).widgets).toEqual([]);
  });

  it.each([
    ["HTTP URL", "http://status.example"],
    ["password-only", "https://:example-password@status.example/"],
    ["oversized URL shortened by normalization", `https://status.example/${"a/../".repeat(500)}`],
  ])("rejects invalid website props without changing a saved board: %s", async (_name, url) => {
    const { tool, store, broadcast } = createWebsiteHarness();
    const widget = { ...website, action: "widget_put" };
    await tool.execute("create", widget);
    const before = await store.getSnapshot({ sessionKey });
    broadcast.mockClear();
    await expect(tool.execute("invalid", { ...widget, props: { url } })).rejects.toThrow(/Website/);
    expect(await store.getSnapshot({ sessionKey })).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
