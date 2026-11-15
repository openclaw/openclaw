import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { ensureClientVoiceAgentSessionEntry } from "../talk/client-voice-session-write.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

function expectWithoutHostSql(action: () => void) {
  const sql = observeHostDataSql();
  try {
    action();
    for (const call of sql.calls) {
      expect(call).not.toHaveBeenCalled();
    }
  } finally {
    sql.restore();
  }
}

it.each(["missing", "idless"] as const)(
  "keeps acknowledged %s creation on its committed sharing receipts",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
      const sessionKey = `agent:main:acknowledged-${kind}`;
      const scope = {
        agentId: "main",
        sessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const client = roleClient("view", `creation-receipts-${kind}`);
      const identityId = client.authenticatedUserProfile!.profileId;
      const actor = { type: "human" as const, source: "profile" as const, id: identityId };
      if (kind === "idless") {
        await replaceSessionEntry(scope, { sessionId: "", updatedAt: 1, createdActor: actor });
      }
      const admitted = await resolveSessionMutationAuthorizationAsync({
        method: "talk.client.create",
        requestParams: { sessionKey },
        client,
        context: { getRuntimeConfig: () => cfg } as never,
      });
      expect(admitted.error).toBeNull();
      const authorization = admitted.authorization!;
      const target = authorization.talkSessionTarget!;
      let committedEntry: SessionEntry | undefined;
      try {
        const sessionId = await ensureClientVoiceAgentSessionEntry({
          ...scope,
          storePath: target.storePath,
          creation: { actor },
          source: authorization.assertCurrent,
          prepareWorkerGrant: authorization.prepareWorkerGrant,
          onCommittedSource: (readSource, entry) => {
            committedEntry = entry;
            authorization.recordCreatedSession?.({
              ...scope,
              storePath: target.storePath,
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
              readSource,
              entry,
            });
          },
        });
        expect(committedEntry?.sessionId).toBe(sessionId);
        expect(committedEntry?.createdActor).toEqual(actor);
        expectWithoutHostSql(() => authorization.assertCurrent());
        await addSessionMember(scope, { identityId, addedBy: "other-creator" });
        const restricted = await replaceSessionEntry(scope, {
          ...committedEntry!,
          visibility: "read-only",
          updatedAt: 2,
        });
        expect(restricted?.createdActor).toEqual(actor);
        expectWithoutHostSql(() => authorization.assertCurrent());
        expect(await removeSessionMember(scope, identityId)).toMatchObject({ identityId });
        expectWithoutHostSql(() => authorization.assertCurrent());
        await addSessionMember(scope, { identityId, addedBy: "other-creator" });
        expectWithoutHostSql(() => authorization.assertCurrent());
        await replaceSessionEntry(scope, {
          ...committedEntry!,
          sessionId: "replacement-session",
          updatedAt: 3,
        });
        expectWithoutHostSql(() => expect(() => authorization.assertCurrent()).toThrow());
      } finally {
        authorization.release?.();
      }
    });
  },
);
