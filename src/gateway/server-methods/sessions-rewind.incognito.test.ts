import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import {
  cfg,
  invokeMessageCut,
  messageCutContext,
  mutationMethods,
  seedMessageCutSource,
  useMessageCutStorageFixture,
} from "./sessions-rewind.storage.test-support.js";
import type { RespondFn } from "./types.js";

useMessageCutStorageFixture();

const sessionKey = "agent:main:dashboard:incognito-source";
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };

async function listBranches() {
  const method = "sessions.branches.list";
  const params = { sessionKey };
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    sessionRewindHandlers[method],
    method,
  )({
    req: { type: "req", id: "actor-branches", method, params },
    params,
    respond,
    context: messageCutContext(),
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

it.each(mutationMethods)("acquires memory history for unbound %s", async (method) => {
  await withOpenClawTestState({ label: "message-cut-memory-actor" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = expectDefined(
      await withSessionActorStorage(
        { sessionKey, agentId: "main", env: state.env },
        { create: true, lifetime, authority },
        () => seedMessageCutSource(true),
      ),
      "message-cut memory session",
    );
    const captured = expectDefined(
      captureSessionActorStorageOwner(scope, authority),
      "message-cut memory owner",
    );
    const sql = observeHostDataSql();
    try {
      expect(await listBranches()).toHaveBeenCalledWith(
        true,
        {
          branches: expect.arrayContaining([
            expect.objectContaining({ leafEntryId: "user-2", active: true }),
            expect.objectContaining({ leafEntryId: "alternate-user", active: false }),
          ]),
        },
        undefined,
      );
      const mutation = invokeMessageCut(method, scope);
      expect(await mutation.error).toBeUndefined();
      expect(mutation.respond).toHaveBeenCalledWith(
        true,
        method === "sessions.fork"
          ? { sessionKey: expect.stringContaining("incognito-"), editorText: "What did I say?" }
          : method === "sessions.rewind"
            ? { editorText: "What did I say?" }
            : {},
        undefined,
      );
      const current = captured.owner?.readSession(scope.sessionKey, authority)?.entry;
      if (method === "sessions.fork") {
        expect(current?.sessionId).toBe(scope.sessionId);
      } else {
        expect(current?.previousSessionId).toBe(scope.sessionId);
        expect(current?.sessionId).not.toBe(scope.sessionId);
        expect(await listBranches()).toHaveBeenCalledWith(
          true,
          {
            branches: expect.arrayContaining([
              expect.objectContaining({
                active: true,
                leafEntryId: method === "sessions.rewind" ? "assistant-1" : "alternate-user",
              }),
            ]),
          },
          undefined,
        );
      }
      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    } finally {
      sql.restore();
      memorySessionActorOwners.closeDatabase(captured);
    }
  });
});
