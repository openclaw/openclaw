import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { repairReservedIncognitoSessionKeys } from "../commands/doctor-session-incognito-key-repair.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as entryReaders from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";

afterEach(() => vi.restoreAllMocks());

it("admits a Doctor-renamed legacy key into an already resident store without reloading it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const oldKey = "agent:main:dashboard:incognito-legacy";
    const newKey = "agent:main:dashboard:legacy-incognito-legacy";
    const existingKey = "agent:main:existing";
    const options = { agentId: "main", env: state.env };
    runOpenClawAgentWriteTransaction((database) => {
      writeSessionEntry(database, existingKey, { sessionId: "existing", updatedAt: 1 });
      // The migration writer can represent pre-incognito durable keys in the ordinary store.
      writeSessionEntry(
        database,
        oldKey,
        { sessionId: "legacy", updatedAt: 1, label: "Recovered conversation" },
        { allowStoredAliases: true, previousEntry: null },
      );
    }, options);
    const database = openOpenClawAgentDatabase(options);
    const storedEntry = database.db.prepare(
      "SELECT entry_json FROM session_nodes WHERE session_key = ?",
    );
    const originalEntry = storedEntry.get(oldKey);
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      expect(projection.selectEntries().map((row) => row.key)).toEqual([existingKey]);
      const scans = vi.spyOn(entryReaders, "listSessionEntriesReadOnly");

      await expect(
        repairReservedIncognitoSessionKeys({ apply: true, cfg, env: state.env }),
      ).resolves.toEqual({ found: 1, repaired: 1 });
      await projection.ensureMaterialized();

      // No JSON key references changed, so the ordinary entry rewrite emits nothing.
      expect(storedEntry.get(newKey)).toEqual(originalEntry);
      expect(scans).not.toHaveBeenCalled();
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(projection.selectEntries().map((row) => row.key)).toEqual([newKey, existingKey]);
      expect(projection.snapshot({ agentId: "main", key: newKey }).row).toMatchObject({
        sessionId: "legacy",
        label: "Recovered conversation",
      });
      expect(projection.snapshot({ agentId: "main", key: oldKey }).row).toBeNull();
      expect(prepares).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
    }
  });
});
