import path from "node:path";
import { expect, it, vi } from "vitest";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readSessionMaintenanceInWorker } from "./session-accessor.sqlite-maintenance-transaction.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

it("reads warm maintenance without a transaction and observes newly committed capacity pressure", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const database = openOpenClawAgentDatabase(options);
    const write = (index: number) =>
      runOpenClawAgentWriteTransaction((writer) => {
        writeSessionEntry(writer, `agent:main:maintenance-${index}`, {
          sessionId: `maintenance-${index}`,
          updatedAt: Date.now(),
        });
      }, options);
    write(0);
    const identity = readOpenClawAgentDatabaseIdentity(database);
    const plan = {
      kind: "maintenance-plan" as const,
      databaseOptions: options,
      expectedIdentity: { key: `file:${String(identity.identity)}`, birthtime: identity.birthtime },
      input: {
        archiveDirectory: path.join(path.dirname(database.path), "archives"),
        storePath: database.path,
        maintenance: resolveMaintenanceConfigFromInput({
          mode: "enforce",
          maxEntries: 1,
          pruneAfter: "1d",
        }),
        preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] },
      },
    };
    expect(readSessionMaintenanceInWorker(plan, database).kind).toBe("maintenance-plan");
    const exec = vi.spyOn(database.db, "exec");
    try {
      expect(readSessionMaintenanceInWorker(plan, database).kind).toBe("maintenance-plan");
      expect(exec.mock.calls).toEqual([]);
      write(1);
      exec.mockClear();
      expect(readSessionMaintenanceInWorker(plan, database)).toEqual({
        kind: "maintenance-write-required",
      });
      expect(exec.mock.calls).toEqual([]);
    } finally {
      exec.mockRestore();
    }
  });
});
