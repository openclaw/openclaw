/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import "../../lib/toast-host.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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

async function setup(initial = row, selection = false) {
  let rows = [initial];
  const started = createDeferred();
  const pending = createDeferred<SessionPatchResult>();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "sessions.list") {
      return sessionsResult(rows, selection ? 2 : 1);
    }
    if (method === "sessions.patch") {
      started.resolve();
      return pending.promise;
    }
    throw new Error(`Unexpected request: ${method} ${String(params)}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = createGateway(client);
  const sessions = createTestSessionCapability(gateway.gateway);
  const context = createContext(gateway.gateway, sessions);
  const subscribe = vi.spyOn(sessions, "subscribeList");
  const patches = () => request.mock.calls.filter(([method]) => method === "sessions.patch");
  const page = selection
    ? await createRenderedPage(context, sessionsResult(rows, 1), "all")
    : await createPage(context);
  const toast = document.createElement("openclaw-toast-host");
  if (!selection) {
    document.body.append(toast);
    await sessions.refresh();
  }
  const undo = () => toast.querySelector<HTMLButtonElement>(".app-toast__action");
  return {
    client,
    gateway,
    pending,
    started,
    request,
    patches,
    page,
    toast,
    undo,
    replace: async (next: GatewaySessionRow) => {
      rows = [next];
      await sessions.refreshList({ ...subscribe.mock.calls[0]![0], force: true });
      await page.updateComplete;
    },
  };
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
      const fixture = await setup(original, true);
      const { page, pending, started, patches, gateway } = fixture;
      const checkbox = () =>
        page.querySelector<HTMLInputElement>(`input[aria-label="Select session: ${row.key}"]`)!;
      checkbox().click();
      await page.updateComplete;
      const patch =
        action === "rename" ? { label: "Renamed work" } : { archived: action === "archive" };
      const completion = page.patchSession(row.key, patch, undefined, original.sessionId);
      const response: SessionPatchResult = {
        ...result,
        entry: {
          sessionId: original.sessionId!,
          ...(action === "rename"
            ? { label: "Renamed work" }
            : { archivedAt: action === "archive" ? 1 : undefined }),
        },
      };
      try {
        await started.promise;
        expect(patches()).toHaveLength(1);
        expect(patches()[0]?.[1]).toMatchObject({
          key: row.key,
          expectedSessionId: original.sessionId,
          ...patch,
        });
        if (replaced) {
          await fixture.replace(successor);
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
      const { page, pending, patches, undo, gateway } = await setup();
      const archived = page.archive(row);
      await vi.waitFor(() => expect(patches()).toHaveLength(1));
      if (navigation === "before confirmation") {
        page.remove();
      }
      pending.resolve(result);
      await archived;
      await waitForSolid(() => expect(undo()).not.toBeNull());
      page.remove();
      undo()!.click();
      await vi.waitFor(() => expect(patches()).toHaveLength(2));
      expect(patches()[1]![1]).toMatchObject({
        key: row.key,
        expectedSessionId: row.sessionId,
        archived: false,
        pinned: true,
      });
      expect(gateway.setSessionKey).not.toHaveBeenCalled();
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
      const archived = fixture.page.archive(row);
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
      if (reconnect === "after confirmation") {
        await waitForSolid(() => expect(fixture.undo()).not.toBeNull());
        transition();
        fixture.undo()!.click();
      } else {
        await fixture.toast.updateComplete;
        expect(fixture.undo()).toBeNull();
      }
      expect(fixture.patches()).toHaveLength(1);
    },
  );

  it("keeps the original durable identity when the row is replaced before Undo", async () => {
    const fixture = await setup();
    const { page, request, patches, undo } = fixture;
    const archived = page.archive(row);
    fixture.pending.resolve(result);
    await archived;
    await waitForSolid(() => expect(undo()).not.toBeNull());
    request.mockImplementation(async (method) => {
      if (method === "sessions.list") {
        return sessionsResult([{ ...row, sessionId: "replacement-session" }], 2);
      }
      throw new Error("Session changed; reload before retrying.");
    });
    await page.context.sessions.refresh({ force: true });
    page.remove();
    undo()!.click();
    await vi.waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]![1]).toMatchObject({ expectedSessionId: row.sessionId });
    await vi.waitFor(() =>
      expect(fixture.toast.textContent).toContain("Session changed; reload before retrying."),
    );
    expect(page.context.sessions.state.result?.sessions[0]?.sessionId).toBe("replacement-session");
  });

  it.each([false, true])(
    "does not report success for a failed archive (left page=%s)",
    async (left) => {
      const { page, pending, toast, undo, patches } = await setup();
      const archived = page.archive(row);
      await vi.waitFor(() => expect(patches()).toHaveLength(1));
      if (left) {
        page.remove();
      }
      pending.reject(new Error("Archive unavailable"));
      await archived;
      await toast.updateComplete;
      expect(undo()).toBeNull();
      expect(page.error).toBe(left ? null : "Archive unavailable");
      expect(patches()).toHaveLength(1);
    },
  );
});
