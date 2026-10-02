/* @vitest-environment jsdom */
import { nothing } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { emptyCronListResponseFixture } from "../../test-helpers/cron.ts";
import {
  createContext,
  createGateway,
  type TestSessionsPage,
} from "./sessions-page.test-support.ts";

const row: GatewaySessionRow = {
  key: "agent:main:archive-target",
  sessionId: "original-session",
  kind: "direct",
  label: "Archive target",
  pinned: true,
};
const result: SessionPatchResult = {
  ok: true,
  path: "",
  key: row.key,
  entry: { sessionId: row.sessionId!, archivedAt: 1 },
};

async function setup() {
  const pending = createDeferred<SessionPatchResult>();
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "cron.list") {
      return emptyCronListResponseFixture();
    }
    if (method === "sessions.list") {
      return sessionsResult([row], 1);
    }
    if (method === "sessions.patch") {
      return pending.promise;
    }
    throw new Error(`Unexpected request: ${method} ${String(params)}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = createGateway(client);
  const sessions = createTestSessionCapability(gateway.gateway);
  onTestFinished(() => sessions.dispose());
  const page = document.createElement("openclaw-sessions-page") as TestSessionsPage;
  page.context = createContext(gateway.gateway, sessions);
  page.render = () => nothing;
  const toast = document.createElement("openclaw-toast-host");
  document.body.append(page, toast);
  await page.updateComplete;
  await sessions.refresh();
  const patches = () => request.mock.calls.filter(([method]) => method === "sessions.patch");
  const undo = () => toast.querySelector<HTMLButtonElement>(".app-toast__action");
  return { page, toast, pending, request, client, gateway, patches, undo };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Sessions archive outcome lifetime", () => {
  it("confirms attached automation names and schedules before archiving", async () => {
    const fixture = await setup();
    const originalRequest = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "daily",
              name: "Daily release check",
              enabled: true,
              scheduleKind: "every",
              schedule: { kind: "every", everyMs: 3_600_000 },
            },
          ],
          snapshotRevision: "one",
          total: 1,
          limit: 200,
          offset: 0,
          hasMore: false,
          nextOffset: null,
        };
      }
      return originalRequest(method, params);
    });
    fixture.pending.resolve(result);
    const archived = fixture.page.archiveSessionWithUndo({ ...row, hasAutomation: true });
    await vi.waitFor(() => expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull());
    expect(fixture.patches()).toHaveLength(0);
    const dialog = document.querySelector("openclaw-modal-dialog")!;
    expect(dialog.textContent).toContain("Daily release check");
    expect(dialog.textContent).toContain("Every 1h");
    expect(dialog.textContent).toContain("Unarchiving will not resume them");
    const confirm = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Archive and pause"),
    );
    expect(confirm).toBeDefined();
    confirm!.click();
    await archived;
    expect(fixture.patches()).toHaveLength(1);
  });
  it("allows an informed archive when the automation inventory is unavailable", async () => {
    const fixture = await setup();
    const originalRequest = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") {
        throw new Error("Inventory unavailable");
      }
      return originalRequest(method, params);
    });
    fixture.pending.resolve({
      ...result,
      automationPause: { status: "failed", reason: "unavailable" },
    });
    const archived = fixture.page.archiveSessionWithUndo(row);
    await vi.waitFor(() => expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull());
    const dialog = document.querySelector("openclaw-modal-dialog")!;
    expect(dialog.textContent).toContain("Automation details could not be loaded");
    expect(fixture.patches()).toHaveLength(0);
    const confirm = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Archive anyway",
    );
    expect(confirm).toBeDefined();
    confirm!.click();
    await archived;
    await fixture.toast.updateComplete;
    expect(fixture.patches()).toHaveLength(1);
    expect(fixture.toast.textContent).toContain("Automation pause incomplete");
  });

  it.each([
    {
      pause: { status: "partial", pausedCount: 1, failedCount: 1 } as const,
      text: "Automation pause incomplete",
    },
    {
      pause: { status: "failed", reason: "unavailable" } as const,
      text: "Automation pause incomplete",
    },
    {
      pause: { status: "skipped", reason: "requires-admin" } as const,
      text: "administrator access is required",
    },
  ])(
    "keeps committed archive and Undo visible when pause is $pause.status",
    async ({ pause, text }) => {
      const fixture = await setup();
      fixture.pending.resolve({ ...result, automationPause: pause });
      await fixture.page.archiveSessionWithUndo(row);
      await fixture.toast.updateComplete;
      expect(fixture.toast.textContent).toContain(text);
      expect(fixture.page.error).toContain(text);
      expect(fixture.undo()).not.toBeNull();
      expect(fixture.patches()).toHaveLength(1);
    },
  );

  it.each(["before confirmation", "after confirmation"])(
    "restores the captured pinned session after leaving %s",
    async (navigation) => {
      const fixture = await setup();
      const archived = fixture.page.archiveSessionWithUndo(row);
      await vi.waitFor(() => expect(fixture.patches()).toHaveLength(1));
      if (navigation === "before confirmation") {
        fixture.page.remove();
      }
      fixture.pending.resolve(result);
      await archived;
      await fixture.toast.updateComplete;
      expect(fixture.undo()).not.toBeNull();
      fixture.page.remove();
      fixture.undo()!.click();
      await vi.waitFor(() => expect(fixture.patches()).toHaveLength(2));
      expect(fixture.patches()[1]![1]).toMatchObject({
        key: row.key,
        expectedSessionId: row.sessionId,
        archived: false,
        pinned: true,
      });
      expect(fixture.gateway.setSessionKey).not.toHaveBeenCalled();
    },
  );

  it.each([
    { reconnect: "before confirmation", sameClient: true },
    { reconnect: "after confirmation", sameClient: true },
    { reconnect: "before confirmation", sameClient: false },
    { reconnect: "after confirmation", sameClient: false },
  ])(
    "retires Undo on reconnect $reconnect (same client=$sameClient)",
    async ({ reconnect, sameClient }) => {
      const fixture = await setup();
      const archived = fixture.page.archiveSessionWithUndo(row);
      await vi.waitFor(() => expect(fixture.patches()).toHaveLength(1));
      const transition = () => {
        fixture.gateway.emit({ phase: "reconnecting", client: null });
        fixture.gateway.emit({
          phase: "connected",
          client: sameClient
            ? fixture.client
            : ({ request: fixture.request } as unknown as GatewayBrowserClient),
        });
      };
      if (reconnect === "before confirmation") {
        transition();
      }
      fixture.pending.resolve(result);
      await archived;
      await fixture.toast.updateComplete;
      if (reconnect === "after confirmation") {
        expect(fixture.undo()).not.toBeNull();
        transition();
        fixture.undo()!.click();
      } else {
        expect(fixture.undo()).toBeNull();
      }
      expect(fixture.patches()).toHaveLength(1);
    },
  );

  it("keeps the original durable identity when the row is replaced before Undo", async () => {
    const fixture = await setup();
    const archived = fixture.page.archiveSessionWithUndo(row);
    fixture.pending.resolve(result);
    await archived;
    await fixture.toast.updateComplete;
    fixture.request.mockImplementation(async (method) => {
      if (method === "sessions.list") {
        return sessionsResult([{ ...row, sessionId: "replacement-session" }], 2);
      }
      throw new Error("Session changed; reload before retrying.");
    });
    await fixture.page.context.sessions.refresh({ force: true });
    fixture.page.remove();
    fixture.undo()!.click();
    await vi.waitFor(() => expect(fixture.patches()).toHaveLength(2));
    expect(fixture.patches()[1]![1]).toMatchObject({ expectedSessionId: row.sessionId });
    await vi.waitFor(() =>
      expect(fixture.toast.textContent).toContain("Session changed; reload before retrying."),
    );
    expect(fixture.page.context.sessions.state.result?.sessions[0]?.sessionId).toBe(
      "replacement-session",
    );
  });

  it.each([false, true])(
    "does not report success for a failed archive (left page=%s)",
    async (left) => {
      const fixture = await setup();
      const archived = fixture.page.archiveSessionWithUndo(row);
      await vi.waitFor(() => expect(fixture.patches()).toHaveLength(1));
      if (left) {
        fixture.page.remove();
      }
      fixture.pending.reject(new Error("Archive unavailable"));
      await archived;
      await fixture.toast.updateComplete;
      expect(fixture.undo()).toBeNull();
      expect(fixture.page.error).toBe(left ? null : "Archive unavailable");
      expect(fixture.patches()).toHaveLength(1);
    },
  );
});
