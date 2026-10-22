/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  openSubmenu,
  selectMenuValue,
  settleSessionMenu,
} from "../../test-helpers/session-menu.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: vi.fn(),
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("sessions page lifecycle", () => {
  it("presents owner-started refreshes without replacing controls, rows, or subscriptions", async () => {
    const initial = sessionsResult(
      [{ key: "agent:main:retained", kind: "direct", updatedAt: 1 }],
      1,
    );
    initial.sessions[0]!.sessionId = "retained-generation";
    const managed = createManagedSessions();
    const context = createContext(createGateway().gateway, managed.sessions);
    const page = await createRenderedPage(context, initial);
    const pending = createDeferred();
    const searchInput = () =>
      page.querySelector<HTMLInputElement>(".sessions-filter-popover__search input")!;
    try {
      const [query] = managed.subscribeList.mock.calls[0]!;
      const input = searchInput();
      const row = page.querySelector("tbody tr");
      page.selectedSessions = new Map([[initial.sessions[0]!.key, initial.sessions[0]!]]);
      await page.updateComplete;
      const refresh = () => page.querySelector<HTMLButtonElement>(".sessions-toolbar__refresh")!;
      const publish = (loading: boolean, error: string | null = null) =>
        managed.publish(query, { result: initial, agentId: "main", loading, error });

      publish(true);
      await page.updateComplete;
      expect(refresh().disabled).toBe(false);
      expect(searchInput()).toBe(input);
      expect(page.querySelector("tbody tr")).toBe(row);
      expect(page.selectedSessions.has(initial.sessions[0]!.key)).toBe(true);

      publish(false, "Synthetic background refresh failure");
      await vi.waitFor(() =>
        expect(page.textContent).toContain("Synthetic background refresh failure"),
      );
      expect(searchInput()).toBe(input);
      expect(page.querySelector("tbody tr")).toBe(row);

      publish(true);
      await page.updateComplete;
      publish(false);
      await vi.waitFor(() => expect(refresh().disabled).toBe(false));
      await vi.waitFor(() => expect(page.querySelector(".sessions-error")).toBeNull());
      expect(page.selectedSessions.has(initial.sessions[0]!.key)).toBe(true);
      expect(managed.subscribeList).toHaveBeenCalledTimes(1);
      expect(managed.refreshList).not.toHaveBeenCalled();

      managed.refreshList.mockImplementationOnce(async () => {
        publish(true);
        await pending.promise;
        publish(false);
      });
      refresh().click();
      await vi.waitFor(() => expect(refresh().disabled).toBe(true));
      pending.resolve();
      await vi.waitFor(() => expect(refresh().disabled).toBe(false));
      expect(managed.refreshList).toHaveBeenCalledTimes(1);
      expect(page.querySelector("tbody tr")).toBe(row);
    } finally {
      pending.resolve();
      page.remove();
    }
  });

  it("shows command progress while the session owner holds its follow-up roster read", async () => {
    const target: GatewaySessionRow = {
      key: "agent:main:held-command",
      sessionId: "held-command-id",
      kind: "direct",
      label: "Before edit",
      updatedAt: 1,
    };
    const refreshed = createDeferred<ReturnType<typeof sessionsResult>>();
    const readStarted = createDeferred();
    let edited = false;
    const connection = createGateway(
      createTestGatewayClient((method) => {
        if (method === "sessions.list") {
          if (edited) {
            readStarted.resolve();
            return refreshed.promise;
          }
          return sessionsResult([target], 1);
        }
        if (method === "sessions.describe") {
          return { session: target };
        }
        if (method === "sessions.patch") {
          edited = true;
          return { ok: true, path: "", key: target.key, entry: { sessionId: target.sessionId } };
        }
        throw new Error(`Unexpected request: ${method}`);
      }),
    );
    const sessions = createTestSessionCapability(connection.gateway);
    const page = await createRenderedPage(
      createContext(connection.gateway, sessions),
      sessionsResult([target], 1),
      "all",
    );
    const next = sessionsResult([{ ...target, label: "After edit" }], 2);
    try {
      page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
      await waitForFast(() =>
        expect(
          page.querySelector<HTMLInputElement>(".session-overrides-grid input")?.disabled,
        ).toBe(false),
      );
      const label = page.querySelector<HTMLInputElement>(".session-overrides-grid input")!;
      label.value = "After edit";
      label.dispatchEvent(new Event("change", { bubbles: true }));
      await readStarted.promise;
      await waitForFast(() => expect(page.textContent).toContain("Working…"));
      refreshed.resolve(next);
      await waitForFast(() => expect(page.textContent).not.toContain("Working…"));
      expect(page.textContent).toContain("After edit");
    } finally {
      refreshed.resolve(next);
      page.remove();
      sessions.dispose();
    }
  });

  it("clears failed command feedback on Refresh and retry while retaining roster read errors", async () => {
    const target: GatewaySessionRow = {
      key: "agent:main:retry-command",
      sessionId: "retry-command-id",
      kind: "direct",
      label: "Retry command fixture",
      updatedAt: 1,
    };
    let rows = [target];
    let deletionAttempts = 0;
    let readFails = false;
    const connection = createGateway(
      createTestGatewayClient((method) => {
        if (method === "sessions.list") {
          if (readFails) {
            throw new Error("Roster unavailable. Refresh to recover.");
          }
          return sessionsResult(rows, 1);
        }
        if (method === "sessions.delete") {
          deletionAttempts += 1;
          if (deletionAttempts < 3) {
            throw new Error("Deletion unavailable. Try again.");
          }
          rows = [];
          readFails = true;
          return { deleted: true };
        }
        throw new Error(`Unexpected request: ${method}`);
      }),
    );
    const sessions = createTestSessionCapability(connection.gateway);
    const page = await createRenderedPage(
      createContext(connection.gateway, sessions),
      sessionsResult(rows, 1),
      "all",
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const remove = async () => {
      page.openSessionMenu(target, { x: 10, y: 20 }, document.createElement("button"));
      await page.updateComplete;
      const menu =
        page.querySelector<HTMLElementTagNameMap["openclaw-session-menu"]>(
          "openclaw-session-menu",
        )!;
      expect(menu).not.toBeNull();
      await settleSessionMenu(menu);
      await openSubmenu(menu, "Advanced");
      await selectMenuValue(menu, "delete");
    };
    const refresh = () => page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;

    try {
      await remove();
      await waitForFast(() =>
        expect(page.textContent).toContain("Deletion unavailable. Try again."),
      );
      refresh().click();
      await waitForFast(() =>
        expect(page.textContent).not.toContain("Deletion unavailable. Try again."),
      );

      await remove();
      await waitForFast(() =>
        expect(page.textContent).toContain("Deletion unavailable. Try again."),
      );
      await remove();
      await waitForFast(() =>
        expect(page.textContent).toContain("Roster unavailable. Refresh to recover."),
      );
      expect(page.textContent).not.toContain("Deletion unavailable. Try again.");
      expect(deletionAttempts).toBe(3);

      readFails = false;
      refresh().click();
      await waitForFast(() => expect(page.querySelector('[role="alert"]')).toBeNull());
    } finally {
      page.remove();
      sessions.dispose();
    }
  });
});
