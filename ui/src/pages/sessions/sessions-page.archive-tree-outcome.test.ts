/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import "../../lib/toast-host.tsx";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext, createGateway, createPage } from "./sessions-page.test-support.ts";

async function setup(childCount: number, active = false) {
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
  const request = vi.fn(async (method: string, raw?: unknown) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.describe") {
      return { session: structuredClone(serverRows[0]) };
    }
    if (method === "sessions.list") {
      const query = raw as { spawnedBy?: string } | undefined;
      const visible = query?.spawnedBy
        ? serverRows.filter((row) => row.parentSessionKey === query.spawnedBy)
        : serverRows;
      return { ...sessionsResult(structuredClone(visible), 1), hasMore: false, nextOffset: null };
    }
    if (method === "sessions.patchMany") {
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
    }
    if (method === "sessions.patch") {
      serverRows[0]!.archived = true;
      return {
        ok: true,
        key: root.key,
        path: "",
        entry: { sessionId: root.sessionId, archivedAt: 1 },
      };
    }
    throw new Error("Unexpected request: " + method);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = createGateway(client);
  const sessions = createTestSessionCapability(gateway.gateway);
  const page = await createPage(createContext(gateway.gateway, sessions));
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
    const { archive, patches, batches, root } = await setup(1, true);
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
    const fixture = await setup(100);
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
    const fixture = await setup(2);
    await fixture.confirmTree(3);

    fixture.gateway.emit({ phase: "reconnecting", client: null });
    fixture.gateway.emit({ phase: "connected", client: fixture.client });
    fixture.undo()!.click();
    await fixture.toast.updateComplete;
    expect(fixture.batches).toHaveLength(1);
    expect(fixture.gateway.setSessionKey).not.toHaveBeenCalled();
  });
});
