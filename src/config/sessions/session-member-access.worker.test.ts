import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
  setSessionMemberAccess,
} from "./session-sharing-store.js";

it("changes only existing member access through the worker and publishes committed facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = { agentId: "main", sessionKey: "agent:main:member-access" };
    const entry = { sessionId: "member-access", updatedAt: 1 };
    await upsertSessionEntryCore(scope, entry);
    const grant = { identityId: "guest", addedBy: "owner", addedAt: 4 };
    await addSessionMember(scope, grant);
    await readSessionMembersInWorker(scope);
    const changes: SessionRowChange[] = [];
    const stop = sessionChanges.subscribeFacts((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === scope.sessionKey &&
        change.facts?.kind === "member"
      ) {
        changes.push(change);
      }
    });
    const sql = observeHostDataSql();
    try {
      const params = {
        identityId: "guest",
        access: "read" as const,
        expectedSessionId: entry.sessionId,
      };
      expect(
        await setSessionMemberAccess(scope, { ...params, identityId: "missing" }),
      ).toBeUndefined();
      expect(await setSessionMemberAccess(scope, params)).toEqual({ changed: true });
      expect(await setSessionMemberAccess(scope, params)).toEqual({
        changed: false,
        previousAccess: "read",
      });
      expect(await setSessionMemberAccess(scope, { ...params, access: "suggest" })).toEqual({
        changed: true,
        previousAccess: "read",
      });
      expect((await readSessionMembersInWorker(scope)).members).toEqual([
        { ...grant, access: "suggest" },
      ]);
      expect(changes.map((change) => ("facts" in change ? change.facts : undefined))).toEqual([
        {
          kind: "member",
          sessionId: entry.sessionId,
          identityId: "guest",
          present: true,
          access: "read",
        },
        {
          kind: "member",
          sessionId: entry.sessionId,
          identityId: "guest",
          present: true,
          access: "suggest",
        },
      ]);
      expect(sql.queries).toEqual([]);
      await expect(
        setSessionMemberAccess(scope, { ...params, expectedSessionId: "stale" }),
      ).rejects.toThrow("session changed");
      await expect(
        setSessionMemberAccess(scope, {
          ...params,
          expectedEntry: { sessionId: entry.sessionId, visibility: "draft" },
        }),
      ).rejects.toThrow("session ownership changed");
      let current = true;
      const observe = probe.admission(admission, (request, authority, callback) => {
        if (request.stage === "commit") {
          current = false;
        }
        callback(request, authority);
      });
      try {
        await expect(
          setSessionMemberAccess(scope, params, () => {
            if (!current) {
              throw new Error("manager revoked");
            }
          }),
        ).rejects.toThrow("manager revoked");
      } finally {
        observe.mockRestore();
      }
      expect(current).toBe(false);
      expect(changes).toHaveLength(2);
    } finally {
      sql.restore();
      stop();
    }
    await closeOpenClawAgentDatabasesAsync();
    expect((await readSessionMembersInWorker(scope)).members).toEqual([
      { ...grant, access: "suggest" },
    ]);
  });
});
