import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  initializeSessionReadContext,
  identifiedClient,
} from "./sessions-read-cache.test-support.js";
import {
  callSessionSharingHandler as call,
  sessionSharingTestContext as context,
} from "./sessions-sharing.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("adds, lists, and removes session members without caller-thread SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:sharing-authority";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "sharing-authority",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "owner" },
      },
    );
    const manager = identifiedClient("owner");
    const requestContext = context(vi.fn());
    await initializeSessionReadContext(requestContext);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      expect(
        (
          await call(
            "session.members.add",
            { sessionKey, identityId: "owner" },
            requestContext,
            manager,
          )
        )[0]?.[0],
      ).toBe(true);
      expect(
        (
          await call("session.members.listEvidence", { sessionKey }, requestContext, manager)
        )[0]?.[1],
      ).toMatchObject({ role: "owner", members: [{ identityId: "owner", addedBy: "owner" }] });
      expect(
        (
          await call(
            "session.members.remove",
            { sessionKey, identityId: "owner" },
            requestContext,
            manager,
          )
        )[0]?.[0],
      ).toBe(true);
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      exec.mockRestore();
    }
  });
});

it("refuses revoked managers and dirty membership at the worker commit grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:sharing-guest" },
      {
        sessionId: "sharing-guest",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "guest" },
      },
    );
    for (const method of ["session.members.add", "session.members.remove"] as const) {
      for (const change of ["caller", "role", "dirty"] as const) {
        const sessionKey = `agent:main:${method}-${change}`;
        const scope = { agentId: "main", sessionKey };
        await upsertSessionEntryCore(scope, {
          sessionId: sessionKey,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
        });
        addSessionMember(scope, { identityId: "owner", addedBy: "owner" });
        const manager = identifiedClient(change === "role" ? "admin" : "owner");
        if (change === "role") {
          manager.connect.scopes = ["operator.admin"];
        }
        const requestContext = context(vi.fn());
        await initializeSessionReadContext(requestContext);
        const projection = getSessionRowProjection(requestContext)!;
        const target = projection.sharingTarget({ key: sessionKey, agentId: "main" })!;
        const before = await listSessionMembersInWorker(scope);
        const createAdmission = admission.createSqliteWorkerOperationAdmission;
        let reachedCommit = false;
        const gate = vi
          .spyOn(admission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((callback, attachment) =>
            createAdmission((request, grant) => {
              if (request.stage === "commit") {
                reachedCommit = true;
                if (change === "caller") {
                  manager.invalidated = true;
                } else if (change === "role") {
                  manager.connect.scopes = ["operator.read", "operator.write"];
                } else {
                  sessionChanges.emit({ all: true, scope: "stores" });
                  expect(projection.hasMembership(target.storePath, target.storeKey, "owner")).toBe(
                    true,
                  );
                  expect(
                    projection.sharingTargetState({ key: sessionKey, agentId: "main" }).status,
                  ).toBe("pending");
                }
              }
              return callback(request, grant);
            }, attachment),
          );
        try {
          // Add a new member or remove an existing one so rollback has an observable result.
          await expect(
            call(
              method,
              {
                sessionKey,
                identityId: method === "session.members.add" ? "guest" : "owner",
              },
              requestContext,
              manager,
            ),
          ).rejects.toThrow(
            change === "dirty"
              ? "Session access facts are unavailable"
              : "session ownership changed before sharing mutation",
          );
          expect(reachedCommit, `${method}: ${change}`).toBe(true);
          expect(requestContext.broadcast).not.toHaveBeenCalled();
        } finally {
          gate.mockRestore();
        }
        expect(await listSessionMembersInWorker(scope)).toEqual(before);
      }
    }
  });
});

it("keeps the original session bound while membership preparation yields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:sharing-preparation";
    const scope = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(scope, { sessionId: "original", updatedAt: 1 });
    addSessionMember(scope, { identityId: "guest", addedBy: "owner" });
    const manager = identifiedClient("admin");
    manager.connect.scopes = ["operator.admin"];
    const requestContext = context(vi.fn());
    await initializeSessionReadContext(requestContext);
    const projection = getSessionRowProjection(requestContext)!;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const prepare = projection.prepareMembership.bind(projection);
    vi.spyOn(projection, "prepareMembership").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      await prepare();
    });
    sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: "category" });
    const pending = call(
      "session.members.remove",
      { sessionKey, identityId: "guest" },
      requestContext,
      manager,
    );
    const outcome = pending.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "sharing skipped membership preparation",
      );
      replaceSessionEntrySync(scope, { sessionId: "replacement", updatedAt: Date.now() });
      addSessionMember(scope, { identityId: "guest", addedBy: "replacement-owner" });
    } finally {
      release.resolve();
    }
    expect(await outcome).toMatchObject({ message: "session changed before sharing mutation" });
    expect(await listSessionMembersInWorker(scope)).toMatchObject([
      { identityId: "guest", addedBy: "replacement-owner" },
    ]);
    expect(requestContext.broadcast).not.toHaveBeenCalled();
  });
});
