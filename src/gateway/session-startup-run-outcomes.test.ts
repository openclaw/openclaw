import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { prepareGatewayStartupSessions } from "./server-startup-session-migration.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-startup-run-outcomes-");

it("settles legacy liveness once before startup returns, preserving recovery claims and history", async () => {
  const stateDir = tempDirs.make();
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_AGENT_DIR: undefined,
    },
    async () => {
      const env = { ...process.env };
      const databaseOptions = { agentId: "main", env };
      const cfg = { agents: { entries: { main: {} } } };
      const log = { info: vi.fn(), warn: vi.fn() };
      const recovery: Partial<InternalSessionEntry> = {
        mainRestartRecovery: { cycleId: "original-cycle", revision: 3, chargedAttempts: 1 },
        restartRecoveryRuns: [{ runId: "original-run", lifecycleGeneration: "predecessor" }],
        restartRecoveryBeforeAgentReplyState: "admitted",
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryRunId: "delivery-run",
        restartRecoveryDeliverySourceRunId: "source-run",
      };
      const residue = [
        { name: "spawned", fields: { spawnDepth: 1 } },
        { name: "role-spawned", fields: { subagentRole: "leaf" } },
        {
          name: "abort-only",
          fields: { abortedLastRun: true, restartRecoveryForceSafeTools: true },
        },
        { name: "archived-unclaimed", fields: { archivedAt: 15 } },
        {
          name: "archived",
          fields: {
            ...recovery,
            archivedAt: 15,
            endedAt: 15,
            pendingFinalDelivery: { kind: "replayable", text: "Retained final", createdAt: 15 },
          },
        },
      ] satisfies { name: string; fields: Partial<InternalSessionEntry> }[];
      const legacy = [
        {
          sessionKey: "agent:main:main",
          sessionId: "main-run",
          status: "running",
          fields: recovery,
        },
        {
          sessionKey: "agent:main:dashboard:unclaimed-queued",
          sessionId: "unclaimed-queued",
          status: "queued",
          fields: {},
        },
        ...["dashboard:work", "subagent:child"].flatMap((kind) =>
          (["running", "queued"] as const).map((status) => ({
            sessionKey: `agent:main:${kind}:${status}`,
            sessionId: `${kind}-${status}`,
            status,
            fields: recovery,
          })),
        ),
        ...residue.map(({ name, fields }) => ({
          sessionKey: `agent:main:dashboard:${name}`,
          sessionId: name,
          status: "running" as const,
          fields,
        })),
      ];
      const controls = (["done", "failed"] as const).map((status) => ({
        sessionKey: `agent:main:dashboard:${status}`,
        sessionId: `terminal-${status}`,
        status,
        fields: recovery,
      }));
      const fixtures = [...legacy, ...controls];
      const before = new Map<string, InternalSessionEntry>();
      const history = new Map<string, Awaited<ReturnType<typeof loadTranscriptEvents>>>();
      for (const fixture of fixtures) {
        const scope = { ...databaseOptions, ...fixture };
        replaceSessionEntrySync(scope, {
          sessionId: fixture.sessionId,
          updatedAt: 20,
          startedAt: 10,
          status: fixture.status === "failed" ? "failed" : "done",
          lifecycleRevision: "original-revision",
          lifecycleRunId: "original-run",
          ...fixture.fields,
        });
        await persistSessionTranscriptTurn(scope, {
          messages: [
            { eventId: "retained-message", message: { role: "user", content: "retained history" } },
          ],
          touchSessionEntry: false,
        });
        before.set(fixture.sessionKey, loadSessionEntryReadOnly(scope)!);
        history.set(fixture.sessionKey, await loadTranscriptEvents(scope));
      }
      const database = openOpenClawAgentDatabase(databaseOptions);
      // Model a previous release's bytes; canonical writers accept outcomes only.
      const update = database.db.prepare(
        "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.status', ?) WHERE session_key = ?",
      );
      const certify = database.db.prepare(
        "UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?",
      );
      for (const fixture of legacy) {
        update.run(fixture.status, fixture.sessionKey);
        // The previous release's canonical writer certified these rows; raw fixture edits revoke it.
        certify.run(fixture.sessionKey);
      }
      await closeOpenClawAgentDatabasesAsync(stateDir);

      await prepareGatewayStartupSessions({ cfg, env, log });

      const first = new Map<string, InternalSessionEntry>();
      for (const fixture of fixtures) {
        const scope = { ...databaseOptions, ...fixture };
        const entry = loadSessionEntryReadOnly(scope)!;
        first.set(fixture.sessionKey, entry);
        if (fixture.status === "running" || fixture.status === "queued") {
          expect(entry).toEqual({
            ...before.get(fixture.sessionKey),
            status: "interrupted",
            abortedLastRun: true,
            endedAt: before.get(fixture.sessionKey)?.endedAt ?? 20,
            lastRunError: expect.stringMatching(/interrupt|restart|Gateway/i),
            ...(fixture.sessionId === "abort-only"
              ? {
                  mainRestartRecovery: {
                    cycleId: expect.any(String),
                    revision: 1,
                    chargedAttempts: 0,
                  },
                }
              : {}),
          });
        } else {
          expect(entry).toEqual(before.get(fixture.sessionKey));
        }
        expect(await loadTranscriptEvents(scope)).toEqual(history.get(fixture.sessionKey));
      }
      expect(log.warn).not.toHaveBeenCalled();
      const notices = log.info.mock.calls.filter(([message]) => /interrupt/i.test(message));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.[0]).toMatch(/\b11\b/);

      log.info.mockClear();
      await closeOpenClawAgentDatabasesAsync(stateDir);
      await prepareGatewayStartupSessions({ cfg, env, log });

      for (const fixture of fixtures) {
        expect(loadSessionEntryReadOnly({ ...databaseOptions, ...fixture })).toEqual(
          first.get(fixture.sessionKey),
        );
      }
      expect(log.info.mock.calls.filter(([message]) => /interrupt/i.test(message))).toEqual([]);
      expect(log.warn).not.toHaveBeenCalled();
    },
  );
});
