// Reclamation transaction attribution tests cover slow-hold log labels (#157686).
import { describe, expect, it, vi } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import { reclaimSessionMaintenanceInTransaction } from "./session-accessor.sqlite-maintenance-transaction.js";
import {
  createSessionMaintenanceFinalizationOperation,
  createSessionMaintenancePlanningOperation,
} from "./session-accessor.sqlite-reclamation.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

vi.mock("../../state/openclaw-agent-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-db.js")>();
  return {
    ...actual,
    runOpenClawAgentWriteTransaction: vi.fn(
      (
        operation: Parameters<typeof actual.runOpenClawAgentWriteTransaction>[0],
        options: Parameters<typeof actual.runOpenClawAgentWriteTransaction>[1],
        transactionOptions?: Parameters<typeof actual.runOpenClawAgentWriteTransaction>[2],
      ) => actual.runOpenClawAgentWriteTransaction(operation, options, transactionOptions),
    ),
  };
});

// The production call forwards databaseLabel through to the immediate
// transaction options even though the wrapper parameter type omits it, so the
// spy reads the runtime shape directly.
function lastTransactionOptions():
  | (Record<string, unknown> & { operationLabel?: string; databaseLabel?: string })
  | undefined {
  const calls = vi.mocked(runOpenClawAgentWriteTransaction).mock.calls;
  return calls.at(-1)?.[2] as
    | (Record<string, unknown> & { operationLabel?: string; databaseLabel?: string })
    | undefined;
}

describe("reclaimSessionMaintenanceInTransaction slow-hold attribution", () => {
  it("labels the maintenance-plan write transaction with store and operation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = `${state.sessionsDir()}/sessions.json`;
      replaceSessionEntrySync(
        { sessionKey: "agent:main:attribution-active", storePath },
        { sessionId: "active", updatedAt: Date.now() },
      );
      const plan = createSessionMaintenancePlanningOperation({
        databaseOptions: { agentId: "main", env: state.env },
        input: {
          activeSessionKey: "agent:main:attribution-active",
          archiveDirectory: state.sessionsDir(),
          maintenance: resolveMaintenanceConfigFromInput({
            mode: "enforce",
            maxEntries: 100,
            pruneAfter: "1s",
          }),
          preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] },
          storePath,
        },
      });

      expect(reclaimSessionMaintenanceInTransaction(plan, {})).toMatchObject({
        kind: "maintenance-plan",
      });
      expect(lastTransactionOptions()).toMatchObject({
        operationLabel: "session.reclamation.maintenance-plan",
        databaseLabel: plan.databaseOptions.path,
      });
      // The resolved store path must be a real file location for log attribution.
      expect(String(lastTransactionOptions()?.databaseLabel)).toContain("openclaw");
    });
  });

  it("labels the finalization write transaction", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = `${state.sessionsDir()}/sessions.json`;
      const removed = { sessionKey: "agent:main:attribution-removed", storePath };
      replaceSessionEntrySync(removed, { sessionId: "removed", updatedAt: 1 });
      const plan = createSessionMaintenanceFinalizationOperation({
        agentId: "main",
        databaseOptions: { agentId: "main", env: state.env },
        entries: [{ sessionKey: removed.sessionKey, expectedEntry: loadSessionEntry(removed) }],
        materializedPlans: [],
      });

      expect(reclaimSessionMaintenanceInTransaction(plan, {})).toMatchObject({
        kind: "maintenance-finalize",
      });
      expect(lastTransactionOptions()).toMatchObject({
        operationLabel: "session.reclamation.finalize",
      });
      const resolved = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      expect(lastTransactionOptions()).toMatchObject({ databaseLabel: resolved.path });
    });
  });
});
