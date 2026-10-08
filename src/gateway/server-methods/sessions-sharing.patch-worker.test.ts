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
import { sessionSharingHandlers } from "./sessions-sharing.js";
import { identifiedClient, sessionSharingTestContext } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

type PatchMethod = "session.visibility.set" | "session.publicShare.set";

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
    async call(method: PatchMethod, patch: Record<string, unknown>) {
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
      const respond = vi.fn<RespondFn>();
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

it("patches visibility and public shares without caller-thread SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture();
    const sql = observeMainThreadSql();
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

it("withholds a committed public-share token if the caller is revoked during lifecycle cleanup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture();
    const run = lifecycle.runExclusiveSessionLifecycleMutation;
    let committed = false;
    vi.spyOn(lifecycle, "runExclusiveSessionLifecycleMutation").mockImplementationOnce(
      async (operation, params) => {
        const result = await run(operation, params);
        committed = true;
        f.client.invalidated = true;
        return result;
      },
    );
    await expect(f.call("session.publicShare.set", { enabled: true })).rejects.toThrow();
    expect(committed).toBe(true);
    expect((await readSessionMembersInWorker(f.scope)).entry?.publicShare?.sessionId).toBe(
      f.sessionId,
    );
  });
});

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
      const entry = (await readSessionMembersInWorker(f.scope)).entry;
      expect(entry?.createdActor?.id).toBe("replacement-owner");
      expect(entry?.visibility).toBeUndefined();
      expect(entry?.publicShare).toBeUndefined();
      expect(f.context.broadcast).not.toHaveBeenCalled();
    });
  },
);
