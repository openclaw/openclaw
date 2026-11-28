/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { sessionMenuReasons } from "./session-menu-access.ts";
import { createHarness, sessionRow } from "./session-organizer-batch-mutations.test-support.ts";
import { setSessionInvolvement } from "./session-organizer-batch-mutations.ts";

it.each(["operator.sessions.read", "operator.read"])(
  "allows a %s viewer to hide and show a readable session personally",
  async (scope) => {
    const h = createHarness({ methods: ["sessions.setInvolvement"], scopes: [scope] });
    const row = sessionRow(1, { sharingRole: "viewer" });
    const mutate = vi.fn(async () => true);
    h.scope.sessions.setInvolvement = mutate;

    expect(
      sessionMenuReasons({ snapshot: h.scope.gateway.snapshot, session: row })[
        "toggle-involving-me"
      ],
    ).toBeUndefined();
    for (const hidden of [true, false]) {
      await setSessionInvolvement(h.host, row, hidden, h.scope);
      expect(mutate).toHaveBeenLastCalledWith({
        key: row.key,
        agentId: "main",
        expectedSessionId: row.sessionId,
        hidden,
      });
    }
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(h.host.sessionData.refreshSidebarSessions).toHaveBeenCalledTimes(2);
    expect(h.publishSessionMutationError).not.toHaveBeenCalled();
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.pruneSidebarSessionEntry).not.toHaveBeenCalled();
  },
);

it.each([
  { name: "missing read scope", scopes: ["operator.approvals"] },
  { name: "unavailable method", methods: [] },
  { name: "disconnected Gateway", phase: "reconnecting" as const },
])("denies personal visibility for $name at presentation and dispatch", async (denied) => {
  const h = createHarness({
    methods: ["sessions.setInvolvement"],
    scopes: ["operator.sessions.read"],
    ...denied,
  });
  const row = sessionRow(1, { sharingRole: "viewer" });
  expect(
    sessionMenuReasons({ snapshot: h.scope.gateway.snapshot, session: row })["toggle-involving-me"],
  ).toBeDefined();

  await setSessionInvolvement(h.host, row, true, h.scope);

  expect(h.request).not.toHaveBeenCalled();
  expect(h.publishSessionMutationError).toHaveBeenCalledOnce();
  expect(h.host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
});
