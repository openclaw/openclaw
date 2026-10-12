import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { OpenClawStateReadReply } from "../../state/openclaw-state-read.types.js";
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
        const read = createDeferredCore<OpenClawStateReadReply | undefined>();
        vi.spyOn(stateReader, "executeExistingOpenClawStateRead")
          .mockReturnValueOnce(read.promise)
          .mockResolvedValue({
            ok: true,
            sourceAdmitted: true,
            type: "diagnostic.latest",
            entries: [],
          });
        let current = true;
        const respond = vi.fn();
        const pending = systemChangesHandlers["openclaw.changes.list"]!({
          req: { type: "req", id: "changes", method: "openclaw.changes.list" },
          params: {},
          respond,
          client: null,
          isWebchatConnect: () => false,
          context: createDirectChatContext(),
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
    await withTestDir({ prefix: "openclaw-system-changes-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const { systemStore, configStore } = createAuditStores(env);

      systemStore.upsert(
        "operation",
        {
          timestamp: "2026-07-18T12:00:04.000Z",
          operation: "config.set",
          summary: "Set config gateway.port",
          configHashBefore: "hash-a",
          configHashAfter: "hash-b",
        },
        4_000,
      );
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
      configStore.upsert(
        "doctor-write",
        configRecord({
          ts: "2026-07-18T12:00:02.000Z",
          origin: "doctor",
          previousHash: "hash-b",
          nextHash: "hash-c",
          changedPaths: ["agents.defaults.model"],
        }),
        2_000,
      );
      configStore.upsert(
        "matching-write",
        configRecord({
          ts: "2026-07-18T12:00:03.000Z",
          origin: "system-agent",
          previousHash: "hash-a",
          nextHash: "hash-b",
          changedPaths: ["gateway.port"],
        }),
        3_000,
      );
      configStore.upsert(
        "repeated-cli-transition",
        configRecord({
          ts: "2026-07-18T12:00:05.000Z",
          origin: "cli",
          previousHash: "hash-a",
          nextHash: "hash-b",
          changedPaths: ["gateway.bind"],
        }),
        2_000,
      );
      configStore.upsert(
        "failed",
        configRecord({
          ts: "2026-07-18T12:00:05.500Z",
          result: "failed",
          previousHash: "failed-a",
          nextHash: "failed-b",
        }),
        3_000,
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
      const respond = vi.fn();
      await systemChangesHandlers["openclaw.changes.list"]!({
        req: { type: "req", id: "changes", method: "openclaw.changes.list" },
        params: { limit: 50 },
        respond,
        client: null,
        isWebchatConnect: () => false,
        context: createDirectChatContext(),
      });
      expect(queries).not.toHaveBeenCalled();
      expect(singleQueries).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        entries: [
          // Canonical order is store insertion (createdAt desc), not display
          // time: the operation registered last surfaces first even though its
          // payload timestamp is older than the CLI write's.
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
    await withTestDir({ prefix: "openclaw-system-changes-argv-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const store = createSqliteAuditRecordStore<ConfigAuditRecord>({
        scope: CONFIG_AUDIT_SCOPE,
        maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
        env,
      });
      store.upsert(
        "doctor",
        configRecord({
          ts: "2026-07-18T12:00:03.000Z",
          argv: ["node", "openclaw", "doctor", "--fix"],
          previousHash: "a",
          nextHash: "b",
        }),
      );
      store.upsert(
        "config",
        configRecord({
          ts: "2026-07-18T12:00:02.000Z",
          argv: ["node", "openclaw", "config", "set", "profile.name", "doctor"],
          previousHash: "b",
          nextHash: "c",
        }),
      );
      store.upsert(
        "unknown",
        configRecord({
          ts: "2026-07-18T12:00:01.000Z",
          argv: ["node", "openclaw", "onboard"],
          previousHash: "c",
          nextHash: "d",
        }),
      );

      expect((await listSystemChanges({}, { env })).entries.map((entry) => entry.source)).toEqual([
        "unknown",
        "cli",
        "doctor",
      ]);
    });
  });

  it("keeps pages newest-first while suppressing an older collapse partner", async () => {
    await withTestDir({ prefix: "openclaw-system-changes-collapse-cursor-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const { systemStore, configStore } = createAuditStores(env);
      configStore.upsert(
        "matching-write",
        configRecord({
          ts: "2026-07-18T12:00:01.000Z",
          origin: "system-agent",
          previousHash: "a",
          nextHash: "b",
          changedPaths: ["gateway.port"],
        }),
        1_000,
      );
      configStore.upsert(
        "intervening-write-one",
        configRecord({
          ts: "2026-07-18T12:00:02.000Z",
          origin: "cli",
          previousHash: "b",
          nextHash: "c",
          changedPaths: ["gateway.bind"],
        }),
        2_000,
      );
      configStore.upsert(
        "intervening-write-two",
        configRecord({
          ts: "2026-07-18T12:00:03.000Z",
          origin: "cli",
          previousHash: "c",
          nextHash: "d",
          changedPaths: ["gateway.mode"],
        }),
        3_000,
      );
      systemStore.upsert(
        "operation",
        {
          timestamp: "2026-07-18T12:00:04.000Z",
          operation: "config.set",
          summary: "Set config gateway.port",
          configHashBefore: "a",
          configHashAfter: "b",
        },
        4_000,
      );

      const first = await listSystemChanges({ limit: 1 }, { env });
      expect(first.entries).toEqual([
        expect.objectContaining({
          kind: "operation",
          summary: "Set config gateway.port",
        }),
      ]);
      const second = await listSystemChanges({ limit: 1, beforeCursor: first.nextCursor }, { env });
      expect(second.entries).toEqual([
        expect.objectContaining({ changedPaths: ["gateway.mode"], source: "cli" }),
      ]);
      const third = await listSystemChanges({ limit: 1, beforeCursor: second.nextCursor }, { env });
      expect(third.entries).toEqual([
        expect.objectContaining({ changedPaths: ["gateway.bind"], source: "cli" }),
      ]);
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
    await withTestDir({ prefix: "openclaw-system-changes-pending-window-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const { systemStore, configStore } = createAuditStores(env);
      configStore.upsert(
        "old-matching-transition",
        configRecord({
          ts: "2026-07-18T11:58:00.000Z",
          origin: "system-agent",
          previousHash: "a",
          nextHash: "b",
          changedPaths: ["old.path"],
        }),
        1_000,
      );
      configStore.upsert(
        "intervening-write-one",
        configRecord({
          ts: "2026-07-18T12:00:02.000Z",
          origin: "cli",
          previousHash: "b",
          nextHash: "c",
          changedPaths: ["gateway.bind"],
        }),
        2_000,
      );
      configStore.upsert(
        "intervening-write-two",
        configRecord({
          ts: "2026-07-18T12:00:03.000Z",
          origin: "cli",
          previousHash: "c",
          nextHash: "d",
          changedPaths: ["gateway.mode"],
        }),
        3_000,
      );
      systemStore.upsert(
        "operation",
        {
          timestamp: "2026-07-18T12:00:04.000Z",
          operation: "config.set",
          summary: "Set config gateway.port",
          configHashBefore: "a",
          configHashAfter: "b",
        },
        4_000,
      );

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
    await withTestDir(
      { prefix: "openclaw-system-changes-repeated-transition-" },
      async (stateDir) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const { systemStore, configStore } = createAuditStores(env);
        configStore.upsert(
          "old-transition",
          configRecord({
            ts: "2026-07-18T12:00:01.000Z",
            origin: "system-agent",
            previousHash: "a",
            nextHash: "b",
            changedPaths: ["old.path"],
          }),
          1_000,
        );
        configStore.upsert(
          "current-transition",
          configRecord({
            ts: "2026-07-18T12:00:02.000Z",
            origin: "system-agent",
            previousHash: "a",
            nextHash: "b",
            changedPaths: ["current.path"],
          }),
          2_000,
        );
        configStore.upsert(
          "newer-cli-write",
          configRecord({
            ts: "2026-07-18T12:00:03.000Z",
            origin: "cli",
            previousHash: "b",
            nextHash: "c",
            changedPaths: ["gateway.bind"],
          }),
          3_000,
        );
        systemStore.upsert(
          "operation",
          {
            timestamp: "2026-07-18T12:00:04.000Z",
            operation: "config.set",
            summary: "Set current path",
            configHashBefore: "a",
            configHashAfter: "b",
          },
          4_000,
        );

        const first = await listSystemChanges({ limit: 1 }, { env });
        expect(first.entries).toEqual([
          expect.objectContaining({ kind: "operation", changedPaths: ["current.path"] }),
        ]);
        const second = await listSystemChanges(
          { limit: 1, beforeCursor: first.nextCursor },
          { env },
        );
        expect(second.entries).toEqual([
          expect.objectContaining({ source: "cli", changedPaths: ["gateway.bind"] }),
        ]);
        const third = await listSystemChanges(
          { limit: 1, beforeCursor: second.nextCursor },
          { env },
        );
        expect(third.entries).toEqual([
          expect.objectContaining({ kind: "config-write", changedPaths: ["old.path"] }),
        ]);
        expect(third.nextCursor).toBeUndefined();
      },
    );
  });

  it("paginates equal timestamps by per-scope sequence and freezes the scope heads", async () => {
    await withTestDir({ prefix: "openclaw-system-changes-cursor-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const store = createSqliteAuditRecordStore<ConfigAuditRecord>({
        scope: CONFIG_AUDIT_SCOPE,
        maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
        env,
      });
      for (const [key, before, after] of [
        ["one", "a", "b"],
        ["two", "b", "c"],
        ["three", "c", "d"],
      ] as const) {
        store.upsert(
          key,
          configRecord({
            ts: "2026-07-18T12:00:00.000Z",
            origin: "config-rpc",
            previousHash: before,
            nextHash: after,
            changedPaths: [key],
          }),
          1_000,
        );
      }

      const first = await listSystemChanges({ limit: 2 }, { env });
      expect(first.entries.map((entry) => entry.changedPaths?.[0])).toEqual(["three", "two"]);
      expect(first.nextCursor).toEqual(expect.any(String));

      store.upsert(
        "new-after-first-page",
        configRecord({
          ts: "2026-07-18T12:00:01.000Z",
          origin: "config-rpc",
          previousHash: "d",
          nextHash: "e",
          changedPaths: ["new"],
        }),
        2_000,
      );
      const second = await listSystemChanges({ limit: 2, beforeCursor: first.nextCursor }, { env });
      expect(second.entries.map((entry) => entry.changedPaths?.[0])).toEqual(["one"]);
      expect(second.nextCursor).toBeUndefined();
    });
  });

  it("freezes an untouched scope before the first page is emitted", async () => {
    await withTestDir({ prefix: "openclaw-system-changes-frozen-heads-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const { systemStore, configStore } = createAuditStores(env);
      systemStore.upsert(
        "older-operation",
        {
          timestamp: "2026-07-18T12:00:01.000Z",
          operation: "doctor.fix",
          summary: "Repaired configuration",
        },
        1_000,
      );
      systemStore.upsert(
        "newer-operation",
        {
          timestamp: "2026-07-18T12:00:02.000Z",
          operation: "doctor.fix",
          summary: "Updated configuration",
        },
        2_000,
      );

      const first = await listSystemChanges({ limit: 1 }, { env });
      expect(first.entries).toEqual([
        expect.objectContaining({ summary: "Updated configuration" }),
      ]);
      expect(first.nextCursor).toEqual(expect.any(String));

      configStore.upsert(
        "inserted-between-pages",
        configRecord({
          ts: "2026-07-18T12:00:03.000Z",
          origin: "config-rpc",
          previousHash: "a",
          nextHash: "b",
          changedPaths: ["gateway.port"],
        }),
        3_000,
      );

      const second = await listSystemChanges({ limit: 1, beforeCursor: first.nextCursor }, { env });
      expect(second.entries).toEqual([
        expect.objectContaining({ summary: "Repaired configuration" }),
      ]);
      expect(second.entries.some((entry) => entry.changedPaths?.includes("gateway.port"))).toBe(
        false,
      );
      expect((await listSystemChanges({ limit: 50 }, { env })).entries).toContainEqual(
        expect.objectContaining({ changedPaths: ["gateway.port"] }),
      );
    });
  });

  it("bounds filtered journal scans and resumes from the scanned frontier", async () => {
    await withTestDir({ prefix: "openclaw-system-changes-scan-budget-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const configStore = createSqliteAuditRecordStore<ConfigAuditRecord>({
        scope: CONFIG_AUDIT_SCOPE,
        maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
        env,
      });
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

      const firstCalls: Array<{ limit: number; beforeSequence?: number }> = [];
      let firstRawRows = 0;
      const first = await listSystemChanges(
        { limit: 50 },
        {
          env,
          configStore: {
            async latest(params) {
              firstCalls.push(params);
              const entries = configStore.latest(params);
              firstRawRows += entries.length;
              return entries;
            },
          },
        },
      );
      expect(first.entries).toEqual([]);
      expect(first.nextCursor).toEqual(expect.any(String));
      // The initial frozen-head lookup loads one additional row before the
      // bounded raw scan begins.
      expect(firstRawRows).toBeLessThanOrEqual(SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE + 1);

      const firstCursor = JSON.parse(
        Buffer.from(first.nextCursor!, "base64url").toString("utf8"),
      ) as { configBefore: number };
      expect(firstCalls.at(-1)?.beforeSequence).toBeGreaterThan(firstCursor.configBefore);

      const secondCalls: Array<{ limit: number; beforeSequence?: number }> = [];
      let secondRawRows = 0;
      const second = await listSystemChanges(
        { limit: 50, beforeCursor: first.nextCursor },
        {
          env,
          configStore: {
            async latest(params) {
              secondCalls.push(params);
              const entries = configStore.latest(params);
              secondRawRows += entries.length;
              return entries;
            },
          },
        },
      );
      expect(second.entries).toEqual([]);
      expect(second.nextCursor).toBeUndefined();
      expect(secondCalls[0]?.beforeSequence).toBe(firstCursor.configBefore);
      expect(secondRawRows).toBeLessThanOrEqual(SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE);
    });
  });
});
