import { serialize } from "node:v8";
import { receiveMessageOnPort } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { withEngineStoreAdmission as admit } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import * as bridgePrestart from "../../infra/postgres-sync/bridge-prestart.js";
import type {
  BridgeReply,
  BridgeRequest,
  PostgresBridge,
} from "../../infra/postgres-sync/protocol.js";
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

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, receiveMessageOnPort: vi.fn(actual.receiveMessageOnPort) };
});

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

  it("reports query transfer while preserving maintenance age deadlines", async () => {
    const actual =
      await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
    const create = bridgePrestart.createPostgresBridge;
    let bridge: PostgresBridge | undefined;
    const created = vi
      .spyOn(bridgePrestart, "createPostgresBridge")
      .mockImplementation((params) => {
        bridge = create(params);
        return bridge;
      });
    const options = { agentId: "transfer-probe", env: process.env };
    const plannedAt = Date.UTC(2026, 10, 4, 12);
    type Query = "after" | "activityBefore";
    let active: Query | undefined;
    let replies: Array<{
      query: Query;
      rows: number;
      rowCount: number;
      v8RowsBytes: number;
      v8ReplyBytes: number;
    }> = [];
    try {
      const database = admit(() => openOpenClawAgentDatabase(options));
      expect(bridge).toBeDefined();
      const port = bridge!.port;
      admit(() =>
        runOpenClawAgentWriteTransaction((writer) => {
          for (let index = 0; index < 1_024; index++) {
            const key = `agent:transfer-probe:ordinary-${String(index).padStart(4, "0")}`;
            const timestamp = plannedAt - (index < 512 ? 28 : 1) * DAY_MS;
            writeSessionEntry(writer, key, {
              sessionId: key,
              updatedAt: timestamp,
              lastActivityAt: timestamp,
              lastInteractionAt: timestamp,
              sessionStartedAt: timestamp,
            });
          }
        }, options),
      );
      const sent = vi.spyOn(port, "postMessage");
      try {
        vi.mocked(receiveMessageOnPort).mockImplementation((source) => {
          const received = actual.receiveMessageOnPort(source);
          const request: BridgeRequest | undefined = sent.mock.calls.at(-1)?.[0];
          const reply: BridgeReply | undefined = received?.message;
          if (
            active &&
            source === port &&
            request?.operation === "query" &&
            reply?.id === request.id &&
            "result" in reply &&
            reply.result.command === "SELECT"
          ) {
            expect(request.sql).toContain("session_nodes");
            expect(reply.result.fields.map((field) => field.name)).toContain("session_key");
            expect(reply.result.rowCount).toBe(reply.result.rows.length);
            replies.push({
              query: active,
              rows: reply.result.rows.length,
              rowCount: reply.result.rowCount,
              v8RowsBytes: serialize(reply.result.rows).byteLength,
              v8ReplyBytes: serialize(reply).byteLength,
            });
          }
          return received;
        });
        admit(() =>
          runOpenClawAgentWriteTransaction((writer) => {
            expect(writer.db).toBe(database.db);
            const queries = readSessionMaintenanceAgeQueries(writer.db);
            const after = queries.after;
            const activityBefore = queries.activityBefore;
            const consumed = { after: 0, activityBefore: 0 };
            queries.after = function* (minimum) {
              active = "after";
              try {
                for (const row of after(minimum)) {
                  consumed.after++;
                  yield row;
                }
              } finally {
                active = undefined;
              }
            };
            queries.activityBefore = function* (maximum) {
              active = "activityBefore";
              try {
                for (const row of activityBefore(maximum)) {
                  consumed.activityBefore++;
                  yield row;
                }
              } finally {
                active = undefined;
              }
            };
            try {
              for (const recent of [false, true]) {
                for (let sample = 0; sample < 6; sample++) {
                  replies = [];
                  consumed.after = 0;
                  consumed.activityBefore = 0;
                  sent.mockClear();
                  // Call the recording owner directly: cached facts must not turn a warm sample
                  // into a no-query read. Capture remains disabled during fixture writes.
                  const fact = recordSessionEntryMaintenanceAgeFact(
                    writer,
                    {
                      ...resolveMaintenanceConfigFromInput(),
                      pruneAfterMs: 30 * DAY_MS,
                      archiveDashboardAfterMs: null,
                      preserveRecentMs: recent ? 7 * DAY_MS : null,
                    },
                    plannedAt,
                  );
                  expect(fact.next.at).toBe(plannedAt + 2 * DAY_MS + 1);
                  expect(consumed.after).toBe(1);
                  expect([...new Set(replies.map((reply) => reply.query))]).toEqual(
                    recent ? ["after", "activityBefore"] : ["after"],
                  );
                  for (const query of ["after", "activityBefore"] as const) {
                    const returned = replies
                      .filter((reply) => reply.query === query)
                      .reduce((total, reply) => total + reply.rows, 0);
                    expect(returned).toBeGreaterThanOrEqual(consumed[query]);
                  }
                  // These are V8 representation sizes, not wire bytes or clone allocations.
                  // Returned counts stay metrics so bounded-query improvements remain valid.
                  console.log(
                    "PG_AGE_TRANSFER_V8 " +
                      JSON.stringify({
                        node: process.version,
                        sample,
                        phase: sample === 0 ? "first-query" : "warm",
                        rowsSeeded: 1_024,
                        recentProtection: recent,
                        nextAt: fact.next.at,
                        consumed: { ...consumed },
                        replies,
                      }),
                  );
                }
              }
            } finally {
              queries.after = after;
              queries.activityBefore = activityBefore;
            }
          }, options),
        );
      } finally {
        sent.mockRestore();
      }
    } finally {
      created.mockRestore();
      vi.mocked(receiveMessageOnPort).mockImplementation(actual.receiveMessageOnPort);
    }
  });
});
