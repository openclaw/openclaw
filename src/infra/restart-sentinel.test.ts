import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const { mockWarn, mockThrowOpen, mockThrowWrite, mockThrowWorkerWrite, mockThrowWorkerRead } =
  vi.hoisted(() => ({
    mockWarn: vi.fn(),
    mockThrowOpen: vi.fn(),
    mockThrowWrite: vi.fn(),
    mockThrowWorkerWrite: vi.fn(),
    mockThrowWorkerRead: vi.fn(),
  }));
const admission = vi.hoisted((): { beforeGrant?: (stage: string) => void } => ({}));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      return args[0] === "restart-sentinel" ? { ...logger, warn: mockWarn } : logger;
    },
  };
});

vi.mock("../state/openclaw-state-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-state-db.js")>();
  return {
    ...actual,
    openOpenClawStateDatabase: (...args: Parameters<typeof actual.openOpenClawStateDatabase>) => {
      mockThrowOpen();
      return actual.openOpenClawStateDatabase(...args);
    },
    runOpenClawStateWriteTransaction: (
      ...args: Parameters<typeof actual.runOpenClawStateWriteTransaction>
    ) => {
      mockThrowWrite();
      return actual.runOpenClawStateWriteTransaction(...args);
    },
  };
});

vi.mock("../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../version.js")>();
  return { ...actual, resolveRuntimeServiceCommit: () => "aaaaaaa" };
});

vi.mock("../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      ...args: Parameters<typeof actual.runOpenClawStateWorkerOperation>
    ) => {
      mockThrowWorkerWrite();
      return actual.runOpenClawStateWorkerOperation(...args);
    },
  };
});

vi.mock("../state/openclaw-state-db-readonly.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-state-db-readonly.js")>();
  return {
    ...actual,
    executeExistingOpenClawStateRead: (
      ...args: Parameters<typeof actual.executeExistingOpenClawStateRead>
    ) => {
      mockThrowWorkerRead();
      return actual.executeExistingOpenClawStateRead(...args);
    },
  };
});

vi.mock("./sqlite-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sqlite-worker-store.js")>();
  return {
    ...actual,
    createSqliteWorkerWriteAdmission: (
      assertCurrent: Parameters<typeof actual.createSqliteWorkerWriteAdmission>[0],
      nativeLocations: readonly string[],
    ) =>
      actual.createSqliteWorkerWriteAdmission((request) => {
        admission.beforeGrant?.(request.stage);
        assertCurrent(request);
      }, nativeLocations),
  };
});

import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  readRestartSentinelRowSync,
  writeRestartSentinelRowSync,
  writeRestartSentinelRowIfRevisionSync,
} from "./restart-sentinel-store.js";
import {
  clearRestartSentinelIfRevision,
  finalizeUpdateRestartSentinelRunningVersion,
  formatRestartSentinelMessage,
  hasRestartSentinel,
  markUpdateRestartSentinelFailure,
  readRestartSentinel,
  readRestartSentinelReadOnly,
  readRestartSentinelSnapshot,
  readVerifiedGitUpdateReceipt,
  writeRestartSentinel,
  writeRestartSentinelIfUnchanged,
} from "./restart-sentinel.js";

beforeEach(() => {
  mockWarn.mockClear();
  mockThrowOpen.mockReset();
  mockThrowWrite.mockReset();
  mockThrowWorkerWrite.mockReset();
  mockThrowWorkerRead.mockReset();
  admission.beforeGrant = undefined;
});

type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
const stateDir = tempDirs.make("openclaw-sentinel-");

async function withRestartSentinelStateDir(
  run: () => Promise<void>,
  options: { fresh?: boolean } = {},
): Promise<void> {
  const env = {
    OPENCLAW_STATE_DIR: options.fresh ? tempDirs.make("openclaw-sentinel-") : stateDir,
  };
  if (!options.fresh) {
    const { db } = openOpenClawStateDatabase({ env });
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db).deleteFrom(
        "gateway_restart_sentinel",
      ),
    );
  }
  await withEnvAsync(env, run);
}

