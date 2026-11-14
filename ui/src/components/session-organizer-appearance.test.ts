/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { sessionMenuReasons } from "./session-menu-access.ts";
import type { SessionMenuAction } from "./session-menu-solid.tsx";
import { createHarness, sessionRow } from "./session-organizer-batch-mutations.test-support.ts";
import { runSessionAction } from "./session-organizer-menu.runtime.ts";
import { SessionOrganizer } from "./session-organizer.ts";

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
