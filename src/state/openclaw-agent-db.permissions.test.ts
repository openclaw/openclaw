import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureSqliteDatabaseAdmissions,
  withSqliteDatabaseAdmissionExchange,
} from "../infra/sqlite-database-admission.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";

const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  calls: [] as unknown[],
  removeTarget: undefined as string | undefined,
  stats: 0,
}));
const workerAdmission = vi.hoisted(() =>
  vi.fn<
    typeof import("../infra/sqlite-worker-operation-admission.js").requestSqliteWorkerOperationAdmission
  >(),
);

vi.mock("../infra/sqlite-worker-operation-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-worker-operation-admission.js")>()),
  requestSqliteWorkerOperationAdmission: (...args: Parameters<typeof workerAdmission>) => {
    const [request] = args;
    const facts = request.facts;
    if (
      facts &&
      typeof facts === "object" &&
      "validationPort" in facts &&
      facts.validationPort instanceof MessagePort
    ) {
      facts.validationPort.postMessage({}, []);
    }
    workerAdmission(...args);
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    chmodFailHook.calls.push(target);
    if (chmodFailHook.error) {
      throw chmodFailHook.error;
    }
    if (chmodFailHook.removeTarget && target === chmodFailHook.removeTarget) {
      actual.unlinkSync(chmodFailHook.removeTarget);
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  const countStat = <T extends typeof actual.statSync | typeof actual.lstatSync>(stat: T): T =>
    new Proxy(stat, {
      apply(target, receiver, args) {
        chmodFailHook.stats += 1;
        return Reflect.apply(target, receiver, args);
      },
    });
  const statSync = countStat(actual.statSync);
  const lstatSync = countStat(actual.lstatSync);
  return {
    ...actual,
    chmodSync,
    statSync,
    lstatSync,
    default: { ...actual, chmodSync, statSync, lstatSync },
  };
});

const {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} = await import("./openclaw-agent-db.js");
const { openExistingSqliteWorkerBackend } = await import("./openclaw-agent-execution.worker.js");
const { closeOpenClawStateDatabaseForTest, openOpenClawStateDatabase } =
  await import("./openclaw-state-db.js");
const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const backends = new Set<ReturnType<typeof openExistingSqliteWorkerBackend>>();

