import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as notes from "../../../packages/terminal-core/src/note.js";
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
import { runSessionStartupMigration } from "./startup-migration-runtime.js";

it.each(["startup", "doctor"] as const)(
  "%s retires only custody linked to the tombstoned generation, idempotently",
  async (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { guarded: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const database = openOpenClawAgentDatabase({ agentId: "guarded", env: state.env });
      const rows = ["matching", "newer", "new-delivery", "foreign-fence", "reused", "unlinked"].map(
        (kind) => {
          const sessionKey = `agent:guarded:${kind}`;
          replaceSessionEntrySync(
            { agentId: "guarded", env: state.env, sessionKey },
            { sessionId: kind, updatedAt: 42 },
          );
          const runId = kind === "newer" ? "new-run" : "old-run";
          const entry = {
            sessionId: kind,
            updatedAt: 42,
            status: "interrupted",
            lifecycleRevision: "current-revision",
            activeWriterRunId: runId,
            lifecycleRunId: runId,
            pendingFinalDelivery: {
              kind: "replayable",
              text: "Preserve generation-owned final",
              createdAt: 42,
              sourceRunId: kind === "new-delivery" ? "new-final" : runId,
            },
            restartRecoveryDeliveryRunId: runId,
            restartRecoveryRuns: [
              {
                runId: "old-run",
                lifecycleGeneration: kind === "reused" ? "new-generation" : "old-generation",
              },
              ...(kind === "foreign-fence"
                ? [{ runId: "new-run", lifecycleGeneration: "new-generation" }]
                : []),
            ],
            mainRestartRecovery: {
              cycleId: "old-cycle",
              ...(kind === "unlinked"
                ? {}
                : {
                    executionIdentity: {
                      tokenVersion: 1,
                      contextId: "old-context",
                      executionId: "old-execution",
                      runId: "old-run",
                      createdAt: 1,
                    },
                    foregroundClaims: {
                      lifecycleGeneration: "old-generation",
                      tokens: ["old-claim"],
                      runIdsByClaimId: { "old-claim": "old-run" },
                    },
                  }),
              tombstone: { reason: "delegated recovery sender authority is unavailable" },
            },
          };
          database.db
            .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run(JSON.stringify(entry), sessionKey);
          return { kind, sessionKey, entry };
        },
      );
      const note = vi.spyOn(notes, "note");
      const log = { info: vi.fn(), warn: vi.fn() };
      const run = () =>
        mode === "startup"
          ? runSessionStartupMigration({ cfg, env: state.env, log })
          : repairLegacySessionEntryStates({ apply: true, cfg, env: state.env });
      const read = (sessionKey: string) =>
        String(
          database.db
            .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
            .get(sessionKey)?.entry_json,
        );
      try {
        await run();
        const repaired = JSON.parse(read(rows[0]!.sessionKey));
        expect(repaired).not.toHaveProperty("pendingFinalDelivery");
        expect(repaired).not.toHaveProperty("lifecycleRunId");
        expect(repaired).not.toHaveProperty("restartRecoveryRuns");
        for (const row of rows.slice(1)) {
          expect(JSON.parse(read(row.sessionKey))).toEqual(row.entry);
          expect(
            (mode === "startup" ? log.warn.mock.calls : note.mock.calls).flat().join("\n"),
          ).toContain(row.sessionKey);
        }
        expect(
          (mode === "startup" ? log.warn.mock.calls : note.mock.calls).flat().join("\n"),
        ).toContain("inspect");
        const once = rows.map(({ sessionKey }) => read(sessionKey));
        await run();
        expect(rows.map(({ sessionKey }) => read(sessionKey))).toEqual(once);
      } finally {
        note.mockRestore();
      }
    }),
);

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
            sourceRunId: "old-0",
            createdAt: 42,
            intentId: "old-final",
            context: { channel: "telegram", to: "synthetic-recipient" },
          },
        },
        delivery: { restartRecoveryDeliveryRunId: "old-delivery" },
        settled: {
          pendingFinalDelivery: {
            kind: "transport-only",
            sourceRunId: "old-0",
            createdAt: 42,
            deliveries: [{ id: "sent-final", state: "delivered" }],
          },
        },
        fences: {
          restartRecoveryRuns: Array.from({ length: 8 }, (_, index) => ({
            runId: `old-${index}`,
            lifecycleGeneration: "old-generation",
          })),
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
            executionIdentity: {
              tokenVersion: 1,
              contextId: "old-context",
              executionId: "old-execution",
              runId: agentId === "delivery" ? "old-delivery" : "old-0",
              createdAt: 1,
            },
            ...(agentId === "fences"
              ? {
                  foregroundClaims: {
                    lifecycleGeneration: "old-generation",
                    tokens: [],
                    runIdsByClaimId: {},
                  },
                }
              : {}),
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
      ).toEqual(
        fixtures.map(({ scope }) =>
          scope.agentId === "pending" && mode === "startup"
            ? expect.objectContaining({ tombstone: expect.any(Object) })
            : undefined,
        ),
      );
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
        if (scope.agentId === "pending" && mode === "startup") {
          expect(stored.pendingFinalDelivery).toMatchObject({
            kind: "replayable",
            text: "Unsent final",
          });
        } else {
          expect(stored).not.toHaveProperty("pendingFinalDelivery");
        }
        if (scope.agentId === "canonical") {
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
        expect(stored.resumeAfterRestart).toEqual(
          scope.agentId === "pending" ? undefined : { queuedInputIds: [] },
        );
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
        expect(log.warn).toHaveBeenCalledTimes(fixtures.length + 1);
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
      mainRestartRecovery: {
        executionIdentity: { runId: "live-owner" },
        tombstone: { reason: "retired authority" },
      },
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
