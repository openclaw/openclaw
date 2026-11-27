/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { sessionMenuReasons } from "./session-menu-access.ts";
import type { SessionMenuAction } from "./session-menu-solid.tsx";
import { createHarness, sessionRow } from "./session-organizer-batch-mutations.test-support.ts";
import { runSessionAction } from "./session-organizer-menu.runtime.ts";
import { SessionOrganizer } from "./session-organizer.ts";

it("names the blocked session actions for a read-only connection", () => {
  const h = createHarness({ scopes: ["operator.read"] });
  const row = sessionRow(1);
  expect(sessionMenuReasons({ snapshot: h.scope.gateway.snapshot, session: row })).toMatchObject({
    rename: "You don’t have permission to rename this session.",
    "set-icon": "You don’t have permission to change this session’s icon.",
    "toggle-archived": "You don’t have permission to archive this session.",
    delete: "You don’t have permission to delete this session.",
  });
  expect(
    sessionMenuReasons({ snapshot: h.scope.gateway.snapshot, session: { ...row, archived: true } })[
      "toggle-archived"
    ],
  ).toBe("You don’t have permission to restore this session.");
});

it("names the blocked paired-device stop action without calling it a cloud device", () => {
  const h = createHarness({ methods: ["sessions.reclaim"], scopes: ["operator.read"] });
  expect(
    sessionMenuReasons({
      snapshot: h.scope.gateway.snapshot,
      session: sessionRow(1),
      cloudWorkerStopAction: {
        method: "sessions.reclaim",
        requiredScope: "operator.write",
        blocksActiveRun: true,
        copyKey: "sessionsView.stopWorker",
      },
    })["stop-cloud-worker"],
  ).toBe("You don’t have permission to stop this session on its device.");
});

const actions = [
  { kind: "set-icon", icon: "book" },
  { kind: "set-color", color: "blue" },
  { kind: "reset-appearance" },
] as const satisfies readonly SessionMenuAction[];

it.each(actions)("lets a session writer $kind on their own session", async (action) => {
  const h = createHarness({ scopes: ["operator.sessions.write"] });
  h.host.sessionData.beginSessionMutation = vi.fn(() => h.scope);
  const row = sessionRow(1);
  const reasons = sessionMenuReasons({ snapshot: h.scope.gateway.snapshot, session: row });
  expect(reasons["set-icon"]).toBeUndefined();
  expect(reasons["set-color"]).toBeUndefined();
  const organizer = new SessionOrganizer(h.host, vi.fn());

  await expect(runSessionAction(organizer, row, action)).resolves.toBe("completed");
  const patch =
    action.kind === "set-icon"
      ? { icon: "book" }
      : action.kind === "set-color"
        ? { color: "blue" }
        : { icon: null, color: null };
  expect(h.patch).toHaveBeenCalledExactlyOnceWith(row.key, patch, {
    agentId: "main",
    expectedSessionId: row.sessionId,
  });
  expect(h.publishSessionMutationError).not.toHaveBeenCalled();
});

it.each([
  { name: "another person's session", scopes: ["operator.sessions.write"], sharingRole: "viewer" },
  { name: "a read-only session", scopes: ["operator.sessions.read"], sharingRole: "owner" },
  { name: "unresolved ownership", scopes: ["operator.sessions.write"], sharingRole: undefined },
] as const)("keeps appearance disabled for $name", async ({ scopes, sharingRole }) => {
  const h = createHarness({ scopes: [...scopes] });
  h.host.sessionData.beginSessionMutation = vi.fn(() => h.scope);
  const row = sessionRow(1, { sharingRole });
  const reasons = sessionMenuReasons({ snapshot: h.scope.gateway.snapshot, session: row });
  expect(reasons["set-icon"]).toBeDefined();
  expect(reasons["set-color"]).toBeDefined();
  const organizer = new SessionOrganizer(h.host, vi.fn());

  for (const action of actions) {
    await expect(runSessionAction(organizer, row, action)).resolves.toBe("failed");
  }
  expect(h.patch).not.toHaveBeenCalled();
});
