/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import * as uiErrors from "../../lib/format-error.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../../test-helpers/gateway-methods.ts";
import { openSubmenu, selectMenuValue } from "../../test-helpers/session-menu.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
  liveSessions,
  mountMutation,
  openRowMenu,
  selectRows,
  sessionRow,
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

describe("sessions command outcomes", () => {
  it.each([false, true])(
    "returns the original patch failure only in its captured scope (retired: %s)",
    async (retired) => {
      const pending = createDeferred<Awaited<ReturnType<SessionCapability["patch"]>>>();
      const failure = new Error("Patch unavailable. Try again.");
      const formatError = vi.spyOn(uiErrors, "formatUiError");
      const { page, sessions, connection } = await mountMutation({
        patch: vi.fn(() => pending.promise),
      });
      const completion = page.patchSession("agent:main:main", { label: "renamed" });
      expect(sessions.patch).toHaveBeenCalledOnce();
      if (retired) {
        connection.emit({ phase: "reconnecting", client: null });
      }
      pending.reject(failure);
      const outcome = await completion;
      if (retired) {
        expect(outcome).toBe("stale");
        await page.updateComplete;
        expect(page.error).toBeNull();
        expect(document.body.textContent).not.toContain(failure.message);
      } else {
        expect(typeof outcome === "object" ? outcome.error : undefined).toBe(failure);
        await waitForFast(() => {
          const alerts = page.querySelectorAll('[role="alert"]');
          expect(alerts).toHaveLength(1);
          expect(alerts[0]?.textContent).toContain(failure.message);
        });
        expect(formatError.mock.calls.at(-1)?.[0]).toBe(failure);
      }
    },
  );

  it("presents involvement failure once and clears it on explicit refresh", async () => {
    const pending = createDeferred<{ ok: boolean }>();
    const failure = new Error("Personal visibility unavailable. Try again.");
    const formatError = vi.spyOn(uiErrors, "formatUiError");
    const request = vi.fn((method: string) =>
      method === "sessions.setInvolvement" ? pending.promise : Promise.resolve({ profiles: [] }),
    );
    const connection = createGateway({ request } as unknown as GatewayBrowserClient);
    connection.emit({
      hello: {
        ...gatewayHelloForMethods(
          [...SESSION_MUTATION_TEST_METHODS, "sessions.setInvolvement"],
          ["operator.read"],
        ),
        policy: { hasMultipleSessionSharingIdentities: true },
      },
    });
    const managed = createManagedSessions();
    const target = sessionRow("personal-retry", { hiddenFromInvolvingMe: true });
    const context = createContext(connection.gateway, managed.sessions);
    const page = await createRenderedPage(context, sessionsResult([target], 1));
    const menu = await openRowMenu(page, target);
    await openSubmenu(menu, "Advanced");
    await selectMenuValue(menu, "toggle-involving-me");
    await waitForFast(() => expect(page.textContent).toContain("Working…"));
    pending.reject(failure);
    await waitForFast(() => {
      const alerts = page.querySelectorAll('[role="alert"]');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.textContent).toContain(failure.message);
      expect(page.textContent).not.toContain("Working…");
    });
    expect(formatError.mock.calls.at(-1)?.[0]).toBe(failure);

    const refreshCalls = managed.refreshList.mock.calls.length;
    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await waitForFast(() => {
      expect(managed.refreshList).toHaveBeenCalledTimes(refreshCalls + 1);
      expect(page.querySelector('[role="alert"]')).toBeNull();
    });
    page.onSortChange("key", "asc");
    await page.updateComplete;
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(managed.sessions.patch).not.toHaveBeenCalled();
  });

  it("keeps a failed roster refresh visible after a successful deletion", async () => {
    const target = sessionRow("delete-refresh");
    const failure = new Error("Roster refresh unavailable. Try again.");
    let deleted = false;
    let refreshFails = false;
    const { context } = liveSessions({
      "sessions.list": () => {
        if (refreshFails) {
          throw failure;
        }
        return sessionsResult(deleted ? [] : [target], 1);
      },
      "sessions.delete": () => {
        deleted = true;
        refreshFails = true;
        return { deleted: true };
      },
    });
    const subscribe = vi.spyOn(context.sessions, "subscribeList");
    const page = await createRenderedPage(context, sessionsResult([target], 1), "all");
    await waitForFast(() => expect(page.loading).toBe(false));
    selectRows(page, target);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    expect(await page.deleteSelected()).toBe("completed");
    expect(context.sessions.listSnapshot(subscribe.mock.calls[0]![0]).error).toBe(failure.message);
    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent ?? "").toContain(failure.message),
    );

    refreshFails = false;
    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).toBeNull());
  });
});
