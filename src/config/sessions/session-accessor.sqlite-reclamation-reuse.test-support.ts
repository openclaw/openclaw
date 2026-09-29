import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { createLifecycleArtifactReclamationPlan } from "./session-accessor.sqlite-reclamation.js";

export const tempDirs = createTempDirTracker();

export function createFixture(sessionIds = ["first", "second"], agentId = "main") {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("reclamation-reuse-")) };
  const options = { agentId, env };
  const scopes = sessionIds.map((sessionId) => ({
    agentId: options.agentId,
    env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  }));
  for (const scope of scopes) {
    ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  }
  const database = openOpenClawAgentDatabase(options);
  const plans = scopes.map((scope) =>
    createLifecycleArtifactReclamationPlan({
      agentId: "main",
      databaseOptions: { ...options, path: database.path },
      entries: [{ sessionKey: scope.sessionKey, expectedEntry: loadSessionEntryReadOnly(scope) }],
      materializedPlans: [],
    }),
  );
  return { options, scopes, database, plans };
}

export function observeReclamationWorkers(onSpawn?: (worker: Worker) => void) {
  const spawned: Worker[] = [];
  const create = archiveWorker.createSqliteTranscriptArchiveWorker;
  vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
    const worker = create(data);
    spawned.push(worker);
    onSpawn?.(worker);
    return worker;
  });
  return spawned;
}

export function leasesFor(fixture: ReturnType<typeof createFixture>) {
  return openOpenClawStateDatabase({ env: fixture.options.env })
    .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
    .all(fixture.database.path);
}