function readSentinelRow() {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select(["sentinel_key", "version", "kind", "status", "payload_json", "updated_at_ms"])
      .where("sentinel_key", "=", "current"),
  );
}

function readSentinelRevisionFloor() {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select("updated_at_ms")
      .where("sentinel_key", "=", "revision-floor"),
  )?.updated_at_ms;
}

function deleteSentinelRevisionFloor() {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.deleteFrom("gateway_restart_sentinel").where("sentinel_key", "=", "revision-floor"),
  );
}

function updateSentinelRow(
  values: Partial<{
    version: number;
    kind: string;
    status: string;
    continuation_json: string | null;
    stats_json: string | null;
    payload_json: string;
    updated_at_ms: number;
  }>,
) {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(values)
      .where("sentinel_key", "=", "current"),
  );
}

describe("restart sentinel", () => {
  it("persists and consumes through workers without caller-thread SQL", async () => {
    await withRestartSentinelStateDir(
      async () => {
        const rejectHostSql = () => {
          throw new Error("caller-thread SQL");
        };
        mockThrowOpen.mockImplementation(rejectHostSql);
        mockThrowWrite.mockImplementation(rejectHostSql);
        await expect(readRestartSentinelReadOnly()).resolves.toBeNull();
        await expect(fs.access(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
          code: "ENOENT",
        });
        const written = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 });
        await expect(readRestartSentinel()).resolves.toEqual(written);
        await expect(readRestartSentinelReadOnly()).resolves.toEqual(written);
        await expect(clearRestartSentinelIfRevision(written.revision)).resolves.toBe(true);
        await expect(hasRestartSentinel()).resolves.toBe(false);
      },
      { fresh: true },
    );
  });

  it("writes and reads a sentinel", async () => {
    await withRestartSentinelStateDir(async () => {
      const payload = {
        kind: "update" as const,
        status: "ok" as const,
        ts: Date.now(),
        sessionKey: "agent:main:mobilechat:dm:+15555550123",
        continuation: {
          kind: "agentTurn" as const,
          message: "Reply with exactly: Yay! I did it!",
        },
        stats: {
          mode: "git",
          before: null,
          after: { version: "2026.9.4", detail: { retained: true } },
          steps: [
            {
              name: "install",
              command: "install",
              failureFacts: [{ check: "installation", code: "retained" }],
              cwd: null,
              durationMs: 0.5,
              log: { stdoutTail: null, stderrTail: "", exitCode: null },
              advisory: false,
            },
          ],
          reason: null,
          durationMs: null,
        },
      };
      await writeRestartSentinel(payload);
      expect(readSentinelRow()).toMatchObject({
        sentinel_key: "current",
        version: 1,
        kind: "update",
        status: "ok",
        payload_json: JSON.stringify(payload),
      });

      const read = await readRestartSentinel();
      expect(read?.payload).toEqual(payload);
    });
  });

  it("canonicalizes nullable top-level fields and empty delivery context", async () => {
    await withRestartSentinelStateDir(async () => {
      const written = await writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: 1,
        deliveryContext: {},
        message: null,
        continuation: null,
        doctorHint: null,
        stats: null,
      });

      expect(written.payload).toEqual({ kind: "restart", status: "ok", ts: 1 });
      await expect(readRestartSentinel()).resolves.toEqual(written);
      expect(readSentinelRow()?.payload_json).toBe(
        JSON.stringify({ kind: "restart", status: "ok", ts: 1 }),
      );
    });
  });

  it("ignores legacy files without mutating them", async () => {
    await withRestartSentinelStateDir(
      async () => {
        const payload = {
          kind: "update" as const,
          status: "skipped" as const,
          ts: Date.now(),
          sessionKey: "agent:main:webchat:dm:user-123",
          message: "update restart pending",
          stats: {
            mode: "npm",
            reason: "restart-health-pending",
          },
        };
        const legacyPath = path.join(process.env.OPENCLAW_STATE_DIR ?? "", "restart-sentinel.json");
        const legacyContents = `${JSON.stringify({ version: 1, payload })}\n`;
        await fs.writeFile(legacyPath, legacyContents, "utf-8");

        await expect(hasRestartSentinel()).resolves.toBe(false);
        await expect(readRestartSentinel()).resolves.toBeNull();
        const written = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 2 });
        await expect(clearRestartSentinelIfRevision(written.revision)).resolves.toBe(true);
        await expect(fs.readFile(legacyPath, "utf-8")).resolves.toBe(legacyContents);
      },
      { fresh: true },
    );
  });

  it.each([
    { name: "the shadow payload is corrupt", columns: { payload_json: "not-json" } },
    {
      name: "recovery has an unknown reason and extra field",
      columns: {
        stats_json: JSON.stringify({
          mode: "npm",
          reason: "pending",
          recovery: { serviceRestartSafe: false, reason: "future-recovery-reason", detail: "new" },
        }),
      },
    },
    {
      name: "recovery has a known reason and extra field",
      columns: {
        stats_json: JSON.stringify({
          mode: "npm",
          reason: "pending",
          recovery: {
            serviceRestartSafe: false,
            reason: "runtime-verification-failed",
            detail: "new",
          },
        }),
      },
    },
  ])("keeps notices readable and consumable when $name", async ({ columns }) => {
    await withRestartSentinelStateDir(async () => {
      const payload = {
        kind: "update" as const,
        status: "skipped" as const,
        ts: 42,
        sessionKey: "agent:main:webchat:dm:user-123",
        deliveryContext: { channel: "webchat", to: "user-123", accountId: "default" },
        threadId: "thread-1",
        message: "typed state",
        continuation: { kind: "agentTurn" as const, message: "continue" },
        doctorHint: "run doctor",
        stats: { mode: "npm", reason: "pending" },
      };
      const written = await writeRestartSentinel(payload);
      updateSentinelRow(columns);

      const read = await readRestartSentinel();
      expect(read).toEqual(written);
      expect(formatRestartSentinelMessage(read!.payload)).toContain(payload.message);
      await expect(clearRestartSentinelIfRevision(read!.revision)).resolves.toBe(true);
      await expect(readRestartSentinel()).resolves.toBeNull();
    });
  });

  it.each(["missing", "current", "invalid"] as const)(
    "publishes an absent-row fallback only when the sentinel remains missing (%s)",
    async (state) => {
      await withRestartSentinelStateDir(async () => {
        const first = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 });
        if (state === "missing") {
          await clearRestartSentinelIfRevision(first.revision);
        } else if (state === "invalid") {
          updateSentinelRow({ kind: "not-a-kind" });
        }
        const { db } = openOpenClawStateDatabase();
        const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
        const rows = () =>
          executeSqliteQuerySync(
            db,
            stateDb.selectFrom("gateway_restart_sentinel").selectAll().orderBy("sentinel_key"),
          ).rows;
        const before = rows();
        const payload = { kind: "update" as const, status: "error" as const, ts: 2 };
        const clock = vi.spyOn(Date, "now").mockReturnValue(first.revision - 1);
        try {
          const written = runOpenClawStateWriteTransaction(({ db: transactionDb }) =>
            writeRestartSentinelRowIfRevisionSync(transactionDb, payload, null),
          );
          if (state === "missing") {
            expect(written).toMatchObject({ payload, revision: first.revision + 1 });
            expect(readRestartSentinelRowSync(db)).toEqual({ kind: "valid", sentinel: written });
            expect(readSentinelRevisionFloor()).toBe(first.revision + 1);
          } else {
            expect(written).toBeNull();
            expect(rows()).toEqual(before);
          }
          const settled = rows();
          expect(
            runOpenClawStateWriteTransaction(({ db: transactionDb }) =>
              writeRestartSentinelRowIfRevisionSync(transactionDb, payload, null),
            ),
          ).toBeNull();
          expect(rows()).toEqual(settled);
        } finally {
          clock.mockRestore();
        }
      });
    },
  );

  it("leaves malformed typed rows in place and reports them as unreadable", async () => {
    await withRestartSentinelStateDir(async () => {
      await writeRestartSentinel({ kind: "update", status: "ok", ts: 1 });
      updateSentinelRow({ kind: "not-a-kind", payload_json: "{}" });

      await expect(readRestartSentinel()).resolves.toBeNull();
      await expect(hasRestartSentinel()).resolves.toBe(false);
      expect(readSentinelRow()).toMatchObject({ kind: "not-a-kind", payload_json: "{}" });
      expect(mockWarn).toHaveBeenCalledWith("Ignoring invalid typed restart sentinel row");
    });
  });

  it.each([
    { continuation_json: JSON.stringify({ kind: "agentTurn", message: 42 }) },
    { stats_json: JSON.stringify({ mode: null }) },
    { stats_json: JSON.stringify({ before: [] }) },
    {
      stats_json: JSON.stringify({
        steps: [{ name: "install", command: "install", log: { exitCode: 0.5 } }],
      }),
    },
    {
      stats_json: JSON.stringify({
        steps: [{ name: "install", command: "install", advisory: null }],
      }),
    },
  ])("rejects malformed typed JSON columns with a valid shadow payload: %j", async (columns) => {
    await withRestartSentinelStateDir(async () => {
      const payload = { kind: "update" as const, status: "ok" as const, ts: 1 };
      await writeRestartSentinel(payload);
      updateSentinelRow({ ...columns, payload_json: JSON.stringify(payload) });

      await expect(readRestartSentinel()).resolves.toBeNull();
      await expect(hasRestartSentinel()).resolves.toBe(false);
    });
  });

  it("upgrades pre-floor rows only when the captured revision still exists", async () => {
    await withRestartSentinelStateDir(async () => {
      const written = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 });
      // Persist a future revision so the worker must advance the floor independently of its clock.
      const first = { ...written, revision: Number.MAX_SAFE_INTEGER - 100 };
      updateSentinelRow({ updated_at_ms: first.revision });
      deleteSentinelRevisionFloor();
      expect(readSentinelRevisionFloor()).toBeUndefined();
      await expect(clearRestartSentinelIfRevision(first.revision)).resolves.toBe(true);

      await expect(readRestartSentinel()).resolves.toBeNull();
      await expect(hasRestartSentinel()).resolves.toBe(false);
      expect(readSentinelRevisionFloor()).toBe(first.revision);

      const second = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 2 });
      expect(second.revision).toBe(first.revision + 1);

      deleteSentinelRevisionFloor();
      await expect(clearRestartSentinelIfRevision(second.revision + 1)).resolves.toBe(false);
      expect(readSentinelRevisionFloor()).toBeUndefined();
      await expect(readRestartSentinel()).resolves.toEqual(second);

      await expect(clearRestartSentinelIfRevision(second.revision)).resolves.toBe(true);
      expect(readSentinelRevisionFloor()).toBe(second.revision);
      const third = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 3 });
      expect(third.revision).toBe(second.revision + 1);

      await expect(clearRestartSentinelIfRevision(third.revision)).resolves.toBe(true);
      deleteSentinelRevisionFloor();
      await expect(clearRestartSentinelIfRevision(third.revision)).resolves.toBe(false);
      expect(readSentinelRevisionFloor()).toBeUndefined();
    });
  });

  it("publishes only the captured sentinel snapshot, including after consumption", async () => {
    await withRestartSentinelStateDir(async () => {
      const initial = await readRestartSentinelSnapshot();
      expect(initial).toEqual({ sentinel: null, revision: null });
      const payload = { kind: "restart" as const, status: "ok" as const, ts: 1 };
      const first = await writeRestartSentinelIfUnchanged({
        payload,
        expectedRevision: initial.revision,
        isCurrent: () => true,
      });
      expect(first).not.toBeNull();
      const snapshot = await readRestartSentinelSnapshot();
      expect(snapshot).toEqual({ sentinel: first, revision: first!.revision });

      await expect(clearRestartSentinelIfRevision(first!.revision)).resolves.toBe(true);
      const consumed = await readRestartSentinelSnapshot();
      expect(consumed).toEqual({ sentinel: null, revision: first!.revision });
      await expect(
        writeRestartSentinelIfUnchanged({
          payload,
          expectedRevision: initial.revision,
          isCurrent: () => true,
        }),
      ).resolves.toBeNull();

      const replacement = await writeRestartSentinelIfUnchanged({
        payload: { ...payload, ts: 2 },
        expectedRevision: consumed.revision,
        isCurrent: () => true,
      });
      expect(replacement?.revision).toBeGreaterThan(first!.revision);
      await expect(
        writeRestartSentinelIfUnchanged({
          payload,
          expectedRevision: snapshot.revision,
          isCurrent: () => true,
        }),
      ).resolves.toBeNull();
      await expect(readRestartSentinel()).resolves.toEqual(replacement);
    });
  });

  it.each(["transaction", "commit"] as const)(
    "preserves the notification when its producer loses authority at %s admission",
    async (stage) => {
      await withRestartSentinelStateDir(async () => {
        const first = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 });
        const snapshot = await readRestartSentinelSnapshot();
        let current = true;
        const observed: string[] = [];
        admission.beforeGrant = (requested) => {
          observed.push(requested);
          if (requested === stage) {
            current = false;
          }
        };
        try {
          await expect(
            writeRestartSentinelIfUnchanged({
              payload: { kind: "update", status: "error", ts: 2 },
              expectedRevision: snapshot.revision,
              isCurrent: () => current,
            }),
          ).resolves.toBeNull();
        } finally {
          admission.beforeGrant = undefined;
        }
        expect(observed).toContain(stage);
        await expect(readRestartSentinelSnapshot()).resolves.toEqual({
          sentinel: first,
          revision: first.revision,
        });
      });
    },
  );

  it("does not let stale deletes remove a newer sentinel", async () => {
    await withRestartSentinelStateDir(async () => {
      const first = await writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: 1,
        message: "old",
      });
      const newer = await writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: 2,
        message: "new",
      });

      await expect(clearRestartSentinelIfRevision(first.revision)).resolves.toBe(false);
      await expect(readRestartSentinel()).resolves.toEqual(newer);
    });
  });

  it("writes the running version back to update sentinels on startup", async () => {
    await withRestartSentinelStateDir(async () => {
      const ts = Date.now();
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts,
        stats: {
          after: { version: "expected-version" },
        },
      });

      await finalizeUpdateRestartSentinelRunningVersion("actual-version");

      await expect(readRestartSentinel()).resolves.toMatchObject({
        version: 1,
        payload: {
          kind: "update",
          status: "ok",
          ts,
          stats: {
            after: {
              version: "actual-version",
            },
          },
        },
      });
    });
  });

  it("finalizes only the captured database when the environment changes during its read", async () => {
    const originalEnv = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-sentinel-original-") };
    const replacementEnv = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-sentinel-replacement-") };
    openOpenClawStateDatabase({ env: originalEnv });
    openOpenClawStateDatabase({ env: replacementEnv });
    const payload = {
      kind: "update" as const,
      status: "ok" as const,
      ts: 1,
      stats: { after: { version: "before" } },
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    let original: ReturnType<typeof writeRestartSentinelRowSync>;
    let replacement: ReturnType<typeof writeRestartSentinelRowSync>;
    try {
      original = runOpenClawStateWriteTransaction(
        ({ db }) => writeRestartSentinelRowSync(db, { ...payload, message: "original" }),
        { env: originalEnv },
      );
      replacement = runOpenClawStateWriteTransaction(
        ({ db }) => writeRestartSentinelRowSync(db, { ...payload, message: "replacement" }),
        { env: replacementEnv },
      );
    } finally {
      clock.mockRestore();
    }
    expect(original.revision).toBe(replacement.revision);

    await withEnvAsync(originalEnv, async () => {
      mockThrowWorkerRead.mockImplementationOnce(() => {
        process.env.OPENCLAW_STATE_DIR = replacementEnv.OPENCLAW_STATE_DIR;
      });
      await expect(
        finalizeUpdateRestartSentinelRunningVersion("running-version"),
      ).resolves.toMatchObject({
        payload: { message: "original", stats: { after: { version: "running-version" } } },
      });
      await expect(readRestartSentinel(originalEnv)).resolves.toMatchObject({
        payload: { message: "original", stats: { after: { version: "running-version" } } },
      });
      await expect(readRestartSentinel(replacementEnv)).resolves.toEqual(replacement);
    });
  });

  it("uses the loaded build commit when finalizing an update", async () => {
    await withRestartSentinelStateDir(async () => {
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts: Date.now(),
        stats: {
          mode: "git",
          root: process.cwd(),
          after: { sha: "aaaaaaa", version: "actual-version" },
        },
      });

      await finalizeUpdateRestartSentinelRunningVersion("actual-version");

      await expect(readRestartSentinel()).resolves.toMatchObject({
        payload: { status: "ok" },
      });
    });
  });

  it("does not rewrite update sentinels when the running version is already current", async () => {
    await withRestartSentinelStateDir(async () => {
      const ts = Date.now();
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts,
        stats: {
          after: { version: "actual-version" },
        },
      });

      await expect(
        finalizeUpdateRestartSentinelRunningVersion("actual-version"),
      ).resolves.toBeNull();
      await expect(readRestartSentinel()).resolves.toMatchObject({
        version: 1,
        payload: {
          kind: "update",
          status: "ok",
          ts,
          stats: {
            after: {
              version: "actual-version",
            },
          },
        },
      });
    });
  });

  it.each([
    { name: "successful update", status: "ok", reason: undefined },
    {
      name: "failed handoff",
      status: "error",
      reason: "managed-service-handoff-failed",
    },
  ] as const)("persists the verified Git install receipt after a $name", async (testCase) => {
    await withRestartSentinelStateDir(async () => {
      await withTestDir({ prefix: "openclaw-install-root-" }, async (tempDir) => {
        const installRoot = path.join(tempDir, "checkout");
        const installAlias = path.join(tempDir, "checkout-alias");
        await fs.mkdir(installRoot);
        await fs.symlink(installRoot, installAlias, "dir");
        const ts = Date.now();
        await writeRestartSentinel({
          kind: "update",
          status: testCase.status,
          ts,
          stats: {
            mode: "git",
            ...(testCase.reason ? { reason: testCase.reason } : {}),
            root: installAlias,
            before: { sha: "aaaaaaaa" },
            after: {
              sha: " bbbbbbbb ",
              upstreamRef: " origin/main ",
              version: "expected-version",
            },
          },
        });

        const finalized = await finalizeUpdateRestartSentinelRunningVersion(
          "actual-version",
          process.env,
          "bbbbbbbb1234",
          installRoot,
        );
        if (!finalized) {
          throw new Error("Expected a finalized update sentinel");
        }
        await expect(clearRestartSentinelIfRevision(finalized.revision)).resolves.toBe(true);

        await expect(readVerifiedGitUpdateReceipt()).resolves.toEqual({
          root: await fs.realpath(installRoot),
          sha: "bbbbbbbb",
          upstreamRef: "origin/main",
          installedAtMs: ts,
        });
      });
    });
  });

  it("does not advance install time when a successful Git run keeps the same revision", async () => {
    await withRestartSentinelStateDir(async () => {
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts: Date.now(),
        stats: {
          mode: "git",
          root: process.cwd(),
          before: { sha: "aaaaaaaa" },
          after: { sha: "aaaaaaaa", version: "expected-version" },
        },
      });

      await finalizeUpdateRestartSentinelRunningVersion(
        "actual-version",
        process.env,
        "aaaaaaaa",
        process.cwd(),
      );

      await expect(readVerifiedGitUpdateReceipt()).resolves.toBeNull();
    });
  });

  it.each([
    {
      name: "successful update",
      status: "ok",
      runningCommit: "cccccccc",
      beforeSha: undefined,
      expectedReason: "restart-revision-mismatch",
    },
    {
      name: "error-status update",
      status: "error",
      runningCommit: "aaaaaaaa",
      beforeSha: "aaaaaaaa",
      expectedReason: "managed-service-handoff-failed",
    },
  ] as const)("rejects a $name whose running Git revision does not match", async (testCase) => {
    await withRestartSentinelStateDir(async () => {
      await writeRestartSentinel({
        kind: "update",
        status: testCase.status,
        ts: Date.now(),
        stats: {
          mode: "git",
          root: process.cwd(),
          ...(testCase.beforeSha ? { before: { sha: testCase.beforeSha } } : {}),
          ...(testCase.status === "error" ? { reason: "managed-service-handoff-failed" } : {}),
          after: { sha: "bbbbbbbb", version: "expected-version" },
        },
      });

      await finalizeUpdateRestartSentinelRunningVersion(
        "actual-version",
        process.env,
        testCase.runningCommit,
        process.cwd(),
      );

      await expect(readRestartSentinel()).resolves.toMatchObject({
        payload: {
          status: "error",
          stats: { reason: testCase.expectedReason },
        },
      });
      await expect(readVerifiedGitUpdateReceipt()).resolves.toBeNull();
    });
  });

  it("rejects the same Git revision when the restarted checkout root differs", async () => {
    await withRestartSentinelStateDir(async () => {
      await withTestDir({ prefix: "openclaw-install-root-mismatch-" }, async (tempDir) => {
        const expectedRoot = path.join(tempDir, "expected");
        const runningRoot = path.join(tempDir, "running");
        await fs.mkdir(expectedRoot);
        await fs.mkdir(runningRoot);
        await writeRestartSentinel({
          kind: "update",
          status: "ok",
          ts: Date.now(),
          stats: {
            mode: "git",
            root: expectedRoot,
            before: { sha: "aaaaaaaa" },
            after: { sha: "bbbbbbbb", version: "expected-version" },
          },
        });

        await finalizeUpdateRestartSentinelRunningVersion(
          "actual-version",
          process.env,
          "bbbbbbbb1234",
          runningRoot,
        );

        await expect(readRestartSentinel()).resolves.toMatchObject({
          payload: {
            status: "error",
            stats: { reason: "restart-root-mismatch" },
          },
        });
        await expect(readVerifiedGitUpdateReceipt()).resolves.toBeNull();
      });
    });
  });

  it("marks update restart failures with a stable reason", async () => {
    await withRestartSentinelStateDir(async () => {
      const ts = Date.now();
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts,
        stats: {},
      });

      await markUpdateRestartSentinelFailure("restart-unhealthy");

      await expect(readRestartSentinel()).resolves.toMatchObject({
        version: 1,
        payload: {
          kind: "update",
          status: "error",
          ts,
          stats: {
            reason: "restart-unhealthy",
          },
        },
      });
    });
  });
});

