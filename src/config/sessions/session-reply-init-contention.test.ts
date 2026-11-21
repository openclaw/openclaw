import path from "node:path";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadReplySessionInitializationSnapshot } from "./session-accessor.reset.js";
import * as archives from "./session-accessor.sqlite-archive.js";

it("initializes twelve independent sessions while unrelated archive work is held", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const initialize = (agentId: string, name: string) => {
      const storePath = path.join(state.sessionsDir(agentId), "sessions.json");
      return initSessionState({
        cfg: { session: { store: storePath } },
        commandAuthorized: true,
        ctx: finalizeInboundContext({ Body: "hello", SessionKey: `agent:${agentId}:${name}` }),
      });
    };
    // Admission may legitimately use archive validation before the stores are ready.
    for (const agentId of ["main", "other"]) {
      await initialize(agentId, "warmup");
    }
    const held = createDeferredCore();
    const release = createDeferredCore();
    const queuedArchive = createDeferredCore();
    const runArchive = archives.runExclusiveSqliteTranscriptArchiveWorker;
    const archive = runArchive(async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const observer = vi
      .spyOn(archives, "runExclusiveSqliteTranscriptArchiveWorker")
      .mockImplementation((...args) => {
        queuedArchive.resolve();
        return runArchive(...args);
      });
    const turns = Array.from({ length: 12 }, (_, index) =>
      initialize(index < 6 ? "main" : "other", `first-${index}`),
    );
    try {
      const results = await withinTest(
        Promise.race([
          Promise.all(turns),
          queuedArchive.promise.then(() => {
            throw new Error("reply initialization queued behind unrelated archive work");
          }),
        ]),
        signal,
      );
      expect(new Set(results.map((result) => result.sessionId)).size).toBe(12);
      for (const [index, result] of results.entries()) {
        expect(result.isNewSession).toBe(true);
        const stored = await loadReplySessionInitializationSnapshot({
          agentId: index < 6 ? "main" : "other",
          sessionKey: result.sessionKey,
          storePath: result.storePath,
        });
        expect(stored.currentEntry?.sessionId).toBe(result.sessionId);
      }
    } finally {
      observer.mockRestore();
      release.resolve();
      await archive;
      await Promise.allSettled(turns);
    }
  });
});
