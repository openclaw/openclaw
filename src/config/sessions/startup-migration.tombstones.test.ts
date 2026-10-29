import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { repairLegacySessionEntryStates } from "../../commands/doctor-session-delivery-state.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  loadExactSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { resolveSessionWorkStartBlock } from "./session-work-start.js";
import { runSessionStartupMigration } from "./startup-migration.js";

it.each(["startup", "doctor"] as const)(
  "%s settles every legacy tombstone shape and admits the preserved root",
  async (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const shapes: Record<string, Record<string, unknown>> = {
        bare: {},
        continuation: {
          recoveredSessionId: "finished-continuation",
          recoveredSessionKey: "agent:continuation:dashboard:finished",
        },
        pending: { pendingFinalDelivery: true, pendingFinalDeliveryText: "Unsent final" },
        canonical: {
          pendingFinalDelivery: {
            kind: "replayable",
            text: "Uncertain final",
            createdAt: 42,
            intentId: "old-final",
            context: { channel: "telegram", to: "synthetic-recipient" },
          },
        },
        delivery: { restartRecoveryDeliveryRunId: "old-delivery" },
        settled: {
          pendingFinalDelivery: {
            kind: "transport-only",
            createdAt: 42,
            deliveries: [{ id: "sent-final", state: "delivered" }],
          },
        },
        fences: {
          restartRecoveryRuns: Array.from({ length: 8 }, (_, index) => ({ runId: `old-${index}` })),
          activeWriterRunId: "old-0",
          lifecycleRunId: "old-0",
        },
        archived: { archivedAt: 42, archiveReason: "restart-recovery" },
      };
      const cfg = {
        agents: { entries: Object.fromEntries(Object.keys(shapes).map((id) => [id, {}])) },
      };
      setRuntimeConfigSnapshot(cfg);
      await state.writeConfig(cfg);
      const fixtures = Object.entries(shapes).map(([agentId, fields]) => {
        const scope = { agentId, sessionKey: `agent:${agentId}:main`, env: state.env };
        replaceSessionEntrySync(scope, { sessionId: agentId, updatedAt: 42 });
        expect(
          appendTranscriptMessageSync(
            { ...scope, sessionId: agentId },
            { message: { role: "user", content: "Preserve this conversation" } },
          ).ok,
        ).toBe(true);
        const transcript = loadTranscriptEventsSync({ ...scope, sessionId: agentId });
        const database = openOpenClawAgentDatabase(scope);
        const { recoveredSessionId, recoveredSessionKey, ...residue } = fields;
        const entry = {
          sessionId: agentId,
          updatedAt: 42,
          status: "failed",
          abortedLastRun: false,
          ...residue,
          mainRestartRecovery: {
            cycleId: "old-cycle",
            tombstone: {
              reason: "delegated recovery sender authority is unavailable",
              recoveredSessionId,
              recoveredSessionKey,
            },
          },
        };
        const raw = JSON.stringify(entry);
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(raw, scope.sessionKey);
        return { scope, database, raw, transcript };
      });
      const log = { info: vi.fn(), warn: vi.fn() };
      const run = () =>
        mode === "startup"
          ? runSessionStartupMigration({ cfg, env: state.env, log })
          : repairLegacySessionEntryStates({ apply: true, cfg, env: state.env });
      await run();
      expect(
        fixtures.map(
          ({ database, scope }) =>
            JSON.parse(
              String(
                database.db
                  .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
                  .get(scope.sessionKey)?.entry_json,
              ),
            ).mainRestartRecovery,
        ),
      ).toEqual(Array(fixtures.length).fill(undefined));
      for (const { scope, database, raw, transcript } of fixtures) {
        const stored = JSON.parse(
          String(
            database.db
              .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
              .get(scope.sessionKey)?.entry_json,
          ),
        );
        expect(Object.keys(stored).filter((key) => key.startsWith("restartRecovery"))).toEqual([]);
        expect(stored).not.toHaveProperty("activeWriterRunId");
        expect(stored).not.toHaveProperty("pendingFinalDelivery");
        if (scope.agentId === "pending" || scope.agentId === "canonical") {
          expect(stored.lastRunError).toContain("unknown outcome");
        }
        if (scope.agentId === "canonical") {
          expect(stored.pendingDeliveryNotice).toMatchObject({
            intentId: "old-final",
            state: "owed",
          });
        }
        if (scope.agentId === "settled") {
          expect(stored.lastRunError).toBeUndefined();
          expect(stored.pendingDeliveryNotice).toBeUndefined();
        }
        expect(stored.resumeAfterRestart).toEqual({ queuedInputIds: [] });
        const entry = loadExactSessionEntry(scope)?.entry;
        expect(entry?.sessionId).toBe(scope.agentId);
        expect(resolveSessionWorkStartBlock(scope.sessionKey, entry)).toBeUndefined();
        expect(loadTranscriptEventsSync({ ...scope, sessionId: scope.agentId })).toEqual(
          transcript,
        );
        const backupName = fs
          .readdirSync(path.dirname(database.path))
          .find((name) =>
            name.startsWith(`${path.basename(database.path)}.pre-startup-migration-`),
          );
        expect(backupName).toBeDefined();
        using backup = new DatabaseSync(path.join(path.dirname(database.path), backupName!), {
          readOnly: true,
        });
        expect(
          backup
            .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
            .get(scope.sessionKey)?.entry_json,
        ).toBe(raw);
      }
      await run();
      if (mode === "startup") {
        expect(log.warn).toHaveBeenCalledTimes(fixtures.length);
      }
    }),
);

it("preserves live claims and keeps a manual archive gated after recovery", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { guarded: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const scope = { agentId: "guarded", sessionKey: "agent:guarded:main", env: state.env };
    replaceSessionEntrySync(scope, { sessionId: "guarded", updatedAt: 42 });
    const database = openOpenClawAgentDatabase(scope);
    const raw = JSON.stringify({
      sessionId: "guarded",
      updatedAt: 42,
      status: "failed",
      archivedAt: 42,
      archiveReason: "manual",
      activeWriterRunId: "live-owner",
      restartRecoveryRuns: [{ runId: "live-owner" }],
      mainRestartRecovery: { tombstone: { reason: "retired authority" } },
    });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run(raw, scope.sessionKey);
    const claim = claimAgentRunContext(
      "live-owner",
      { ...scope, sessionId: "guarded" },
      { trackOwner: true, ownsContext: true },
    );
    try {
      await runSessionStartupMigration({ cfg, env: state.env, log: { info() {}, warn() {} } });
      expect(
        await repairLegacySessionEntryStates({ apply: true, cfg, env: state.env }),
      ).toMatchObject({ found: 0 });
      expect(
        database.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(scope.sessionKey)?.entry_json,
      ).toBe(raw);
    } finally {
      releaseAgentRunContext("live-owner", claim);
    }
    await repairLegacySessionEntryStates({ apply: true, cfg, env: state.env });
    const entry = loadExactSessionEntry(scope)?.entry;
    expect(entry?.resumeAfterRestart).toBeUndefined();
    expect(resolveSessionWorkStartBlock(scope.sessionKey, entry)?.reason).toBe("archived");
  }));
