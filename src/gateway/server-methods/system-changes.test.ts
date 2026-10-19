import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemChangeEntry } from "../../../packages/gateway-protocol/src/index.js";
import {
  CONFIG_AUDIT_MAX_ENTRIES,
  CONFIG_AUDIT_SCOPE,
  type ConfigAuditRecord,
} from "../../config/io.audit.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { createSqliteAuditRecordStore } from "../../infra/sqlite-audit-record-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateReader from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  SYSTEM_AGENT_AUDIT_SCOPE,
  type SystemAgentAuditEntry,
} from "../../system-agent/audit.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  listSystemChanges,
  SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE,
  systemChangesHandlers,
} from "./system-changes.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function requestChanges(overrides: Partial<GatewayRequestHandlerOptions> = {}) {
  const respond = vi.fn();
  const pending = systemChangesHandlers["openclaw.changes.list"]!({
    req: { type: "req", id: "changes", method: "openclaw.changes.list" },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: createDirectChatContext(),
    ...overrides,
  });
  return { respond, pending };
}

function expectEntries(entries: SystemChangeEntry[], expected: Partial<SystemChangeEntry>[]) {
  expect(entries).toEqual(expected.map((entry) => expect.objectContaining(entry)));
}

function configRecord(
  value: Partial<Extract<ConfigAuditRecord, { event: "config.write" }>> & {
    ts: string;
    previousHash: string | null;
    nextHash: string | null;
  },
): ConfigAuditRecord {
  return {
    event: "config.write",
    result: "rename",
    argv: [],
    changedPaths: [],
    ...value,
  } as unknown as ConfigAuditRecord;
}

function createAuditStores(env: NodeJS.ProcessEnv) {
  return {
    systemStore: createSqliteAuditRecordStore<SystemAgentAuditEntry>({
      scope: SYSTEM_AGENT_AUDIT_SCOPE,
      maxEntries: SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
      env,
    }),
    configStore: createSqliteAuditRecordStore<ConfigAuditRecord>({
      scope: CONFIG_AUDIT_SCOPE,
      maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
      env,
    }),
  };
}

function withAuditStores(
  run: (
    fixture: ReturnType<typeof createAuditStores> & { env: NodeJS.ProcessEnv; stateDir: string },
  ) => Promise<void>,
) {
  return withTestDir({ prefix: "openclaw-system-changes-" }, (stateDir) => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    return run({ ...createAuditStores(env), env, stateDir });
  });
}

function writeConfigs(
  store: ReturnType<typeof createAuditStores>["configStore"],
  ...records: Array<
    [
      key: string,
      at: number,
      before: string | null,
      after: string | null,
      path: string | undefined,
      origin?: Extract<ConfigAuditRecord, { event: "config.write" }>["origin"],
      extra?: Partial<Extract<ConfigAuditRecord, { event: "config.write" }>>,
    ]
  >
) {
  for (const [key, at, previousHash, nextHash, path, origin, extra] of records) {
    store.upsert(
      key,
      configRecord({
        ts: new Date(Date.UTC(2026, 6, 18, 12) + at).toISOString(),
        previousHash,
        nextHash,
        changedPaths: path ? [path] : [],
        origin,
        ...extra,
      }),
      at,
    );
  }
}

function seedOperation(
  store: ReturnType<typeof createAuditStores>["systemStore"],
  summary: string,
  [configHashBefore, configHashAfter] = ["a", "b"],
) {
  store.upsert(
    "operation",
    {
      timestamp: "2026-07-18T12:00:04.000Z",
      operation: "config.set",
      summary,
      configHashBefore,
      configHashAfter,
    },
    4_000,
  );
}

