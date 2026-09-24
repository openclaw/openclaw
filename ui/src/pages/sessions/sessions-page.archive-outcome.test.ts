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
