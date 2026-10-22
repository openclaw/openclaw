/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import "../../lib/toast-host.tsx";
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

  it.each([
    ["navigation", "before"],
    ["navigation", "after"],
    ["reconnect", "before"],
    ["reconnect", "after"],
    ["new-client", "before"],
    ["replacement", "after"],
    ["failure", "attached"],
    ["failure", "detached"],
  ] as const)("settles archive and captured Undo across %s (%s)", async (event, timing) => {
    const fixture = await setup();
    const { page, pending, patches, undo } = fixture;
    const reconnect = event === "reconnect" || event === "new-client";
    const transition = () => {
      if (reconnect) {
        fixture.gateway.emit({ phase: "reconnecting", client: null });
        fixture.gateway.emit({
          phase: "connected",
          client:
            event === "new-client"
              ? ({ request: fixture.request } as unknown as GatewayBrowserClient)
              : fixture.client,
        });
      } else {
        page.remove();
      }
    };
    const archived = page.archive(row);
    if (event !== "replacement") {
      await vi.waitFor(() => expect(patches()).toHaveLength(1));
    }
    if (timing === "before" || timing === "detached") {
      transition();
    }
    if (event === "failure") {
      pending.reject(new Error("Archive unavailable"));
    } else {
      pending.resolve(result);
    }
    await archived;
    if (event === "failure" || (reconnect && timing === "before")) {
      await fixture.toast.updateComplete;
      expect(undo()).toBeNull();
      if (event === "failure") {
        expect(page.error).toBe(timing === "detached" ? null : "Archive unavailable");
      }
      expect(patches()).toHaveLength(1);
      return;
    }
    await waitForSolid(() => expect(undo()).not.toBeNull());
    if (event === "replacement") {
      fixture.request.mockImplementation(async (method) => {
        if (method === "sessions.list") {
          return sessionsResult([{ ...row, sessionId: "replacement-session" }], 2);
        }
        throw new Error("Session changed; reload before retrying.");
      });
      await page.context.sessions.refresh({ force: true });
    }
    transition();
    undo()!.click();
    if (reconnect) {
      expect(patches()).toHaveLength(1);
      return;
    }
    await vi.waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]![1]).toMatchObject({
      expectedSessionId: row.sessionId,
      ...(event === "navigation" ? { key: row.key, archived: false, pinned: true } : {}),
    });
    if (event === "replacement") {
      await vi.waitFor(() =>
        expect(fixture.toast.textContent).toContain("Session changed; reload before retrying."),
      );
      expect(page.context.sessions.state.result?.sessions[0]?.sessionId).toBe(
        "replacement-session",
      );
    } else {
      expect(fixture.gateway.setSessionKey).not.toHaveBeenCalled();
    }
  });
});
