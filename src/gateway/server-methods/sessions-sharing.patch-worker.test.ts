import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as entryPatch from "../../config/sessions/session-entry-patch.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import * as lifecycle from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadPublicSessionShareTokenCodec } from "../control-ui-public-session-token.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import * as sharingAuthority from "./sessions-sharing-authority.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import { identifiedClient, sessionSharingTestContext } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

type PatchMethod = "session.visibility.set" | "session.publicShare.set";

// Foreign fixture writes clear canonical certification; inspect their persisted aftermath directly.
function readRawEntry(database: DatabaseSync, sessionKey: string): unknown {
  const row = database
    .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
    .get(sessionKey);
  return row ? JSON.parse(String(row.entry_json)) : undefined;
}

async function fixture() {
  const scope = { agentId: "main", sessionKey: "agent:main:sharing-patch-worker" };
  const sessionId = "sharing-patch-worker";
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: "owner" },
  });
  await closeOpenClawAgentDatabasesAsync();
  const client = identifiedClient("owner");
  const context = sessionSharingTestContext(vi.fn());
  await initializeSessionReadContext(context);
  const codec = await loadPublicSessionShareTokenCodec();
  return {
    scope,
    sessionId,
    client,
    context,
    codec,
    async call(method: PatchMethod, patch: Record<string, unknown>, respond = vi.fn<RespondFn>()) {
      const params = {
        ...scope,
        ...(method === "session.publicShare.set" ? { expectedSessionId: sessionId } : {}),
        ...patch,
      };
      await getSessionRowProjection(context)!.prepareSelection();
      const { authorization, error } = resolveSessionMutationAuthorization({
        client,
        context,
        method,
        requestParams: params,
      });
      expect(error).toBeNull();
      await sessionSharingHandlers[method]!({
        req: { type: "req", id: "sharing-patch", method, params },
        params,
        client,
        context,
        isWebchatConnect: () => true,
        sessionMutationAuthorization: authorization,
        respond,
      });
      return respond;
    },
  };
}

it("limits sharing caller-thread SQLite to the final stored-authority read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture();
    const sql = observeMainThreadSql();
    const prepareAccess = sharingAuthority.prepareManagedSessionAccess;
    let finalReadSqlCalls = 0;
    vi.spyOn(sharingAuthority, "prepareManagedSessionAccess").mockImplementation(async (params) => {
      const access = await prepareAccess(params);
      if (access) {
        const read = access.currentStored;
        vi.spyOn(access, "currentStored").mockImplementation(() => {
          sql.expectIdle();
          try {
            return read();
          } finally {
            finalReadSqlCalls += sql.count();
            sql.clear();
          }
        });
      }
      return access;
    });
    try {
      for (const visibility of ["draft", "shared"]) {
        const response = await f.call("session.visibility.set", { visibility });
        expect(response).toHaveBeenCalledWith(
          true,
          { ok: true, sessionKey: f.scope.sessionKey, visibility },
          undefined,
        );
        expect((await readSessionMembersInWorker(f.scope)).entry?.visibility).toBe(visibility);
      }
      let shareId: string | undefined;
      for (const enabled of [true, true, false]) {
        const response = await f.call("session.publicShare.set", { enabled });
        expect(response.mock.calls[0]?.[0]).toBe(true);
        const result = response.mock.calls[0]?.[1];
        const stored = (await readSessionMembersInWorker(f.scope)).entry?.publicShare;
        if (enabled) {
          expect(stored?.id).toEqual(expect.any(String));
          if (shareId) {
            expect(stored?.id).toBe(shareId);
          }
          shareId = stored?.id;
          expect(isRecord(result) && isRecord(result.publicShare)).toBe(true);
          if (!isRecord(result) || !isRecord(result.publicShare)) {
            throw new Error("Missing public share response");
          }
          expect(f.codec.resolve(String(result.publicShare.token))).toEqual({
            ...f.scope,
            sessionId: f.sessionId,
            shareId,
          });
        } else {
          expect(stored).toBeUndefined();
        }
      }
      sql.expectIdle();
      expect(finalReadSqlCalls).toBeGreaterThan(0);
    } finally {
      sql.restore();
    }
  });
});

it.each([
  ["session.visibility.set", "caller"],
  ["session.visibility.set", "policy"],
  ["session.publicShare.set", "caller"],
] as const)(
  "rolls back %s when %s authority is revoked at the worker commit grant",
  async (method, revoked) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await fixture();
      const before = await readSessionMembersInWorker(f.scope);
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      let reachedCommit = false;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          createAdmission((request, grant) => {
            if (
              request.stage === "commit" &&
              isRecord(request.facts) &&
              isRecord(request.facts.publication) &&
              request.facts.publication.kind === "session-entry-patch-committed"
            ) {
              reachedCommit = true;
              if (revoked === "caller") {
                f.client.invalidated = true;
              } else {
                const cfg = f.context.getRuntimeConfig();
                cfg.session = { ...cfg.session, sharing: { drafts: false } };
              }
            }
            callback(request, grant);
          }, attachment),
      );
      await expect(
        f.call(
          method,
          method === "session.visibility.set" ? { visibility: "draft" } : { enabled: true },
        ),
      ).rejects.toThrow();
      expect(reachedCommit).toBe(true);
      expect(await readSessionMembersInWorker(f.scope)).toEqual(before);
      expect(f.context.broadcast).not.toHaveBeenCalled();
    });
  },
);