describe("restart sentinel error visibility", () => {
  it("throws when revision-owned cleanup cannot durably delete the row", async () => {
    await withRestartSentinelStateDir(async () => {
      const written = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 });
      mockThrowWorkerWrite.mockImplementationOnce(() => {
        throw new Error("SQLITE_IOERR: disk I/O error");
      });

      await expect(clearRestartSentinelIfRevision(written.revision)).rejects.toThrow(
        "SQLITE_IOERR: disk I/O error",
      );
      expect(mockWarn).not.toHaveBeenCalled();
      await expect(readRestartSentinel()).resolves.toEqual(written);
    });
  });

  it("logs a warning and returns null when readRestartSentinel DB read fails", async () => {
    mockThrowWorkerRead.mockImplementationOnce(() => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    });

    await withRestartSentinelStateDir(async () => {
      await expect(readRestartSentinel()).resolves.toBeNull();

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        "Failed to read restart sentinel: SQLITE_CORRUPT: database disk image is malformed",
      );
    });
  });

  it("logs a warning and returns false when hasRestartSentinel DB read fails", async () => {
    mockThrowWorkerRead.mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    await withRestartSentinelStateDir(async () => {
      await expect(hasRestartSentinel()).resolves.toBe(false);

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        "Failed to check restart sentinel: SQLITE_BUSY: database is locked",
      );
    });
  });
});
