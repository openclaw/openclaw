import { expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  authorizationClient,
  sendAuthorizationRequest,
} from "../server-methods.authorization.test-support.js";
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

it.each([
  ["transaction", "scope", "FORBIDDEN"],
  ["commit", "scope", "FORBIDDEN"],
  ["commit", "connection", "UNAVAILABLE"],
] as const)(
  "refuses creation at %s admission after %s revocation",
  async (stage, revocation, code) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await ensureSessionGroupCatalog();
      const client = authorizationClient("revoked-creator", ["operator.write"]);
      let revoked = false;
      const hook = probe.admission(admission, (request, grant, callback) => {
        if (request.stage === stage) {
          revoked = true;
          if (revocation === "scope") {
            client.connect.scopes = ["operator.read"];
          } else {
            client.invalidated = true;
          }
        }
        callback(request, grant);
      });
      try {
        const response = await sendAuthorizationRequest(
          "sessions.groups.create",
          { name: "Refused" },
          { client },
        );
        expect(revoked).toBe(true);
        expectRejectedOnce(response, { code });
        expect(readSessionGroupCatalog().groups).toEqual([]);
      } finally {
        hook.mockRestore();
      }
    });
  },
);