it.each(["caller", "foreign row", "revoked grant", "deleted row", "replaced generation"] as const)(
  "withholds a committed public-share token if %s authority is revoked during lifecycle cleanup",
  async (revoked) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await fixture();
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      await readSessionMembersInWorker(f.scope);
      const run = lifecycle.runExclusiveSessionLifecycleMutation;
      let acknowledgedShareId: string | undefined;
      vi.spyOn(lifecycle, "runExclusiveSessionLifecycleMutation").mockImplementationOnce(
        async (operation, params) => {
          const result = await run(operation, params);
          const committed = (await readSessionMembersInWorker(f.scope)).entry?.publicShare;
          expect(committed?.sessionId).toBe(f.sessionId);
          acknowledgedShareId = committed?.id;
          if (revoked === "caller") {
            f.client.invalidated = true;
          } else {
            const writer = new DatabaseSync(database.path);
            try {
              if (revoked === "deleted row") {
                writer.exec("PRAGMA foreign_keys = ON");
              }
              const changed =
                revoked === "foreign row"
                  ? writer
                      .prepare(
                        "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.createdActor.id', ?, '$.visibility', 'draft') WHERE session_key = ?",
                      )
                      .run("replacement-owner", f.scope.sessionKey)
                  : revoked === "revoked grant"
                    ? writer
                        .prepare(
                          "UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.publicShare') WHERE session_key = ?",
                        )
                        .run(f.scope.sessionKey)
                    : revoked === "deleted row"
                      ? writer
                          .prepare("DELETE FROM session_nodes WHERE session_key = ?")
                          .run(f.scope.sessionKey)
                      : writer
                          .prepare(
                            "UPDATE session_nodes SET current_session_id = ?, entry_json = json_set(entry_json, '$.sessionId', ?) WHERE session_key = ?",
                          )
                          .run("replacement-session", "replacement-session", f.scope.sessionKey);
              expect(changed.changes).toBe(1);
            } finally {
              writer.close();
            }
          }
          return result;
        },
      );
      const respond = vi.fn<RespondFn>();
      const refusal =
        revoked === "revoked grant"
          ? "session publication changed before sharing response"
          : revoked === "deleted row" || revoked === "replaced generation"
            ? "session changed before sharing mutation"
            : "session ownership changed before sharing mutation";
      await expect(f.call("session.publicShare.set", { enabled: true }, respond)).rejects.toThrow(
        refusal,
      );
      expect(acknowledgedShareId).toEqual(expect.any(String));
      expect(respond).not.toHaveBeenCalled();
      const entry = readRawEntry(database.db, f.scope.sessionKey);
      if (revoked === "deleted row") {
        expect(entry).toBeUndefined();
      } else if (revoked === "revoked grant") {
        expect(entry).toMatchObject({ sessionId: f.sessionId });
        expect(entry).not.toHaveProperty("publicShare");
      } else if (revoked === "replaced generation") {
        expect(entry).toMatchObject({ sessionId: "replacement-session" });
      } else {
        expect(entry).toMatchObject({
          publicShare: { id: acknowledgedShareId, sessionId: f.sessionId },
        });
      }
      if (revoked === "foreign row") {
        expect(entry).toMatchObject({
          createdActor: { id: "replacement-owner" },
          visibility: "draft",
        });
      }
    });
  },
);

it.each(["session.visibility.set", "session.publicShare.set"] as const)(
  "refuses %s after a foreign ownership change between preparation and commit",
  async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await fixture();
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const patch = entryPatch.patchSessionEntryInWorker;
      let changed = false;
      vi.spyOn(entryPatch, "patchSessionEntryInWorker").mockImplementation((params) =>
        patch({
          ...params,
          async prepare(snapshot) {
            const prepared = await params.prepare(snapshot);
            const writer = new DatabaseSync(database.path);
            try {
              writer
                .prepare(
                  "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.createdActor.id', ?) WHERE session_key = ?",
                )
                .run("replacement-owner", f.scope.sessionKey);
              changed = true;
            } finally {
              writer.close();
            }
            return prepared;
          },
        }),
      );
      await expect(
        f.call(
          method,
          method === "session.visibility.set" ? { visibility: "draft" } : { enabled: true },
        ),
      ).rejects.toThrow();
      expect(changed).toBe(true);
      const entry = readRawEntry(database.db, f.scope.sessionKey);
      expect(entry).toMatchObject({ createdActor: { id: "replacement-owner" } });
      expect(entry).not.toHaveProperty("visibility");
      expect(entry).not.toHaveProperty("publicShare");
      expect(f.context.broadcast).not.toHaveBeenCalled();
    });
  },
);
