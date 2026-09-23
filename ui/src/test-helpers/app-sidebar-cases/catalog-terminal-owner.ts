import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { CATALOG_SESSION_CONTINUED_EVENT } from "../../lib/sessions/catalog-key.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../modal-dialog.ts";
import "../../components/app-sidebar.ts";

const catalogList = (sessions: Array<Record<string, unknown>>): SessionsCatalogListResult => ({
  catalogs: [
    {
      id: "codex",
      label: "Codex",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local Codex",
          kind: "gateway" as const,
          connected: true,
          sessions: sessions.map((session) => ({
            status: "idle",
            archived: false,
            canContinue: true,
            canArchive: true,
            ...session,
          })) as SessionCatalog["hosts"][number]["sessions"],
        },
      ],
    },
  ],
});

async function mountWithCatalog(
  result: SessionsCatalogListResult,
  sessionKeys = ["agent:main:main"],
  request = vi.fn().mockResolvedValue(result),
) {
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: {
      features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const { sidebar, context } = await mountSidebar(
    gateway.gateway,
    createSessions("main", sessionKeys),
  );
  sidebar.connected = true;
  await sidebar.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  await sidebar.updateComplete;
  return { sidebar, context, gateway };
}

describe("AppSidebar catalog terminal ownership", () => {
  it("opens the catalog terminal menu for the rendered catalog session", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar, context } = await mountWithCatalog(
        catalogList([
          {
            threadId: "thread-1",
            name: "Resume me",
            canOpenTerminal: true,
            sourceHomeId: "selected-home",
          },
        ]),
      );
      sidebar.terminalAvailable = true;
      sidebar.onNavigate = vi.fn();
      await sidebar.updateComplete;
      const row = sidebar.querySelector('[data-session-key*="thread-1"]') as HTMLElement;
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 30,
        }),
      );
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
      expect(sidebar.onNavigate).toHaveBeenCalledWith("terminal", {
        pathname: "/terminal",
        search: "?catalog=codex&host=gateway%3Alocal&thread=thread-1&sourceHomeId=selected-home",
        hash: "",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a selected adopted catalog session as one row", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([
          {
            threadId: "thread-1",
            name: "Release checklist",
            sessionKey: "agent:main:adopted-codex",
          },
        ]),
        ["agent:main:main", "agent:main:adopted-codex"],
      );
      sidebar.sessionKey = "agent:main:adopted-codex";
      await sidebar.updateComplete;

      const rows = [...sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest('[data-session-section="catalog:codex"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the adopted session immediately on the catalog-continued event", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
        ["agent:main:main", "agent:main:adopted-codex"],
      );
      expect(
        sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]'),
      ).toHaveLength(1);

      document.dispatchEvent(
        new CustomEvent(CATALOG_SESSION_CONTINUED_EVENT, {
          detail: {
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "thread-1",
            agentId: "main",
            sessionKey: "agent:main:adopted-codex",
          },
        }),
      );
      await sidebar.updateComplete;

      const rows = [...sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest('[data-session-section="catalog:codex"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a catalog adoption event owned by another agent", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
      );

      document.dispatchEvent(
        new CustomEvent(CATALOG_SESSION_CONTINUED_EVENT, {
          detail: {
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "thread-1",
            agentId: "jarvis",
            sessionKey: "agent:jarvis:adopted-codex",
          },
        }),
      );
      await sidebar.updateComplete;

      const catalog = sidebar.querySelector('[data-session-section="catalog:codex"]');
      expect(catalog?.querySelector('[data-session-key="agent:jarvis:adopted-codex"]')).toBeNull();
      expect(
        catalog?.querySelector(
          '[data-session-key="agent:main:catalog:codex:gateway%3Alocal:thread-1"]',
        ),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

async function selectCatalogDelete(
  sidebar: Awaited<ReturnType<typeof mountWithCatalog>>["sidebar"],
  threadId = "thread-1",
) {
  sidebar
    .querySelector(`[data-session-key*="${threadId}"]`)!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  const item = sidebar.querySelector('wa-dropdown-item[value="delete"]');
  expect(item).not.toBeNull();
  item!.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      detail: { item: { value: "delete" } },
    }),
  );
  return waitForConfirmDialogActions();
}

