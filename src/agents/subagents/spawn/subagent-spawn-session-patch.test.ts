import path from "node:path";
import { expect, it } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";

it("inherits accepted human credit when participant persistence is still queued", async () => {
  await withOpenClawTestState({ label: "spawn-pending-participant" }, async (state) => {
    const agentId = "main";
    const sessionKey = "agent:main:parent";
    const childSessionKey = "agent:main:subagent:child";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "parent-id", updatedAt: 1 });
    const releaseWriter = createDeferredCore();
    const writerStarted = createDeferredCore();
    const heldWriter = runOpenClawAgentWriteAdmission({ agentId, path: storePath }, async () => {
      writerStarted.resolve();
      await releaseWriter.promise;
    });
    await writerStarted.promise;
    const work = new AsyncWorkScope();
    const errors: unknown[] = [];
    try {
      work.run(() =>
        recordSessionParticipantBestEffort({
          ...scope,
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
          identity: { type: "profile", id: "human-requester" },
          promptedAt: 1,
          onError: (error) => errors.push(error),
        }),
      );
      // The real recorder defers its write to the next microtask. Keep that original order.
      await Promise.resolve();
      expect(loadSessionEntry(scope)?.participants ?? []).toEqual([]);
      const creation = createInitialSubagentSession({
        cfg: {},
        targetAgentId: agentId,
        childSessionKey,
        incognito: false,
        requesterInternalKey: sessionKey,
        creationPolicy: { actor: { type: "agent", id: agentId } },
        completionOwnerSessionKey: sessionKey,
        modelPatch: {},
        collect: false,
      });
      releaseWriter.resolve();
      await heldWriter;
      expect(await creation).toMatchObject({ status: "ok" });
      await work.drain();

      expect(errors).toEqual([]);
      expect(loadSessionEntry(scope)?.participants).toEqual([
        { identity: { type: "profile", id: "human-requester" } },
      ]);
      const child = loadSessionEntry({ ...scope, sessionKey: childSessionKey });
      expect(child?.inheritedGitContributorProfileIds).toEqual(["human-requester"]);
      expect(child?.participants ?? []).toEqual([]);
    } finally {
      releaseWriter.resolve();
      await heldWriter;
      await work.drain();
    }
  });
});
