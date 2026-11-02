import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import * as identityFiles from "../../agents/identity-file.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

it("searches configured assistant names without waiting for workspace presentation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: { identity: { name: "Research" } } } } };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:topic";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId: "topic", updatedAt: 1, visibility: "shared" },
    );
    const release = retainSessionListForegroundWork();
    const context = requestContext(cfg);
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    const client = identifiedClient("search-viewer");
    const entered = createDeferredCore();
    const workspace = createDeferredCore<identityFiles.AgentIdentityFile | null>();
    const read = vi
      .spyOn(identityFiles, "loadAgentIdentityFromWorkspaceAsync")
      .mockImplementation(() => {
        entered.resolve();
        return workspace.promise;
      });
    let pending: ReturnType<typeof listSessions> | undefined;
    try {
      await projection.ensureMaterialized();
      const started = performance.now();
      pending = listSessions({
        context,
        client,
        request: { agentId: "main", search: "Research", limit: 1 },
      });
      const winner = await Promise.race([
        pending.then(() => "response" as const),
        entered.promise.then(() => "workspace-read" as const),
      ]);
      console.info("session search identity boundary", {
        winner,
        elapsedMs: performance.now() - started,
        workspaceReadHeld: winner === "workspace-read",
      });
      expect(winner).toBe("response");
      expect((await pending).sessions.map((row) => row.key)).toEqual([key]);
    } finally {
      workspace.resolve({ name: "Workspace", emoji: "🔭" });
      await pending;
      read.mockRestore();
      projection.dispose();
      release();
    }
  });
});