describe("openclaw.changes.list", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeOpenClawStateDatabaseAsync();
  });

  it.each(["revoked", "rejected"] as const)(
    "does not disclose a delayed %s read",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-system-changes-delayed-" }, async (stateDir) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        const read =
          createDeferredCore<
            Awaited<ReturnType<typeof stateReader.executeExistingOpenClawStateRead>>
          >();
        vi.spyOn(stateReader, "executeExistingOpenClawStateRead")
          .mockReturnValueOnce(read.promise)
          .mockResolvedValue({
            ok: true,
            sourceAdmitted: true,
            type: "diagnostic.latest",
            entries: [],
          });
        let current = true;
        const { respond, pending } = requestChanges({
          hasCurrentClientAuthority: () => current,
        });
        expect(respond).not.toHaveBeenCalled();
        if (outcome === "revoked") {
          current = false;
          read.resolve({ ok: true, sourceAdmitted: true, type: "diagnostic.latest", entries: [] });
        } else {
          read.reject(new Error("audit reader refused"));
        }
        await pending;
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({
            message:
              outcome === "revoked"
                ? "Gateway requester authority changed"
                : "audit reader refused",
          }),
        );
      });
    },
  );

  it("merges journals, collapses matching writes, and skips non-history records", async () => {
    await withAuditStores(async ({ stateDir, systemStore, configStore }) => {
      seedOperation(systemStore, "Set config gateway.port", ["hash-a", "hash-b"]);
      configStore.upsert(
        "external",
        {
          event: "config.external",
          ts: "2026-07-18T12:00:01.000Z",
          valid: false,
          previousHash: "hash-c",
          nextHash: "hash-d",
          changedPaths: ["channels.telegram"],
          opaqueChange: true,
        } as unknown as ConfigAuditRecord,
        1_000,
      );
      writeConfigs(
        configStore,
        ["doctor", 2_000, "hash-b", "hash-c", "agents.defaults.model", "doctor"],
        ["match", 3_000, "hash-a", "hash-b", "gateway.port", "system-agent"],
        [
          "repeat",
          2_000,
          "hash-a",
          "hash-b",
          "gateway.bind",
          "cli",
          { ts: "2026-07-18T12:00:05.000Z" },
        ],
        [
          "failed",
          3_000,
          "failed-a",
          "failed-b",
          undefined,
          undefined,
          { ts: "2026-07-18T12:00:05.500Z", result: "failed" },
        ],
      );
      configStore.upsert(
        "observe",
        {
          event: "config.observe",
          ts: "2026-07-18T12:00:06.000Z",
        } as unknown as ConfigAuditRecord,
        6_000,
      );

      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const queries = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
      const singleQueries = vi.spyOn(sqliteQueries, "executeSqliteQueryTakeFirstSync");
      const { respond, pending } = requestChanges({ params: { limit: 50 } });
      await pending;
      expect(queries).not.toHaveBeenCalled();
      expect(singleQueries).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        entries: [
          // Store insertion order wins over display timestamps.
          expect.objectContaining({
            kind: "operation",
            source: "system-agent",
            summary: "Set config gateway.port",
            changedPaths: ["gateway.port"],
          }),
          expect.objectContaining({
            kind: "config-write",
            source: "cli",
            changedPaths: ["gateway.bind"],
          }),
          expect.objectContaining({
            kind: "config-write",
            source: "doctor",
            changedPaths: ["agents.defaults.model"],
          }),
          expect.objectContaining({
            kind: "external-edit",
            source: "external",
            invalid: true,
            opaqueChange: true,
            changedPaths: ["channels.telegram"],
          }),
        ],
      });
    });
  });

  it("classifies legacy redacted argv when origin is absent", async () => {
    await withAuditStores(async ({ env, configStore: store }) => {
      for (const [key, at, before, after, argv] of [
        ["doctor", 3_000, "a", "b", ["doctor", "--fix"]],
        ["config", 2_000, "b", "c", ["config", "set", "profile.name", "doctor"]],
        ["unknown", 1_000, "c", "d", ["onboard"]],
      ] as const) {
        store.upsert(
          key,
          configRecord({
            ts: new Date(Date.UTC(2026, 6, 18, 12) + at).toISOString(),
            previousHash: before,
            nextHash: after,
            argv: ["node", "openclaw", ...argv],
          }),
        );
      }

      expect((await listSystemChanges({}, { env })).entries.map((entry) => entry.source)).toEqual([
        "unknown",
        "cli",
        "doctor",
      ]);
    });
  });

  it("keeps pages newest-first while suppressing an older collapse partner", async () => {
    await withAuditStores(async ({ env, systemStore, configStore }) => {
      writeConfigs(
        configStore,
        ["match", 1_000, "a", "b", "gateway.port", "system-agent"],
        ["one", 2_000, "b", "c", "gateway.bind", "cli"],
        ["two", 3_000, "c", "d", "gateway.mode", "cli"],
      );
      seedOperation(systemStore, "Set config gateway.port");

      const first = await listSystemChanges({ limit: 1 }, { env });
      expectEntries(first.entries, [{ kind: "operation", summary: "Set config gateway.port" }]);
      const second = await listSystemChanges({ limit: 1, beforeCursor: first.nextCursor }, { env });
      expectEntries(second.entries, [{ changedPaths: ["gateway.mode"], source: "cli" }]);
      const third = await listSystemChanges({ limit: 1, beforeCursor: second.nextCursor }, { env });
      expectEntries(third.entries, [{ changedPaths: ["gateway.bind"], source: "cli" }]);
      expect(third.nextCursor).toBeUndefined();
      const entries = [...first.entries, ...second.entries, ...third.entries];
      expect(entries.map((entry) => entry.at)).toEqual(
        entries.map((entry) => entry.at).toSorted((left, right) => right - left),
      );
      expect(entries.map((entry) => entry.id)).toEqual([
        ...new Set(entries.map((entry) => entry.id)),
      ]);
      expect(entries.some((entry) => entry.changedPaths?.includes("gateway.port"))).toBe(false);
    });
  });

  it("keeps an outside-window repeated transition on a later page", async () => {
    await withAuditStores(async ({ env, systemStore, configStore }) => {
      writeConfigs(
        configStore,
        ["old", 1_000, "a", "b", "old.path", "system-agent", { ts: "2026-07-18T11:58:00.000Z" }],
        ["one", 2_000, "b", "c", "gateway.bind", "cli"],
        ["two", 3_000, "c", "d", "gateway.mode", "cli"],
      );
      seedOperation(systemStore, "Set config gateway.port");

      const pages = [];
      let cursor: string | undefined;
      do {
        const page = await listSystemChanges(
          { limit: 1, ...(cursor ? { beforeCursor: cursor } : {}) },
          { env },
        );
        pages.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor);

      expect(pages.map((entry) => entry.changedPaths?.[0])).toEqual([
        undefined,
        "gateway.mode",
        "gateway.bind",
        "old.path",
      ]);
      expect(pages.map((entry) => entry.id)).toEqual([...new Set(pages.map((entry) => entry.id))]);
    });
  });

  it("prefers an in-window match over an older repeated transition", async () => {
    await withAuditStores(async ({ env, systemStore, configStore }) => {
      writeConfigs(
        configStore,
        ["old", 1_000, "a", "b", "old.path", "system-agent"],
        ["current", 2_000, "a", "b", "current.path", "system-agent"],
        ["newer", 3_000, "b", "c", "gateway.bind", "cli"],
      );
      seedOperation(systemStore, "Set current path");

      const first = await listSystemChanges({ limit: 1 }, { env });
      expectEntries(first.entries, [{ kind: "operation", changedPaths: ["current.path"] }]);
      const second = await listSystemChanges({ limit: 1, beforeCursor: first.nextCursor }, { env });
      expectEntries(second.entries, [{ source: "cli", changedPaths: ["gateway.bind"] }]);
      const third = await listSystemChanges({ limit: 1, beforeCursor: second.nextCursor }, { env });
      expectEntries(third.entries, [{ kind: "config-write", changedPaths: ["old.path"] }]);
      expect(third.nextCursor).toBeUndefined();
    });
  });

  it("paginates equal timestamps by per-scope sequence and freezes the scope heads", async () => {
    await withAuditStores(async ({ env, configStore: store }) => {
      for (const [key, before, after] of [
        ["one", "a", "b"],
        ["two", "b", "c"],
        ["three", "c", "d"],
      ] as const) {
        writeConfigs(store, [
          key,
          1_000,
          before,
          after,
          key,
          "config-rpc",
          { ts: "2026-07-18T12:00:00.000Z" },
        ]);
      }

      const first = await listSystemChanges({ limit: 2 }, { env });
      expect(first.entries.map((entry) => entry.changedPaths?.[0])).toEqual(["three", "two"]);
      expect(first.nextCursor).toEqual(expect.any(String));

      writeConfigs(store, [
        "new",
        2_000,
        "d",
        "e",
        "new",
        "config-rpc",
        { ts: "2026-07-18T12:00:01.000Z" },
      ]);
      const second = await listSystemChanges({ limit: 2, beforeCursor: first.nextCursor }, { env });
      expect(second.entries.map((entry) => entry.changedPaths?.[0])).toEqual(["one"]);
      expect(second.nextCursor).toBeUndefined();
    });
  });

  it("freezes an untouched scope before the first page is emitted", async () => {
    await withAuditStores(async ({ env, systemStore, configStore }) => {
      for (const [key, at, summary] of [
        ["older-operation", 1_000, "Repaired configuration"],
        ["newer-operation", 2_000, "Updated configuration"],
      ] as const) {
        systemStore.upsert(
          key,
          {
            timestamp: new Date(Date.UTC(2026, 6, 18, 12) + at).toISOString(),
            operation: "doctor.fix",
            summary,
          },
          at,
        );
      }

      const first = await listSystemChanges({ limit: 1 }, { env });
      expectEntries(first.entries, [{ summary: "Updated configuration" }]);
      expect(first.nextCursor).toEqual(expect.any(String));

      writeConfigs(configStore, ["inserted", 3_000, "a", "b", "gateway.port", "config-rpc"]);

      const second = await listSystemChanges({ limit: 1, beforeCursor: first.nextCursor }, { env });
      expectEntries(second.entries, [{ summary: "Repaired configuration" }]);
      expect(second.entries.some((entry) => entry.changedPaths?.includes("gateway.port"))).toBe(
        false,
      );
      expect((await listSystemChanges({ limit: 50 }, { env })).entries).toContainEqual(
        expect.objectContaining({ changedPaths: ["gateway.port"] }),
      );
    });
  });

  it("bounds filtered journal scans and resumes from the scanned frontier", async () => {
    await withAuditStores(async ({ env, configStore }) => {
      for (let index = 0; index < SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE + 250; index += 1) {
        configStore.upsert(
          `ineligible-${index}`,
          index % 2 === 0
            ? ({ event: "config.observe", ts: "2026-07-18T12:00:00.000Z" } as ConfigAuditRecord)
            : configRecord({
                ts: "2026-07-18T12:00:00.000Z",
                result: "failed",
                previousHash: `before-${index}`,
                nextHash: `after-${index}`,
              }),
          index,
        );
      }

      async function readPage(beforeCursor?: string) {
        const calls: Array<{ limit: number; beforeSequence?: number }> = [];
        let rawRows = 0;
        const page = await listSystemChanges(
          { limit: 50, beforeCursor },
          {
            env,
            configStore: {
              async latest(params) {
                calls.push(params);
                const entries = configStore.latest(params);
                rawRows += entries.length;
                return entries;
              },
            },
          },
        );
        return { page, calls, rawRows };
      }
      const { page: first, calls: firstCalls, rawRows: firstRawRows } = await readPage();
      expect(first.entries).toEqual([]);
      expect(first.nextCursor).toEqual(expect.any(String));
      // The frozen-head lookup loads one extra row before the bounded scan.
      expect(firstRawRows).toBeLessThanOrEqual(SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE + 1);

      const firstCursor = JSON.parse(
        Buffer.from(first.nextCursor!, "base64url").toString("utf8"),
      ) as { configBefore: number };
      expect(firstCalls.at(-1)?.beforeSequence).toBeGreaterThan(firstCursor.configBefore);

      const {
        page: second,
        calls: secondCalls,
        rawRows: secondRawRows,
      } = await readPage(first.nextCursor);
      expect(second.entries).toEqual([]);
      expect(second.nextCursor).toBeUndefined();
      expect(secondCalls[0]?.beforeSequence).toBe(firstCursor.configBefore);
      expect(secondRawRows).toBeLessThanOrEqual(SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE);
    });
  });
});
