import { describe, expect, it } from "vitest";
import { withEngineStoreAdmission as admit } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import { observeStatementEvents } from "../../infra/postgres-sync/sql.test-support.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { readSessionMaintenanceAgeQueries } from "./session-accessor.sqlite-maintenance-age-queries.js";
import { recordSessionEntryMaintenanceAgeFact } from "./session-accessor.sqlite-maintenance-age.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe.skipIf(!mixedAgentConnection)("PostgreSQL session maintenance age bounds", () => {
  useMixedAgentPair("postgres", "postgres");

  it.each(["dashboard", "recent"] as const)(
    "bounds %s reads while preserving aliases, timestamp ties, and protected rows",
    (kind) => {
      const options = { agentId: `bounded-${kind}`, env: process.env };
      const database = admit(() => openOpenClawAgentDatabase(options));
      expect(isPostgresSqlConnection(database.db)).toBe(true);
      const now = Date.now();
      const maximum = now - 5 * DAY_MS;
      const maintenance = {
        ...resolveMaintenanceConfigFromInput(),
        pruneAfterMs: 30 * DAY_MS,
        archiveDashboardAfterMs: kind === "dashboard" ? 7 * DAY_MS : null,
        preserveRecentMs: kind === "recent" ? 7 * DAY_MS : null,
      };
      admit(() =>
        runOpenClawAgentWriteTransaction((writer) => {
          const write = (key: string, entry: Partial<SessionEntry> = {}, alias = false) =>
            writeSessionEntry(
              writer,
              key,
              { sessionId: key, updatedAt: now - 8 * DAY_MS, ...entry },
              alias ? { allowStoredAliases: true, canonicalPreviousEntry: null } : undefined,
            );
          write("agent:main:main", { updatedAt: now - 100 * DAY_MS });
          write("agent:main:ordinary", { updatedAt: now - 28 * DAY_MS });
          write("agent:zeta:dashboard:activity", { lastActivityAt: now - 6 * DAY_MS });
          write("agent:main:dashboard:started", { sessionStartedAt: now - 6 * DAY_MS + 1 });
          write("AGENT:MAIN:DASHBOARD:ALIAS", { lastInteractionAt: now - 6 * DAY_MS - 1 }, true);
          const protectedKey = "agent:main:dashboard:protected:thread:t1";
          write(protectedKey, {
            updatedAt: now - 9 * DAY_MS,
            lastActivityAt: now - 7 * DAY_MS + 1,
          });
          for (const [name, delta] of [
            ["before", -1],
            ["equal", 0],
            ["after", 1],
          ] as const) {
            write(`agent:main:dashboard:${name}`, { updatedAt: maximum + delta });
          }
          write("AGENT:MAIN:DASHBOARD:EQUAL", { updatedAt: maximum }, true);
          write("agent:main:dashboard:archived", { archivedAt: now });
          const queries = readSessionMaintenanceAgeQueries(writer.db);
          const rows = Array.from(
            kind === "dashboard"
              ? queries.dashboardsBefore(maximum)
              : queries.activityBefore(maximum),
          );
          const expected = [
            "agent:zeta:dashboard:activity",
            "agent:main:dashboard:started",
            "AGENT:MAIN:DASHBOARD:ALIAS",
            protectedKey,
            "agent:main:dashboard:before",
            ...(kind === "recent" ? ["agent:main:main", "agent:main:ordinary"] : []),
          ];
          expect(rows.map((row) => row.session_key).toSorted()).toEqual(expected.toSorted());
          if (kind === "recent") {
            expect(
              rows
                .filter((row) => row.updated_at === now - 8 * DAY_MS)
                .map((row) => row.session_key),
            ).toEqual([
              "agent:zeta:dashboard:activity",
              "agent:main:dashboard:started",
              "AGENT:MAIN:DASHBOARD:ALIAS",
            ]);
          }
          using observation = observeStatementEvents();
          expect(recordSessionEntryMaintenanceAgeFact(writer, maintenance, now).next.at).toBe(
            now + DAY_MS,
          );
          expect(observation.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                engine: "postgres",
                outcome: "ok",
                sql: expect.stringMatching(/"updated_at" < /),
              }),
            ]),
          );
          expect(readExactSessionEntryRow(writer, protectedKey)?.entry.archivedAt).toBeUndefined();
        }, options),
      );
    },
  );

  it.each([0, Number.MAX_SAFE_INTEGER])(
    "retains activity deadlines without a safe prune bound (%s)",
    (pruneAfterMs) => {
      const options = { agentId: `fallback-${pruneAfterMs}`, env: process.env };
      const now = Date.now();
      admit(() =>
        runOpenClawAgentWriteTransaction((writer) => {
          writeSessionEntry(writer, "agent:zeta:dashboard:active", {
            sessionId: "active-dashboard",
            updatedAt: now - 8 * DAY_MS,
            lastActivityAt: now - 6 * DAY_MS,
          });
          writeSessionEntry(writer, "agent:main:ordinary", {
            sessionId: "recent-ordinary",
            updatedAt: now - 8 * DAY_MS,
            lastActivityAt: now - 6 * DAY_MS - 1,
          });
          expect(
            recordSessionEntryMaintenanceAgeFact(
              writer,
              {
                ...resolveMaintenanceConfigFromInput(),
                pruneAfterMs,
                archiveDashboardAfterMs: 7 * DAY_MS,
                preserveRecentMs: 7 * DAY_MS,
              },
              now,
            ).next.at,
          ).toBe(now + DAY_MS);
        }, options),
      );
    },
  );

  it.each([
    [null, null],
    [0, null],
    [null, 7 * DAY_MS],
    [0, 7 * DAY_MS],
  ])(
    "skips disabled dashboard scans (%s) while retaining recent protection (%s)",
    (dashboardAge, recentAge) => {
      const options = { agentId: `disabled-${dashboardAge}-${recentAge}`, env: process.env };
      const now = Date.now();
      admit(() =>
        runOpenClawAgentWriteTransaction((writer) => {
          writeSessionEntry(writer, "agent:main:ordinary", {
            sessionId: "ordinary",
            updatedAt: now - 2 * DAY_MS,
          });
          writeSessionEntry(writer, "agent:main:dashboard:disabled", {
            sessionId: "disabled-dashboard",
            updatedAt: now - 3 * DAY_MS,
            lastActivityAt: now - DAY_MS,
          });
          using observation = observeStatementEvents();
          const fact = recordSessionEntryMaintenanceAgeFact(
            writer,
            {
              ...resolveMaintenanceConfigFromInput(),
              pruneAfterMs: 0,
              archiveDashboardAfterMs: dashboardAge,
              preserveRecentMs: recentAge,
            },
            now,
          );
          expect(fact.next.at).toBe(recentAge == null ? Infinity : now + 5 * DAY_MS + 1);
          expect(observation.events).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ sql: expect.stringMatching(/\bage_namespaces\b/) }),
            ]),
          );
          expect(observation.events).toHaveLength(recentAge == null ? 0 : 1);
        }, options),
      );
    },
  );
});
