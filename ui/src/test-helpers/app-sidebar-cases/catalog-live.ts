import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogHost,
  SessionCatalogSession,
  SessionsCatalogHostEvent,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  catalogPage,
  createContext,
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  mountSessionCatalogSidebar,
  type TestSessionMenu,
} from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { settleLitElement } from "../lit-settle.ts";
import "../../components/app-sidebar.tsx";
import { catalogGateway, mountCatalog, settleCatalog } from "./compact.test-support.ts";

function storedSession(
  threadId: string,
  name: string,
  extra: Partial<SessionCatalogSession> = {},
): SessionCatalogSession {
  return {
    ...catalogPage([{ threadId, name }]).catalogs[0]!.hosts[0]!.sessions[0]!,
    status: "stored",
    canArchive: false,
    ...extra,
  };
}

function expectPullRequest(row: Element | null | undefined, content: string) {
  const badge = row?.querySelector(".session-row-badge--pull-request");
  expect(badge?.hasAttribute("title")).toBe(false);
  expect(badge?.closest("openclaw-tooltip")).toMatchObject({ content });
}

function catalogHost(
  hostId: string,
  label: string,
  sessions: SessionCatalogSession[],
  extra: Partial<SessionCatalogHost> = {},
): SessionCatalogHost {
  return { hostId, label, kind: "gateway", connected: true, sessions, ...extra };
}

function expectRunIndicators(section: Element | null, rowSelector: string, active: boolean) {
  expect(section).not.toBeNull();
  const dom = domProbe(section!);
  expect(dom.all(`${rowSelector} .sidebar-session-indicator .session-glyph__ring`)).toHaveLength(
    active ? 1 : 0,
  );
  expect(dom.all(".sidebar-recent-sessions__head .session-run-spinner")).toHaveLength(
    active ? 1 : 0,
  );
}

