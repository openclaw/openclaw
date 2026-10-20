import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogSession,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { CATALOG_SESSION_CONTINUED_EVENT } from "../../lib/sessions/catalog-key.ts";
import "../../lib/toast-host.ts";
import { catalogPage, createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../modal-dialog.ts";
import "../../components/app-sidebar.tsx";

function catalogList(
  sessions: Array<Pick<SessionCatalogSession, "threadId"> & Partial<SessionCatalogSession>>,
): SessionsCatalogListResult {
  const result = catalogPage([]);
  result.catalogs[0]!.hosts[0]!.sessions = sessions.map((session) => ({
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: true,
    ...session,
  }));
  return result;
}

async function advance(sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"], ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await sidebar.updateComplete;
}

const thread = (name = "Shared session", details: Partial<SessionCatalogSession> = {}) =>
  catalogList([{ threadId: "thread-1", name, ...details }]);
const row = (sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"], key = "thread-1") =>
  sidebar.querySelector(`[data-session-key*="${key}"]`);
const adoptedKey = "agent:main:adopted-codex";
const catalogSelector = '[data-session-section="catalog:codex"]';

function expectMethods(request: ReturnType<typeof vi.fn>, methods: string[]) {
  expect(request.mock.calls.map(([method]) => method)).toEqual(
    methods.map((method) => `sessions.catalog.${method}`),
  );
}

function adopt(agentId = "main") {
  document.dispatchEvent(
    new CustomEvent(CATALOG_SESSION_CONTINUED_EVENT, {
      detail: {
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "thread-1",
        agentId,
        sessionKey: `agent:${agentId}:adopted-codex`,
      },
    }),
  );
}

async function mountWithCatalog(
  result = thread(),
  sessionKeys = ["agent:main:main"],
  request = vi.fn().mockResolvedValue(result),
) {
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["sessions.catalog.list"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const { sidebar, context } = await mountSidebar(
    gateway.gateway,
    createSessions("main", sessionKeys),
  );
  sidebar.connected = true;
  await sidebar.updateComplete;
  await advance(sidebar);
  return { sidebar, context, gateway, request };
}

describe("AppSidebar catalog terminal ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  it("opens the catalog terminal menu for the rendered catalog session", async () => {
    const { sidebar, context } = await mountWithCatalog(
      thread("Resume me", { canOpenTerminal: true, sourceHomeId: "selected-home" }),
    );
    sidebar.terminalAvailable = true;
    const onNavigate = (sidebar.onNavigate = vi.fn());
    await sidebar.updateComplete;
    row(sidebar)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    const menu = sidebar.querySelector("openclaw-catalog-session-menu") as HTMLElement & {
      onAction: (action: "viewer" | "terminal") => void;
      updateComplete: Promise<boolean>;
    };
    await menu.updateComplete;
    const selection = context.agentSelection;
    selection.set("other");
    const select = vi.spyOn(selection, "set");
    menu.onAction("terminal");
    expect(select).toHaveBeenCalledWith("main");
    expect(selection.state.selectedId).toBe("main");
    expect(onNavigate).toHaveBeenCalledWith("terminal", {
      pathname: "/terminal",
      search: "?catalog=codex&host=gateway%3Alocal&thread=thread-1&sourceHomeId=selected-home",
      hash: "",
    });
  });

  it.each(["selected", "continued"])("keeps one adopted row when %s", async (source) => {
    const selected = source === "selected";
    const result = thread("Release checklist", selected ? { sessionKey: adoptedKey } : {});
    const { sidebar } = await mountWithCatalog(result, ["agent:main:main", adoptedKey]);
    if (selected) {
      sidebar.sessionKey = adoptedKey;
    } else {
      expect(sidebar.querySelectorAll(`[data-session-key="${adoptedKey}"]`)).toHaveLength(1);
      adopt();
    }
    await settleLitElement(sidebar);
    const rows = sidebar.querySelectorAll(`[data-session-key="${adoptedKey}"]`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closest(catalogSelector)).not.toBeNull();
  });

  it("ignores a catalog adoption event owned by another agent", async () => {
    const { sidebar } = await mountWithCatalog(thread("Release checklist"));
    adopt("jarvis");
    await sidebar.updateComplete;

    const catalog = sidebar.querySelector(catalogSelector);
    expect(catalog?.querySelector('[data-session-key="agent:jarvis:adopted-codex"]')).toBeNull();
    expect(
      catalog?.querySelector(
        '[data-session-key="agent:main:catalog:codex:gateway%3Alocal:thread-1"]',
      ),
    ).not.toBeNull();
  });
});

