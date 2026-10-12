import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { listSessionBranches } from "../../config/sessions/session-accessor.sqlite-branch-list.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
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

it.each(mutationMethods)("keeps bound %s history in its actor", async (method) => {
  await withOpenClawTestState({ label: "message-cut-bound-actor" }, async (state) => {
    await state.writeConfig(cfg);
    const authority = { assertCurrent() {} };
    const actor = expectDefined(
      await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId: "main",
        env: state.env,
        authority,
      }),
      "message-cut actor",
    );
    try {
      await withIncognitoSessionActor(actor, async () => {
        const scope = await seedMessageCutSource(true);
        const sql = observeHostDataSql();
        try {
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
          expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
        } finally {
          sql.restore();
        }
        const current = (await actor.sessions.read(authority, { sessionKey: scope.sessionKey }))
          .entry;
        if (method === "sessions.fork") {
          expect(current?.sessionId).toBe(scope.sessionId);
        } else {
          expect(current?.previousSessionId).toBe(scope.sessionId);
          expect(current?.sessionId).not.toBe(scope.sessionId);
          const branches = await listSessionBranches({
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
          });
          expect(branches).toMatchObject({
            status: "ok",
            branches: expect.arrayContaining([
              expect.objectContaining({
                active: true,
                leafEntryId: method === "sessions.rewind" ? "assistant-1" : "alternate-user",
              }),
            ]),
          });
        }
      });
    } finally {
      await actor.close();
    }
  });
});

it("lists bound actor branches without opening a native private store", async () => {
  await withOpenClawTestState({ label: "branch-list-bound-actor" }, async (state) => {
    await state.writeConfig(cfg);
    const actor = expectDefined(
      await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId: "main",
        env: state.env,
        authority: { assertCurrent() {} },
      }),
      "branch-list actor",
    );
    try {
      await withIncognitoSessionActor(actor, async () => {
        const scope = await seedMessageCutSource(true);
        const method = "sessions.branches.list";
        const params = { sessionKey: scope.sessionKey };
        const respond = vi.fn<RespondFn>();
        const sql = observeHostDataSql();
        try {
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
          expect(respond).toHaveBeenCalledWith(
            true,
            {
              branches: expect.arrayContaining([
                expect.objectContaining({ leafEntryId: "user-2", active: true }),
                expect.objectContaining({ leafEntryId: "alternate-user", active: false }),
              ]),
            },
            undefined,
          );
          expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
        } finally {
          sql.restore();
        }
      });
    } finally {
      await actor.close();
    }
  });
});
