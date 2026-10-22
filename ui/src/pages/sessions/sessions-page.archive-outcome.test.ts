/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionRequest as mockSessionRequests } from "../../lib/sessions/hydration-family.test-support.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import "../../lib/toast-host.tsx";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createLiveSessionContext,
  createPage,
  createRenderedPage,
} from "./sessions-page.test-support.ts";

const target: GatewaySessionRow = {
  key: "agent:main:archive-target",
  sessionId: "original-session",
  kind: "direct",
  label: "Archive target",
  pinned: true,
};
const patched: SessionPatchResult = {
  ok: true,
  path: "",
  key: target.key,
  entry: { sessionId: target.sessionId!, archivedAt: 1 },
};

async function setup(initial = target, selection = false) {
  let rows = [initial];
  const started = createDeferred();
  const pending = createDeferred<SessionPatchResult>();
  const request = mockSessionRequests({
    "sessions.list": () => sessionsResult(rows, selection ? 2 : 1),
    "sessions.patch": () => {
      started.resolve();
      return pending.promise;
    },
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const { connection: gateway, sessions, context } = createLiveSessionContext(client);
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
      const original = { ...target, archived: action === "restore" };
      const successor = { ...original, sessionId: "successor-session", label: "Replacement work" };
      const fixture = await setup(original, true);
      const { page, pending, started, patches, gateway } = fixture;
      const checkbox = () =>
        page.querySelector<HTMLInputElement>(`input[aria-label="Select session: ${target.key}"]`)!;
      checkbox().click();
      await page.updateComplete;
      const patch =
        action === "rename" ? { label: "Renamed work" } : { archived: action === "archive" };
      const completion = page.patchSession(target.key, patch, undefined, original.sessionId);
      const response: SessionPatchResult = {
        ...patched,
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
          key: target.key,
          expectedSessionId: original.sessionId,
          ...patch,
        });
        if (replaced) {
          await fixture.replace(successor);
          expect(page.selectedSessions.size).toBe(0);
          checkbox().click();
          await page.updateComplete;
          expect(page.selectedSessions.get(target.key)?.sessionId).toBe(successor.sessionId);
        }
        pending.resolve(response);
        expect(await completion).toBe("completed");
        await page.updateComplete;
        expect(checkbox().checked).toBe(replaced);
        expect(page.selectedSessions.get(target.key)?.sessionId).toBe(
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
    const archived = page.archive(target);
    if (event !== "replacement") {
      await vi.waitFor(() => expect(patches()).toHaveLength(1));
    }
    if (timing === "before" || timing === "detached") {
      transition();
    }
    const failure = new Error("Archive unavailable");
    if (event === "failure") {
      pending.reject(failure);
    } else {
      pending.resolve(patched);
    }
    await archived;
    if (event === "failure" || (reconnect && timing === "before")) {
      await fixture.toast.updateComplete;
      expect(undo()).toBeNull();
      if (event === "failure") {
        expect(page.error).toBe(timing === "detached" ? null : failure);
      }
      expect(patches()).toHaveLength(1);
      return;
    }
    await waitForSolid(() => expect(undo()).not.toBeNull());
    if (event === "replacement") {
      fixture.request.mockImplementation(async (method) => {
        if (method === "sessions.list") {
          return sessionsResult([{ ...target, sessionId: "replacement-session" }], 2);
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
      expectedSessionId: target.sessionId,
      ...(event === "navigation" ? { key: target.key, archived: false, pinned: true } : {}),
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

async function setupTree(childCount: number, active = false) {
  const modal = createModalDialogTestFixture();
  const makeRow = (name: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
    key: `agent:main:${name}`,
    sessionId: `captured-${name}-session`,
    kind: "direct",
    sharingRole: "owner",
    ...extra,
  });
  const root = makeRow("tree-outcome", { hasActiveRun: active });
  const rows = [
    root,
    ...Array.from({ length: childCount }, (_, index) =>
      makeRow(`tree-child-${index}`, { parentSessionKey: root.key }),
    ),
  ];
  const serverRows = structuredClone(rows);
  const failed = rows[1]!;
  const failureMessage = "Child placement changed after confirmation";
  const error = { code: "INVALID_REQUEST" as const, message: failureMessage };
  const pending = createDeferred<SessionsPatchManyResult>();
  const dispatched = createDeferred<SessionsPatchManyParams>();
  const restored = createDeferred<SessionsPatchManyParams>();
  const batches: SessionsPatchManyParams[] = [];
  const batchResult = (params: SessionsPatchManyParams): SessionsPatchManyResult => ({
    outcomes: params.targets.map(({ key, agentId }) =>
      params.patch.archived === true && key === failed.key
        ? { ok: false, key, agentId, error }
        : { ok: true, key, agentId },
    ),
  });
  const request = mockSessionRequests({
    "sessions.subscribe": () => ({ subscribed: true }),
    "sessions.describe": () => ({ session: structuredClone(serverRows[0]) }),
    "sessions.list": (raw) => {
      const query = raw as { spawnedBy?: string } | undefined;
      const visible = query?.spawnedBy
        ? serverRows.filter((row) => row.parentSessionKey === query.spawnedBy)
        : serverRows;
      return { ...sessionsResult(structuredClone(visible), 1), hasMore: false, nextOffset: null };
    },
    "sessions.patchMany": async (raw) => {
      const params = raw as SessionsPatchManyParams;
      const archived = params.patch.archived;
      if (typeof archived !== "boolean") {
        throw new Error("Expected an archive or restore patch");
      }
      batches.push(params);
      if (batches.length === 1) {
        dispatched.resolve(params);
      }
      const result = batches.length === 1 ? await pending.promise : batchResult(params);
      const successful = new Set(
        result.outcomes.flatMap((outcome) => (outcome.ok ? [outcome.key] : [])),
      );
      for (const row of serverRows) {
        if (successful.has(row.key)) {
          row.archived = archived;
        }
      }
      if (!archived) {
        restored.resolve(params);
      }
      return result;
    },
    "sessions.patch": () => {
      serverRows[0]!.archived = true;
      return {
        ok: true,
        key: root.key,
        path: "",
        entry: { sessionId: root.sessionId, archivedAt: 1 },
      };
    },
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const { connection: gateway, sessions, context } = createLiveSessionContext(client);
  const page = await createPage(context);
  const toast = document.createElement("openclaw-toast-host");
  document.body.append(toast);
  onTestFinished(async () => {
    pending.resolve({ outcomes: [] });
    page.remove();
    await modal.cleanup();
    sessions.dispose();
    toast.remove();
  });
  await sessions.refresh();
  const archive = () => modal.track(page.archive(root, true));
  const undo = () => toast.querySelector<HTMLButtonElement>(".app-toast__action");
  const confirmTree = async (size: number) => {
    const operation = archive();
    const actions = await waitForConfirmDialogActions();
    expect(batches).toHaveLength(0);
    answerConfirmDialog(actions, "alternative");
    const first = await dispatched.promise;
    expect(first.targets).toHaveLength(size);
    page.remove();
    pending.resolve(batchResult(first));
    await operation;
    // Partial failure stays readable before the successful-only Undo appears.
    await waitForSolid(() => expect(toast.textContent).toContain(failureMessage));
    if (!undo()) {
      const dismiss = toast.querySelector<HTMLButtonElement>(".app-toast__dismiss");
      expect(dismiss).not.toBeNull();
      dismiss!.click();
    }
    await waitForSolid(() => {
      expect(toast.textContent).toContain("Archived " + (rows.length - 1) + " sessions");
      expect(undo()).not.toBeNull();
    });
  };
  return {
    root,
    rows,
    failed,
    restored,
    batches,
    client,
    gateway,
    page,
    toast,
    archive,
    confirmTree,
    patches: () => request.mock.calls.filter(([method]) => method === "sessions.patch"),
    undo,
  };
}

describe("Sessions page confirmed tree archive outcomes", () => {
  it("archives only the running parent without a second confirmation", async () => {
    const { archive, patches, batches, root } = await setupTree(1, true);
    const operation = archive();
    const actions = await waitForConfirmDialogActions();
    expect(document.body.textContent).toContain("This selection contains active work.");
    answerConfirmDialog(actions, "confirm");
    await waitForSolid(() => expect(patches()).toHaveLength(1));
    await operation;
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(batches).toEqual([]);
    expect(patches()[0]?.[1]).toMatchObject({
      key: root.key,
      expectedSessionId: root.sessionId,
      archived: true,
    });
  });

  it("finishes remaining chunks after navigation and exposes partial errors plus successful-only Undo", async () => {
    const fixture = await setupTree(100);
    await fixture.confirmTree(100);

    expect(fixture.batches.map((batch) => batch.targets.length)).toEqual([100, 1]);
    expect(fixture.batches[1]?.targets[0]?.key).toBe(fixture.root.key);
    expect(fixture.page.error).toBeNull();
    fixture.undo()!.click();
    await fixture.restored.promise;
    expect(fixture.batches).toHaveLength(3);
    expect(fixture.batches[2]).toEqual({
      targets: fixture.rows
        .toReversed()
        .filter((row) => row !== fixture.failed)
        .map((row) => ({
          key: row.key,
          agentId: "main",
          expectedSessionId: row.sessionId,
        })),
      patch: { archived: false },
    });
    expect(fixture.gateway.setSessionKey).not.toHaveBeenCalled();
  });

  it("retires the confirmed tree Undo on a same-client reconnect after navigation", async () => {
    const fixture = await setupTree(2);
    await fixture.confirmTree(3);

    fixture.gateway.emit({ phase: "reconnecting", client: null });
    fixture.gateway.emit({ phase: "connected", client: fixture.client });
    fixture.undo()!.click();
    await fixture.toast.updateComplete;
    expect(fixture.batches).toHaveLength(1);
    expect(fixture.gateway.setSessionKey).not.toHaveBeenCalled();
  });
});