async function selectCatalogDelete(
  sidebar: Awaited<ReturnType<typeof mountWithCatalog>>["sidebar"],
  threadId = "thread-1",
) {
  row(sidebar, threadId)!.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
  );
  await vi.advanceTimersByTimeAsync(0);
  const item = sidebar.querySelector<HTMLButtonElement>(
    'openclaw-catalog-session-menu [data-value="delete"]',
  );
  expect(item).not.toBeNull();
  item!.click();
  return waitForConfirmDialogActions();
}

describe("AppSidebar catalog deletion", () => {
  let restoreDialog: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialog = installDialogPolyfill();
  });
  afterEach(() => restoreDialog());
  it.each([true, false])(
    "confirms catalog deletion and refreshes rows (open: %s)",
    async (open) => {
      const { sidebar, request } = await mountWithCatalog();
      sidebar.sessionKey = open
        ? "agent:main:catalog:codex:gateway%3Alocal:thread-1"
        : "agent:main:main";
      sidebar.activeRouteId = "chat";
      const onNavigate = (sidebar.onNavigate = vi.fn());
      await sidebar.updateComplete;
      const cancelled = await selectCatalogDelete(sidebar);
      expect(request).not.toHaveBeenCalledWith("sessions.catalog.archive", expect.anything());
      answerConfirmDialog(cancelled, "cancel");
      await vi.advanceTimersByTimeAsync(0);
      expect(request).not.toHaveBeenCalledWith("sessions.catalog.archive", expect.anything());
      await vi.advanceTimersByTimeAsync(50);
      request.mockClear().mockResolvedValue(catalogList([]));
      const actions = await selectCatalogDelete(sidebar);
      answerConfirmDialog(actions, "confirm");
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith("sessions.catalog.archive", {
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "thread-1",
        agentId: "main",
        confirmNoOtherRunner: true,
      });
      expectMethods(request, ["archive", "list"]);
      expect(row(sidebar)).toBeNull();
      if (open) {
        expect(onNavigate).toHaveBeenCalledWith("chat", {
          pathname: "/chat",
          search: "",
          hash: "",
        });
      } else {
        expect(onNavigate).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["refresh", "page"] as const)(
    "keeps a pending delete hidden through an earlier %s response and requests fresh rows",
    async (source) => {
      const result = thread();
      if (source === "page") {
        result.catalogs[0]!.hosts[0]!.nextCursor = "page-2";
      }
      const { sidebar, gateway, request } = await mountWithCatalog(result);
      await vi.advanceTimersByTimeAsync(50);
      const progressId = request.mock.calls[0]?.[1]?.progressId;
      const staleList = deferred<SessionsCatalogListResult>();
      const archive = deferred<unknown>();
      const freshList = deferred<SessionsCatalogListResult>();
      request
        .mockClear()
        .mockReturnValueOnce(staleList.promise)
        .mockReturnValueOnce(archive.promise)
        .mockReturnValueOnce(freshList.promise);
      if (source === "page") {
        const loadMore = sidebar.querySelector<HTMLButtonElement>(
          '[data-session-catalog-load-more="codex"]',
        );
        expect(loadMore).not.toBeNull();
        loadMore!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
          agentId: "main",
          catalogId: "codex",
          hostIds: ["gateway:local"],
          cursors: { "gateway:local": "page-2" },
        });
      } else {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expectMethods(request, ["list"]);

      const actions = await selectCatalogDelete(sidebar);
      answerConfirmDialog(actions, "confirm");
      await vi.advanceTimersByTimeAsync(0);
      expectMethods(request, ["list", "archive"]);
      await sidebar.updateComplete;
      expect(row(sidebar)).toBeNull();
      staleList.resolve(thread("Stale deleted session"));
      await advance(sidebar);
      expect(row(sidebar)).toBeNull();
      archive.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      gateway.publishEvent("sessions.catalog.host", {
        agentId: "main",
        progressId,
        catalog: thread("Stale deleted session").catalogs[0],
      });
      await advance(sidebar, 1);
      expect(sidebar.textContent).not.toContain("Stale deleted session");
      expectMethods(request, ["list", "archive", "list"]);

      freshList.resolve(catalogList([]));
      await advance(sidebar);
      expect(row(sidebar)).toBeNull();
    },
  );

  it("does not apply an old delete to rows loaded after reconnecting", async () => {
    const { sidebar, gateway, request } = await mountWithCatalog();
    await vi.advanceTimersByTimeAsync(50);
    const archive = deferred<unknown>();
    request.mockReturnValueOnce(archive.promise);
    answerConfirmDialog(await selectCatalogDelete(sidebar), "confirm");
    await advance(sidebar);
    expect(row(sidebar)).toBeNull();
    gateway.publish({ phase: "reconnecting" });
    await sidebar.updateComplete;
    request.mockResolvedValue(thread("Replacement row"));
    gateway.publish({ phase: "connected" });
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(50);
    archive.resolve({});
    await advance(sidebar);
    expect(row(sidebar)?.textContent).toContain("Replacement row");
  });

  it("does not confirm deletion after changing agents and returning", async () => {
    const { sidebar, context, request } = await mountWithCatalog();
    const actions = await selectCatalogDelete(sidebar);
    for (const agentId of ["other", "main"]) {
      context.agentSelection.set(agentId);
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
    }
    answerConfirmDialog(actions, "confirm");
    await advance(sidebar);
    expect(request).not.toHaveBeenCalledWith("sessions.catalog.archive", expect.anything());
    expect(row(sidebar)).not.toBeNull();
  });

  it("restores a failed delete without bringing back another deleted row", async () => {
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
    await toast.updateComplete;
    try {
      const result = catalogList([
        { threadId: "thread-1", name: "First session" },
        { threadId: "thread-2", name: "Second session" },
      ]);
      const { sidebar, request } = await mountWithCatalog(result);
      await vi.advanceTimersByTimeAsync(50);
      const firstArchive = deferred<unknown>();
      const secondArchive = deferred<unknown>();
      request.mockImplementation((method, params) => {
        if (method === "sessions.catalog.archive") {
          return params.threadId === "thread-1" ? firstArchive.promise : secondArchive.promise;
        }
        return Promise.resolve(catalogList([{ threadId: "thread-2", name: "Updated second" }]));
      });
      answerConfirmDialog(await selectCatalogDelete(sidebar), "confirm");
      await advance(sidebar);
      expect(row(sidebar)).toBeNull();
      answerConfirmDialog(await selectCatalogDelete(sidebar, "thread-2"), "confirm");
      await advance(sidebar);
      expect(row(sidebar, "thread-2")).toBeNull();
      firstArchive.resolve({});
      await advance(sidebar);
      expect(row(sidebar, "thread-2")).toBeNull();
      secondArchive.reject(new Error("Delete unavailable"));
      await advance(sidebar);
      expect(row(sidebar)).toBeNull();
      expect(row(sidebar, "thread-2")?.textContent).toContain("Updated second");
      await toast.updateComplete;
      expect(toast.textContent).toContain("Delete unavailable");
    } finally {
      toast.remove();
    }
  });
});
