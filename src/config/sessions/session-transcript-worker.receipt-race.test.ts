// A session read captures its database receipt, then dispatches to a worker. If an owner revokes
// the receipt in between, the worker's refusal names that owner.
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("names the owner that revoked a receipt between capture and dispatch", async () => {
  setRuntimeConfigSnapshot({});
  const target = {
    agentId: "main",
    sessionId: "race",
    sessionKey: "agent:main:race",
    storePath: path.join(dirs.make("openclaw-receipt-race-"), "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: "race", updatedAt: 1 });
  const scope = {
    agentId: "main",
    databaseAgentId: "main",
    sessionKey: target.sessionKey,
    storePath: target.storePath,
  };
  const read = (
    prepareRead?: Parameters<typeof withSessionHistoryWorkerDatabase>[0]["prepareRead"],
  ) =>
    withSessionHistoryWorkerDatabase(
      { agentId: "main", path: target.storePath, prepareRead },
      (owner) => owner.readEntryPresence(scope),
    );
  // Warm read: the next read takes the retained lane that borrows the writer's receipt.
  await expect(read()).resolves.toBe(true);
  await expect(
    read((captured) => {
      expect(captured).toBeDefined();
      invalidateOpenClawAgentDatabaseValidation(
        target.storePath,
        "a lease release without a confirmed close",
      );
    }),
  ).rejects.toThrow(
    "Session reader validation does not match its current physical owner: the receipt was revoked by a lease release without a confirmed close",
  );
});
