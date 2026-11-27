import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sendAuthorizationRequest } from "../server-methods.authorization.test-support.js";
import { expectRejectedOnce } from "../server-methods.request-gate.test-support.js";
import { ensureSessionGroupCatalog, readSessionGroupCatalog } from "../session-group-catalog.js";
import { putSessionGroups, updateSessionGroupDefaults } from "../session-groups.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";

it("adds empty groups concurrently without replacing existing groups, defaults, or order", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sectionOrder = ["work", "category:Existing", "groups"];
    await putSessionGroups({ cfg: {}, names: ["Existing"], sectionOrder });
    await updateSessionGroupDefaults("Existing", { cwd: state.workspaceDir, worktree: true });
    const broadcastToConnIds = vi.fn();
    const subscribers = new Set(["observer"]);
    try {
      const responses = await Promise.all(
        ["First", "Second", " First "].map((name, index) =>
          sendAuthorizationRequest(
            "sessions.groups.create",
            { name },
            {
              connId: `creator-${index}`,
              context: {
                broadcastToConnIds,
                getSessionEventSubscriberConnIds: () => subscribers,
              },
            },
          ),
        ),
      );
      for (const [index, response] of responses.entries()) {
        expect(response).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({
            ok: true,
            groups: expect.arrayContaining([
              { name: "Existing", position: 0 },
              { name: index === 1 ? "Second" : "First", position: expect.any(Number) },
            ]),
            sectionOrder,
          }),
          undefined,
        );
      }
      const catalog = readSessionGroupCatalog();
      expect(catalog.groups).toHaveLength(3);
      expect(catalog.groups[0]).toEqual({ name: "Existing", position: 0 });
      expect(
        catalog.groups
          .slice(1)
          .map(({ name }) => name)
          .toSorted(),
      ).toEqual(["First", "Second"]);
      expect(catalog.defaults).toEqual(
        expect.arrayContaining([{ name: "Existing", cwd: state.workspaceDir, worktree: true }]),
      );
      expect(catalog.sectionOrder).toEqual(sectionOrder);
      await flushPendingSessionsChangedEvents();
      expect(broadcastToConnIds).toHaveBeenCalled();
      for (const call of broadcastToConnIds.mock.calls) {
        expect(call).toEqual([
          "sessions.changed",
          { reason: "groups", ts: expect.any(Number) },
          subscribers,
          expect.objectContaining({ dropIfSlow: true, sessionEventSubscriptionKeys: [] }),
        ]);
      }
    } finally {
      await flushPendingSessionsChangedEvents();
    }
  });
});

it.each([
  ["operator.read", false],
  ["operator.sessions.write", false],
  ["operator.admin", true],
] as const)("requires broad write authority (%s)", async (scope, allowed) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await ensureSessionGroupCatalog();
    const response = await sendAuthorizationRequest(
      "sessions.groups.create",
      { name: "Created" },
      {
        scopes: [scope],
        context: { getSessionEventSubscriberConnIds: () => new Set<string>() },
      },
    );
    if (allowed) {
      expect(response).toHaveBeenCalledExactlyOnceWith(
        true,
        { ok: true, groups: [{ name: "Created", position: 0 }], sectionOrder: [] },
        undefined,
      );
    } else {
      expectRejectedOnce(response, { code: "FORBIDDEN" });
    }
    expect(readSessionGroupCatalog().groups).toEqual(
      allowed ? [{ name: "Created", position: 0 }] : [],
    );
  });
});