describe("AppSidebar session catalog pagination", () => {
  it("ignores a catalog response that settles after the Gateway client changes", async () => {
    vi.useFakeTimers();
    const staleResponse = deferred<SessionsCatalogListResult>();
    const previousRequest = vi.fn().mockReturnValueOnce(staleResponse.promise);
    const sessions = createSessions("main", ["agent:main:main"]);
    const { provider, sidebar } = await mountCatalog(
      { request: previousRequest } as unknown as GatewayBrowserClient,
      { sessions },
    );
    expect(previousRequest).toHaveBeenCalledTimes(1);

    const currentRequest = vi.fn().mockResolvedValue(catalogPage([]));
    const currentGateway = catalogGateway({
      request: currentRequest,
    } as unknown as GatewayBrowserClient);
    provider.setContext(createContext(currentGateway.gateway, sessions));
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(200);

    staleResponse.resolve(catalogPage([{ threadId: "thread-stale", name: "Stale session" }]));
    await settleCatalog(sidebar);
    expect(sidebar.textContent).not.toContain("Stale session");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(currentRequest).toHaveBeenCalledTimes(2);
    expect(currentRequest).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
      agentId: "main",
      limitPerHost: 40,
      progressId: expect.any(String),
      allowPartialResults: true,
    });
  });

  it.each([
    { id: "claude", label: "Claude Code", branded: true },
    { id: "custom", label: "Custom", branded: false },
  ])("groups $label catalog rows by their owning host", async ({ id, label, branded }) => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const dom = domProbe(sidebar);
    sidebar.sessionData.sessionCatalogs = [
      {
        id,
        label,
        capabilities: { continueSession: true, archive: false },
        hosts: [
          catalogHost("gateway:local", "Gateway Mac", [
            storedSession("local-thread", "Local plan", {
              pullRequest: { numbers: [111751, 111772], state: "merged" },
            }),
          ]),
          catalogHost("node:offline", "Offline Node", [], {
            kind: "node",
            connected: false,
            nodeId: "offline",
            error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
          }),
          catalogHost(
            "node:build",
            "Build Node",
            [storedSession("remote-thread", "Remote review", { canContinue: false })],
            { kind: "node", nodeId: "build" },
          ),
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await settleLitElement(sidebar);

    const section = dom.query(`[data-session-section="catalog:${id}"]`);
    expect(section?.querySelector(".sidebar-session-catalog-new")).toBeNull();
    const lead = section?.querySelector(".sidebar-session-group-toggle__lead");
    expect(lead?.querySelector(".sidebar-session-group-toggle__icon")).not.toBeNull();
    const providerIcon = lead?.querySelector(".sidebar-session-catalog-provider-icon");
    expect(providerIcon?.getAttribute("data-provider-icon")).toBe(branded ? id : undefined);
    const hostGroups = section?.querySelectorAll<HTMLElement>("[data-session-catalog-host]");
    expect(Array.from(hostGroups ?? []).map((host) => host.dataset.sessionCatalogHost)).toEqual([
      "gateway:local",
      "node:build",
    ]);
    const local = section?.querySelector('[data-session-catalog-host="gateway:local"]');
    const remote = section?.querySelector('[data-session-catalog-host="node:build"]');
    expect(local?.querySelector(".sidebar-session-catalog-host__head")).toBeNull();
    expect(local?.textContent).not.toContain("Gateway Mac");
    expect(local?.textContent).toContain("Local plan");
    expectPullRequest(local, "2 pull requests · #111751, #111772 · Merged");
    expect(local?.textContent).not.toContain("Remote review");
    expect(remote?.textContent).toContain("Build Node");
    expect(remote?.textContent).toContain("Remote review");
    expect(remote?.textContent).not.toContain("Local plan");
    expect(section?.textContent).not.toContain("Offline Node");
  });

  it("shows a catalog-owned OpenClaw session only in its catalog section", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const backingSessionKey = "agent:main:claude-bound";
    const rowSelector = `[data-session-key="${backingSessionKey}"]`;
    const patchRows = (rows: GatewaySessionRow[], patch: Partial<GatewaySessionRow>) =>
      rows.map((row) => (row.key === backingSessionKey ? { ...row, ...patch } : row));
    const sessions = createSessionsHarness("main", ["agent:main:main", backingSessionKey]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions, "panel", {
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "global",
      agents: [
        { id: "main", name: "Main" },
        { id: "research", name: "Research" },
      ],
    });
    const dom = domProbe(sidebar);
    sidebar.connected = true;
    const data = sidebar.sessionData;
    data.sessionCatalogs = [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          catalogHost("gateway:local", "Local Claude", [
            storedSession("claude-thread", "Claude session", {
              pullRequest: { numbers: [107302], state: "draft" },
              sessionKey: backingSessionKey,
            }),
          ]),
        ],
      },
    ];
    const backingRows = patchRows(data.sessionsResult?.sessions ?? [], { unread: true });
    const backingResult = {
      ...data.sessionsResult!,
      sessions: backingRows,
    };
    data.sessionsResult = backingResult;
    data.sessionResultsByAgent = { main: backingResult };
    data.requestSessionDataUpdate();
    await settleLitElement(sidebar);

    expect(dom.all(`.sidebar-agent-section__body ${rowSelector}`)).toHaveLength(0);
    expect(dom.all(`[data-session-section="catalog:claude"] ${rowSelector}`)).toHaveLength(1);
    expect(dom.all(rowSelector)).toHaveLength(1);
    const catalogSection = dom.query('[data-session-section="catalog:claude"]');
    const linkedRow = catalogSection?.querySelector<HTMLElement>(rowSelector);
    expect(linkedRow?.getAttribute("draggable")).toBe("true");
    expectPullRequest(linkedRow, "#107302 · Draft");
    expect(linkedRow?.querySelector('[data-sidebar-session-pin="true"]')).not.toBeNull();
    expect(linkedRow?.querySelector("[data-sidebar-session-archive]")).not.toBeNull();
    linkedRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    const linkedMenu = dom.query<TestSessionMenu>("openclaw-session-menu");
    await linkedMenu?.updateComplete;
    expect(linkedMenu?.querySelector('[data-shortcut="a"]')).not.toBeNull();
    expect(linkedMenu?.querySelector('[data-shortcut="d"]')).not.toBeNull();
    expect(
      catalogSection?.querySelector(
        `${rowSelector} .sidebar-session-indicator .session-unread-dot`,
      ),
    ).not.toBeNull();
    expect(
      catalogSection?.querySelector(".sidebar-recent-sessions__head .session-unread-dot"),
    ).not.toBeNull();

    const runningRows = patchRows(backingRows, { unread: false, hasActiveRun: true });
    const runningResult = {
      ...data.sessionsResult,
      sessions: runningRows,
    };
    sessions.publish({ result: runningResult });
    await settleLitElement(sidebar);

    const runningCatalogSection = dom.query('[data-session-section="catalog:claude"]');
    expectRunIndicators(runningCatalogSection, `${rowSelector}.session-row-host--running`, true);

    for (const [phase, seq] of [
      ["finishing", 1],
      ["start", 2],
    ] as const) {
      gateway.publishEvent("agent", {
        sessionKey: backingSessionKey,
        runId: "catalog-run",
        seq,
        stream: "lifecycle",
        data: { phase },
      });
      await settleLitElement(sidebar);
      expect(
        sessions.sessions.state.result?.sessions.find((row) => row.key === backingSessionKey)
          ?.hasActiveRun,
      ).toBe(true);
      const currentSection = dom.query('[data-session-section="catalog:claude"]');
      expectRunIndicators(currentSection, rowSelector, true);
    }

    sessions.publish({
      result: {
        ...runningResult,
        sessions: patchRows(runningRows, { hasActiveRun: false, activeRunIds: [], status: "done" }),
      },
    });
    await settleLitElement(sidebar);
    const settledSection = dom.query('[data-session-section="catalog:claude"]');
    expect(settledSection).not.toBeNull();
    expect(settledSection!.querySelector(rowSelector)).not.toBeNull();
    expectRunIndicators(settledSection, rowSelector, false);
  });

  it("renders catalog groups inside the shared sessions scroller", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValue(catalogPage([{ threadId: "thread-1", name: "Newest" }]));
    const { sidebar } = await mountSessionCatalogSidebar({
      request,
    } as unknown as GatewayBrowserClient);
    const dom = domProbe(sidebar);

    // Separate scroll-less sections flex-squeeze and paint over each other.
    expect(
      dom.query('.sidebar-recent-sessions [data-session-section="catalog:codex"]'),
    ).not.toBeNull();
    expect(dom.all(".sidebar-sessions")).toHaveLength(1);
  });

  it("renders each catalog host before the aggregate list response finishes", async () => {
    vi.useFakeTimers();
    const pending = deferred<SessionsCatalogListResult>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const { sidebar, gateway } = await mountCatalog({
      request,
    } as unknown as GatewayBrowserClient);

    const progressId = (request.mock.calls[0]?.[1] as { progressId?: string })?.progressId;
    expect(progressId).toEqual(expect.any(String));
    const catalog = catalogPage([{ threadId: "thread-fast", name: "Fast host" }]).catalogs[0]!;
    if (!progressId) {
      throw new Error("progressive catalog fixture is incomplete");
    }
    gateway.publishEvent("sessions.catalog.host", {
      progressId,
      agentId: "main",
      catalog,
    } satisfies SessionsCatalogHostEvent);
    await settleLitElement(sidebar);

    expect(sidebar.textContent).toContain("Fast host");
    expect(request).toHaveBeenCalledTimes(1);

    pending.resolve(catalogPage([{ threadId: "thread-fast", name: "Fast host" }]));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("accepts a slow older host when a newer scan has only timed out", async () => {
    vi.useFakeTimers();
    const catalog = catalogPage([]).catalogs[0]!;
    const localHost = catalog.hosts[0]!;
    const timeoutHost = {
      ...localHost,
      hostId: "node:slow",
      label: "Slow node",
      kind: "node" as const,
      sessions: [],
      error: { code: "NODE_INVOKE_FAILED", message: "Node timed out" },
    };
    const finalPage = {
      catalogs: [{ ...catalog, hosts: [localHost, timeoutHost] }],
    } satisfies SessionsCatalogListResult;
    const pendingTimeout = deferred<SessionsCatalogListResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(finalPage)
      .mockReturnValueOnce(pendingTimeout.promise)
      .mockResolvedValue(finalPage);
    const { sidebar, gateway } = await mountCatalog({
      request,
    } as unknown as GatewayBrowserClient);

    const oldProgressId = (request.mock.calls[0]?.[1] as { progressId?: string })?.progressId;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    if (!oldProgressId) {
      throw new Error("first catalog request has no progress id");
    }
    const readyHost = catalogPage([{ threadId: "thread-eventual", name: "Eventually ready" }])
      .catalogs[0]!.hosts[0]!;
    gateway.publishEvent("sessions.catalog.host", {
      progressId: oldProgressId,
      agentId: "main",
      catalog: {
        ...catalog,
        hosts: [
          {
            ...timeoutHost,
            sessions: readyHost.sessions,
            error: undefined,
          },
        ],
      },
    } satisfies SessionsCatalogHostEvent);
    await settleLitElement(sidebar);

    expect(sidebar.textContent).toContain("Eventually ready");
    pendingTimeout.resolve(finalPage);
    await settleCatalog(sidebar);
    expect(sidebar.textContent).toContain("Eventually ready");
  });

  it("discovers an external session after a visibility change and paces later activations", async () => {
    vi.useFakeTimers();
    const empty = catalogPage([]);
    const discovered = catalogPage([{ threadId: "thread-external", name: "External session" }]);
    const request = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(discovered)
      .mockResolvedValue(discovered);
    const { sidebar } = await mountCatalog({
      request,
    } as unknown as GatewayBrowserClient);

    expect(request).toHaveBeenCalledTimes(1);
    expect(sidebar.textContent).not.toContain("External session");

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(1);
    await settleCatalog(sidebar, 1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sidebar.textContent).toContain("External session");

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("ignores a presence and focus burst until the scheduled catalog refresh", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(catalogPage([]));
    const { gateway } = await mountCatalog({
      request,
    } as unknown as GatewayBrowserClient);

    gateway.publishEvent("presence", {
      presence: [{ deviceId: "node-1", mode: "node", reason: "connect" }],
    });
    globalThis.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