describe("agent database permission repair", () => {
  afterEach(async () => {
    chmodFailHook.error = undefined;
    chmodFailHook.calls = [];
    chmodFailHook.removeTarget = undefined;
    chmodFailHook.stats = 0;
    workerAdmission.mockReset();
    await Promise.all([...backends].map((backend) => Promise.resolve(backend.close())));
    backends.clear();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("rolls back a warm borrowed write after commit authority is refused", async () => {
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-agent-worker-permissions-") },
    };
    const seeded = openOpenClawAgentDatabase(options);
    const databasePath = seeded.path;
    seeded.db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
    closeOpenClawAgentDatabasesForTest();
    const shared = openOpenClawStateDatabase({ env: options.env });
    const backend = openExistingSqliteWorkerBackend(
      {
        agentId: options.agentId,
        databasePath,
        stateDatabasePath: shared.path,
        environment: options.env,
        leaseId: randomUUID(),
      },
      { databasePath },
    );
    backends.add(backend);
    const execute = (command: Parameters<typeof backend.execute>[0]) => {
      const admission = createSqliteWorkerOperationAdmission(() => {}, {
        kind: "agent-execution",
        startupJournal: false,
      });
      try {
        return withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
          // This fixture runs both owners in one isolate; a port round trip would deadlock.
          withSqliteDatabaseAdmissionExchange(
            () => captureSqliteDatabaseAdmissions(),
            () => backend.execute(command),
          ),
        );
      } finally {
        admission.finish();
      }
    };
    execute({ type: "database.prepareWrite", input: undefined });
    const database = openOpenClawAgentDatabase(options);
    const bind = {
      type: "database.domain.bind" as const,
      input: {
        id: "permission-fixture",
        moduleUrl: new URL("./openclaw-agent-worker-store.test-support.ts", import.meta.url).href,
        input: undefined,
      },
    };
    await backend.prepare?.(bind);
    execute(bind);
    const append = (value: string) =>
      execute({
        type: "database.domain.execute",
        input: {
          id: bind.input.id,
          command: { type: "append", input: { value } },
        },
      });
    append("accepted");
    if (process.platform !== "win32") {
      fs.chmodSync(databasePath, 0o644);
    }
    const refused = Object.assign(new Error("authority refused before commit"), {
      code: "EACCES",
    });
    chmodFailHook.calls = [];
    workerAdmission.mockClear();
    workerAdmission.mockImplementation((request) => {
      if (request.stage === "commit") {
        throw refused;
      }
    });

    expect(() => append("refused")).toThrow(refused);
    expect(workerAdmission).toHaveBeenCalledWith({
      stage: "commit",
      facts: expect.any(Object),
    });
    expect(chmodFailHook.calls).toEqual([]);
    backend.assertSettled?.();
    expect(database.db.prepare("SELECT value FROM worker_proof ORDER BY rowid").all()).toEqual([
      { value: "accepted" },
    ]);

    chmodFailHook.error = undefined;
    workerAdmission.mockReset();
    append("recovered");
    expect(database.db.prepare("SELECT value FROM worker_proof ORDER BY rowid").all()).toEqual([
      { value: "accepted" },
      { value: "recovered" },
    ]);
    if (process.platform !== "win32") {
      expect(fs.statSync(databasePath).mode & 0o7777).toBe(0o644);
    }
  });

  it("refuses to open a database when permission repair fails", () => {
    const stateDir = tempDirs.make("openclaw-agent-chmod-");
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    const database = openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabasesForTest();
    const permissionError = Object.assign(new Error("EACCES: chmod failed"), {
      code: "EACCES",
    });
    if (process.platform !== "win32") {
      fs.chmodSync(database.path, 0o644);
    }
    chmodFailHook.error = permissionError;

    expect(() => openOpenClawAgentDatabase(options)).toThrow(permissionError);
    chmodFailHook.error = undefined;
    expect(openOpenClawAgentDatabase(options).db.isOpen).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "bounds warm write filesystem checks and repairs permission drift on reopen",
    () => {
      const options = {
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-agent-chmod-") },
      };
      const database = openOpenClawAgentDatabase(options);
      const directory = path.dirname(database.path);
      const files = [database.path, `${database.path}-wal`, `${database.path}-shm`];
      const write = () =>
        runOpenClawAgentWriteTransaction(({ db }) => {
          db.prepare("UPDATE schema_meta SET updated_at = updated_at + 1").run();
        }, options);

      chmodFailHook.calls = [];
      chmodFailHook.stats = 0;
      for (let index = 0; index < 16; index += 1) {
        write();
      }
      expect(chmodFailHook.calls).toEqual([]);
      expect(chmodFailHook.stats).toBeLessThanOrEqual(16);

      fs.chmodSync(directory, 0o1700);
      fs.chmodSync(database.path, 0o4600);
      for (const file of files.slice(1)) {
        fs.chmodSync(file, 0o644);
      }
      write();
      expect(fs.statSync(database.path).mode & 0o7777).toBe(0o4600);
      closeOpenClawAgentDatabasesForTest();
      openOpenClawAgentDatabase(options);
      expect(fs.statSync(directory).mode & 0o7777).toBe(0o700);
      expect(fs.statSync(database.path).mode & 0o7777).toBe(0o600);
    },
  );

  it("reuses admitted descriptor identity across warm admission boundaries and writes", () => {
    const databasePath = path.join(tempDirs.make("sqlite-admission-stat-"), "state.sqlite");
    const result = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx/esm"),
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const { openNodeSqliteDatabase } = await import(process.argv[2]);
          const { admitSqliteSchema } = await import(process.argv[3]);
          const { captureSqliteDatabaseAdmissions, hasSqliteDatabaseSchemaAdmissionForPath } = await import(process.argv[4]);
          const database = openNodeSqliteDatabase(process.argv[1]);
          database.exec("CREATE TABLE proof(value); INSERT INTO proof VALUES (0)");
          admitSqliteSchema(database);
          let stats = 0;
          for (const name of ["statSync", "lstatSync", "fstatSync"]) {
            const original = fs[name];
            fs[name] = (...args) => { stats++; return original(...args); };
          }
          syncBuiltinESMExports();
          for (let index = 0; index < 16; index++) {
            if (!hasSqliteDatabaseSchemaAdmissionForPath(process.argv[1])) throw new Error("lost schema admission");
            if (captureSqliteDatabaseAdmissions(undefined, { location: process.argv[1] }).length !== 1) throw new Error("lost descriptor facts");
            database.prepare("UPDATE proof SET value = value + 1").run();
          }
          const row = database.prepare("SELECT value FROM proof").get();
          database.close();
          process.stdout.write(JSON.stringify({ stats, value: row.value }));
        `,
        databasePath,
        new URL("../infra/node-sqlite.ts", import.meta.url).href,
        new URL("../infra/sqlite-schema-facts.ts", import.meta.url).href,
        new URL("../infra/sqlite-database-admission.ts", import.meta.url).href,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual({ stats: 0, value: 16 });
  });

  it("opens when a transient sidecar disappears during permission repair", () => {
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-agent-sidecar-") },
    };
    const database = openOpenClawAgentDatabase(options);
    const journal = `${database.path}-journal`;
    closeOpenClawAgentDatabasesForTest();
    fs.writeFileSync(journal, "", { mode: 0o644 });
    fs.chmodSync(journal, 0o644);
    chmodFailHook.removeTarget = journal;
    expect(openOpenClawAgentDatabase(options).db.isOpen).toBe(true);
    expect(fs.existsSync(journal)).toBe(false);
  });
});