describe("AppSidebar catalog deletion", () => {
  it.each([
    { canArchive: true, archive: true, visible: true },
    { canArchive: false, archive: true, visible: false },
    { canArchive: true, archive: false, visible: false },
  ])(
    "gates Delete on row and catalog capabilities: %j",
    async ({ canArchive, archive, visible }) => {
      vi.useFakeTimers();
      try {
        const result = catalogList([{ threadId: "thread-1", name: "Shared session", canArchive }]);
        result.catalogs[0]!.capabilities.archive = archive;
        const { sidebar } = await mountWithCatalog(result);
        sidebar
          .querySelector('[data-session-key*="thread-1"]')!
          .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        await vi.advanceTimersByTimeAsync(0);
        expect(Boolean(sidebar.querySelector('wa-dropdown-item[value="delete"]'))).toBe(visible);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([true, false])(
    "confirms catalog deletion and refreshes rows (open: %s)",
    async (open) => {
      vi.useFakeTimers();
      const restoreDialog = installDialogPolyfill();
      try {
        const result = catalogList([{ threadId: "thread-1", name: "Shared session" }]);
        const request = vi.fn().mockResolvedValue(result);
        const { sidebar } = await mountWithCatalog(result, undefined, request);
        sidebar.sessionKey = open
          ? "agent:main:catalog:codex:gateway%3Alocal:thread-1"
          : "agent:main:main";
        sidebar.activeRouteId = "chat";
        sidebar.onNavigate = vi.fn();
        await sidebar.updateComplete;
        const cancelled = await selectCatalogDelete(sidebar);
        expect(request).not.toHaveBeenCalledWith("sessions.catalog.archive", expect.anything());
        answerConfirmDialog(cancelled, "cancel");
        await vi.advanceTimersByTimeAsync(0);
        expect(request).not.toHaveBeenCalledWith("sessions.catalog.archive", expect.anything());
        await vi.advanceTimersByTimeAsync(50);
        request.mockClear();
        request.mockResolvedValue(catalogList([]));
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
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "sessions.catalog.archive",
          "sessions.catalog.list",
        ]);
        expect(sidebar.querySelector('[data-session-key*="thread-1"]')).toBeNull();
        if (open) {
          expect(sidebar.onNavigate).toHaveBeenCalledWith("chat", {
            pathname: "/chat",
            search: "",
            hash: "",
          });
        } else {
          expect(sidebar.onNavigate).not.toHaveBeenCalled();
        }
      } finally {
        restoreDialog();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["event", false],
    ["page", false],
    ["event", true],
    ["page", true],
  ] as const)(
    "discards a pre-delete %s response (archive completed: %s) and requests fresh rows",
    async (source, completed) => {
      vi.useFakeTimers();
      const restoreDialog = installDialogPolyfill();
      try {
        const result = catalogList([{ threadId: "thread-1", name: "Shared session" }]);
        if (source === "page") {
          result.catalogs[0]!.hosts[0]!.nextCursor = "page-2";
        }
        const request = vi.fn().mockResolvedValue(result);
        const { sidebar, gateway } = await mountWithCatalog(result, undefined, request);
        await vi.advanceTimersByTimeAsync(50);
        const progressId = request.mock.calls[0]?.[1]?.progressId;
        const staleList = deferred<SessionsCatalogListResult>();
        const archive = deferred<unknown>();
        const freshList = deferred<SessionsCatalogListResult>();
        request.mockClear();
        request
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
          gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
          await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(request.mock.calls.map(([method]) => method)).toEqual(["sessions.catalog.list"]);

        const actions = await selectCatalogDelete(sidebar);
        answerConfirmDialog(actions, "confirm");
        await vi.advanceTimersByTimeAsync(0);
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "sessions.catalog.list",
          "sessions.catalog.archive",
        ]);
        await sidebar.updateComplete;
        expect(sidebar.querySelector('[data-session-key*="thread-1"]')).toBeNull();
        if (completed) {
          archive.resolve({});
          await vi.advanceTimersByTimeAsync(0);
        }
        staleList.resolve(catalogList([{ threadId: "thread-1", name: "Stale deleted session" }]));
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;
        expect(sidebar.querySelector('[data-session-key*="thread-1"]')).toBeNull();
        archive.resolve({});
        await vi.advanceTimersByTimeAsync(0);
        gateway.publishEvent("sessions.catalog.host", {
          agentId: "main",
          progressId,
          catalog: catalogList([{ threadId: "thread-1", name: "Stale deleted session" }])
            .catalogs[0],
        });
        await vi.advanceTimersByTimeAsync(1);
        await sidebar.updateComplete;
        expect(sidebar.textContent).not.toContain("Stale deleted session");
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "sessions.catalog.list",
          "sessions.catalog.archive",
          "sessions.catalog.list",
        ]);

        freshList.resolve(catalogList([]));
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;
        expect(sidebar.querySelector('[data-session-key*="thread-1"]')).toBeNull();
      } finally {
        restoreDialog();
        vi.useRealTimers();
      }
    },
  );

  it("does not apply an old delete to rows loaded after reconnecting", async () => {
    vi.useFakeTimers();
    const restoreDialog = installDialogPolyfill();
    try {
      const result = catalogList([{ threadId: "thread-1", name: "Shared session" }]);
      const request = vi.fn().mockResolvedValue(result);
      const { sidebar, gateway } = await mountWithCatalog(result, undefined, request);
      await vi.advanceTimersByTimeAsync(50);
      const archive = deferred<unknown>();
      request.mockReturnValueOnce(archive.promise);
      answerConfirmDialog(await selectCatalogDelete(sidebar), "confirm");
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.querySelector('[data-session-key*="thread-1"]')).toBeNull();
      gateway.publish({ phase: "reconnecting" });
      await sidebar.updateComplete;
      request.mockResolvedValue(catalogList([{ threadId: "thread-1", name: "Replacement row" }]));
      gateway.publish({ phase: "connected" });
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
      archive.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.querySelector('[data-session-key*="thread-1"]')?.textContent).toContain(
        "Replacement row",
      );
    } finally {
      restoreDialog();
      vi.useRealTimers();
    }
  });

  it("does not confirm deletion after changing agents and returning", async () => {
    vi.useFakeTimers();
    const restoreDialog = installDialogPolyfill();
    try {
      const result = catalogList([{ threadId: "thread-1", name: "Shared session" }]);
      const request = vi.fn().mockResolvedValue(result);
      const { sidebar, context } = await mountWithCatalog(result, undefined, request);
      const actions = await selectCatalogDelete(sidebar);
      for (const agentId of ["other", "main"]) {
        context.agentSelection.set(agentId);
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(50);
      }
      answerConfirmDialog(actions, "confirm");
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(request).not.toHaveBeenCalledWith("sessions.catalog.archive", expect.anything());
      expect(sidebar.querySelector('[data-session-key*="thread-1"]')).not.toBeNull();
    } finally {
      restoreDialog();
      vi.useRealTimers();
    }
  });

  it("restores a failed delete without bringing back another deleted row", async () => {
    vi.useFakeTimers();
    const restoreDialog = installDialogPolyfill();
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
    await toast.updateComplete;
    try {
      const result = catalogList([
        { threadId: "thread-1", name: "First session" },
        { threadId: "thread-2", name: "Second session" },
      ]);
      const request = vi.fn().mockResolvedValue(result);
      const { sidebar } = await mountWithCatalog(result, undefined, request);
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
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.querySelector('[data-session-key*="thread-1"]')).toBeNull();
      answerConfirmDialog(await selectCatalogDelete(sidebar, "thread-2"), "confirm");
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.querySelector('[data-session-key*="thread-2"]')).toBeNull();
      firstArchive.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.querySelector('[data-session-key*="thread-2"]')).toBeNull();
      secondArchive.reject(new Error("Delete unavailable"));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.querySelector('[data-session-key*="thread-1"]')).toBeNull();
      expect(sidebar.querySelector('[data-session-key*="thread-2"]')?.textContent).toContain(
        "Updated second",
      );
      await toast.updateComplete;
      expect(toast.textContent).toContain("Delete unavailable");
    } finally {
      toast.remove();
      restoreDialog();
      vi.useRealTimers();
    }
  });
});
