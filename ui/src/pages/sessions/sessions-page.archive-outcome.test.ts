/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRenderedPage,
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
  const request = vi.fn(async (method: string, params?: unknown) => {
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
  const page = await createPage(createContext(gateway.gateway, sessions));
  const toast = document.createElement("openclaw-toast-host");
  document.body.append(toast);
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
  it.each(
    ["rename", "archive", "restore"].flatMap((action) =>
      [false, true].map((replaced) => ({ action, replaced })),
    ),
  )(
    "settles $action selection only for its session (replaced=$replaced)",
    async ({ action, replaced }) => {
      const original = { ...row, archived: action === "restore" };
      const successor = { ...original, sessionId: "successor-session", label: "Replacement work" };
      let rows = [original];
      const started = createDeferred();
      const pending = createDeferred<SessionPatchResult>();
      const request = vi.fn(async (method: string, _params?: unknown) => {
        if (method === "sessions.list") {
          return sessionsResult(rows, 2);
        }
        if (method === "sessions.patch") {
          started.resolve();
          return pending.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
      const sessions = createTestSessionCapability(gateway.gateway);
      const subscribe = vi.spyOn(sessions, "subscribeList");
      const page = await createRenderedPage(
        createContext(gateway.gateway, sessions),
        sessionsResult(rows, 1),
        "all",
      );
      const checkbox = () =>
        page.querySelector<HTMLInputElement>(`input[aria-label="Select session: ${row.key}"]`)!;
      checkbox().click();
      await page.updateComplete;
      const patch =
        action === "rename" ? { label: "Renamed work" } : { archived: action === "archive" };
      const completion = page.patchSession(row.key, patch, undefined, original.sessionId);
      const response: SessionPatchResult = {
        ok: true,
        path: "",
        key: row.key,
        entry: {
          sessionId: original.sessionId!,
          ...(action === "rename"
            ? { label: "Renamed work" }
            : { archivedAt: action === "archive" ? 1 : undefined }),
        },
      };
      try {
        await started.promise;
        const patches = request.mock.calls.filter(([method]) => method === "sessions.patch");
        expect(patches).toHaveLength(1);
        expect(patches[0]?.[1]).toMatchObject({
          key: row.key,
          expectedSessionId: original.sessionId,
          ...patch,
        });
        if (replaced) {
          rows = [successor];
          await sessions.refreshList({ ...subscribe.mock.calls[0]![0], force: true });
          await page.updateComplete;
          expect(page.selectedSessions.size).toBe(0);
          checkbox().click();
          await page.updateComplete;
          expect(page.selectedSessions.get(row.key)?.sessionId).toBe(successor.sessionId);
        }
        pending.resolve(response);
        expect(await completion).toBe("completed");
        await page.updateComplete;
        expect(checkbox().checked).toBe(replaced);
        expect(page.selectedSessions.get(row.key)?.sessionId).toBe(
          replaced ? successor.sessionId : undefined,
        );
        if (replaced) {
          expect(page.result?.sessions).toMatchObject([successor]);
        }
        expect(gateway.setSessionKey).not.toHaveBeenCalled();
      } finally {
        pending.resolve(response);
        await completion;
      }
    },
  );

  it.each(["before confirmation", "after confirmation"])(
    "restores the captured pinned session after leaving %s",
    async (navigation) => {
      const fixture = await setup();
      const archived = fixture.page.archiveActions.archive(row);
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
  ])(
    "retires Undo on reconnect $reconnect (same client=$sameClient)",
    async ({ reconnect, sameClient }) => {
      const fixture = await setup();
      const archived = fixture.page.archiveActions.archive(row);
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
    const archived = fixture.page.archiveActions.archive(row);
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
      const archived = fixture.page.archiveActions.archive(row);
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
