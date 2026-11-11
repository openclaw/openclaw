import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../../config/sessions/session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "../../config/sessions/session-actor-storage-binding.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invokeHandler } from "./sessions-rewind.handler.test-support.js";
import {
  cfg,
  invokeMessageCut,
  mutationMethods,
  seedMessageCutSource,
  useMessageCutStorageFixture,
} from "./sessions-rewind.storage.test-support.js";

useMessageCutStorageFixture();

const sessionKey = "agent:main:dashboard:incognito-source";
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };

async function expectBranches(branches: [string, boolean][]) {
  const respond = await invokeHandler("sessions.branches.list", undefined, {
    params: { sessionKey },
  });
  const expected = expect.arrayContaining(
    branches.map(([leafEntryId, active]) => expect.objectContaining({ leafEntryId, active })),
  );
  expect(respond).toHaveBeenCalledWith(true, { branches: expected }, undefined);
}

it.each(mutationMethods)("acquires memory history for unbound %s", (method) =>
  withOpenClawTestState({ label: "message-cut-memory-actor" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = expectDefined(
      await withSessionActorStorage(
        { sessionKey, agentId: "main", env: state.env },
        { create: true, lifetime, authority },
        () => seedMessageCutSource(true),
      ),
      "message-cut memory session",
    );
    const captured = expectDefined(captureSessionActorStorageOwner(scope, authority), "owner");
    const sql = observeHostDataSql();
    try {
      await expectBranches([
        ["user-2", true],
        ["alternate-user", false],
      ]);
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
        await expectBranches([
          [method === "sessions.rewind" ? "assistant-1" : "alternate-user", true],
        ]);
      }
      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    } finally {
      sql.restore();
      memorySessionActorOwners.closeDatabase(captured);
    }
  }),
);
