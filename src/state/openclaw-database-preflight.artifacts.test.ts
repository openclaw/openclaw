import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
  hasSchemaRefusal,
} from "../cli/update-cli/schema-preflight.js";
import { resolveConfiguredAgentDatabaseCandidatePaths } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readMainDatabasePosixLocks } from "../infra/sqlite-posix-locks.test-support.js";
import * as snapshots from "../infra/sqlite-readonly-location.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const supportedVersions = {
  state: OPENCLAW_STATE_SCHEMA_VERSION,
  agent: OPENCLAW_AGENT_SCHEMA_VERSION,
};

// Exercise the production capture/union entry points, not a test-only export.
async function checkTargetDatabaseSchemas(
  versions: typeof supportedVersions,
  env: NodeJS.ProcessEnv,
  config?: OpenClawConfig,
) {
  const context = config ? { config, env } : await captureTargetDatabaseSchemaContext(env);
  return checkTargetDatabaseSchemasForContexts(versions, [context]);
}

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

beforeEach(() => {
  vi.stubEnv("XDG_CACHE_HOME", tempDirs.make("openclaw-preflight-snapshots-"));
});

function createFixture(storeDirectory?: string) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preflight-artifacts-") };
  const state = openOpenClawStateDatabase({ env });
  const main = openOpenClawAgentDatabase({
    agentId: "main",
    env,
    ...(storeDirectory ? { path: path.join(storeDirectory, "openclaw-agent.sqlite") } : {}),
  });
  const worker = openOpenClawAgentDatabase({
    agentId: "worker",
    env,
    ...(storeDirectory ? { path: path.join(storeDirectory, "openclaw-agent.worker.sqlite") } : {}),
  });
  return {
    env,
    state,
    main,
    worker,
    paths: [state.path, main.path, worker.path],
    close() {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    },
  };
}

function sourceArtifacts(paths: string[], allowReadMarks: string[] = []): unknown {
  // Observe in a child too: opening/closing these in the writer's process can
  // itself release POSIX locks and would invalidate the writer-isolation probe.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
       const allowReadMarks = JSON.parse(process.argv[1]);
       const record = file => {
         const s = fs.statSync(file, { bigint: true });
         const readMarks = allowReadMarks.some(database => file === database + '-shm');
         const bytes = s.isFile() ? fs.readFileSync(file) : undefined;
         if (readMarks) bytes.fill(0, 100, 120);
         return { file, mode: String(s.mode), dev: String(s.dev), ino: String(s.ino),
           size: String(s.size),
           ...(!readMarks ? { mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) } : {}),
           ...(bytes ? { hash: crypto.createHash('sha256').update(bytes).digest('hex') }
             : { entries: fs.readdirSync(file).sort() }) };
       };
       console.log(JSON.stringify(process.argv.slice(2).map(file => ({
         directory: record(path.dirname(file)),
         family: ['', '-wal', '-shm', '-journal'].map(suffix => file + suffix)
           .filter(fs.existsSync).map(record)
       }))));`,
      JSON.stringify(allowReadMarks),
      ...paths,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("schema preflight source artifacts", () => {
  it.each([OPENCLAW_AGENT_SCHEMA_VERSION, 999])(
    "includes configured partitions at schema %s without opening their source families",
    async (workerVersion) => {
      const directory = tempDirs.make("openclaw-configured-preflight-");
      const fixture = createFixture(directory);
      fixture.worker.db.exec(`PRAGMA user_version = ${workerVersion};`);
      for (const database of [fixture.main, fixture.worker]) {
        unregisterOpenClawAgentDatabase({
          agentId: database.agentId,
          path: database.path,
          env: fixture.env,
        });
      }
      fixture.close();
      const before = sourceArtifacts(fixture.paths);
      const candidates = resolveConfiguredAgentDatabaseCandidatePaths(
        {
          agents: { list: [{ id: "main" }, { id: "worker" }] },
          session: { store: path.join(directory, "sessions.json") },
        },
        { env: fixture.env },
      );
      expect(candidates).toEqual([fixture.main.path, fixture.worker.path]);
      const result = await preflightOpenClawDatabaseSchemas({
        env: fixture.env,
        supportedVersions,
        configuredAgentDatabaseCandidatePaths: candidates,
      });
      expect(result.indeterminate).toEqual([]);
      expect(result.incompatible).toEqual(
        workerVersion > supportedVersions.agent
          ? [expect.objectContaining({ path: fixture.worker.path, foundVersion: workerVersion })]
          : [],
      );
      expect(sourceArtifacts(fixture.paths)).toEqual(before);
    },
  );

  it("checks configured stores and registered external stores without adopting migration ownership", async () => {
    const directory = tempDirs.make("openclaw-configured-preflight-");
    const fixture = createFixture(directory);
    for (const database of [fixture.main, fixture.worker]) {
      unregisterOpenClawAgentDatabase({
        agentId: database.agentId,
        path: database.path,
        env: fixture.env,
      });
    }
    const retired = openOpenClawAgentDatabase({
      agentId: "retired",
      env: fixture.env,
      path: path.join(tempDirs.make("openclaw-registered-preflight-"), "retired.sqlite"),
    });
    fs.writeFileSync(
      path.join(fixture.env.OPENCLAW_STATE_DIR, "openclaw.json"),
      JSON.stringify({
        agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
        session: { store: path.join(directory, "sessions.json") },
      }),
    );
    fixture.close();
    const paths = [...fixture.paths, retired.path];
    const before = sourceArtifacts(paths);
    const result = await checkTargetDatabaseSchemas(
      { state: supportedVersions.state - 1, agent: supportedVersions.agent - 1 },
      fixture.env,
    );
    expect(result.indeterminate).toEqual([]);
    expect(result.incompatible.map((database) => database.path).toSorted()).toEqual(
      paths.toSorted(),
    );
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it.each([false, true])(
    "unions native locators and aliases without dropping distinct stores, reversed=%s",
    async (reversed) => {
      const fixture = createFixture();
      fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
      unregisterOpenClawAgentDatabase({
        agentId: "worker",
        path: fixture.worker.path,
        env: fixture.env,
      });
      const link = path.join(fixture.env.OPENCLAW_STATE_DIR, "worker-link");
      fs.symlinkSync(path.dirname(fixture.worker.path), link, "dir");
      const locator = `${link}${path.sep}..${path.sep}agent${path.sep}openclaw-agent.sqlite`;
      registerOpenClawAgentDatabase({ agentId: "worker", path: locator, env: fixture.env });
      fixture.close();
      const lexicalPath = path.resolve(locator);
      fs.mkdirSync(path.dirname(lexicalPath), { recursive: true });
      fs.copyFileSync(fixture.main.path, lexicalPath, fs.constants.COPYFILE_EXCL);
      expect(fs.realpathSync.native(locator)).toBe(fs.realpathSync.native(fixture.worker.path));
      expect(fs.realpathSync(locator)).toBe(fs.realpathSync.native(lexicalPath));
      const callerEnv = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preflight-caller-") };
      const contexts = [
        { env: fixture.env, config: {} },
        { env: callerEnv, config: { session: { store: lexicalPath } } },
        { env: callerEnv, config: { session: { store: fixture.worker.path } } },
      ];
      const paths = [
        ...fixture.paths,
        lexicalPath,
        path.join(callerEnv.OPENCLAW_STATE_DIR, "absent.sqlite"),
      ];
      const before = sourceArtifacts(paths);
      const result = await checkTargetDatabaseSchemasForContexts(
        { ...supportedVersions, agent: supportedVersions.agent - 1 },
        reversed ? contexts.toReversed() : contexts,
      );
      expect(result.indeterminate).toEqual([]);
      expect(
        result.incompatible.map((database) => fs.realpathSync.native(database.path)).toSorted(),
      ).toEqual([fixture.main.path, fixture.worker.path, lexicalPath].toSorted());
      expect(
        result.incompatible.find(
          (database) => database.foundVersion === supportedVersions.agent + 10,
        )?.path,
      ).toBe(reversed ? fixture.worker.path : locator);
      expect(sourceArtifacts(paths)).toEqual(before);
    },
  );

  it("refuses unreadable config during capture and preserves metadata-free schema checks", async () => {
    const fixture = createFixture();
    const configPath = path.join(fixture.env.OPENCLAW_STATE_DIR, "openclaw.json");
    fs.writeFileSync(configPath, "{ invalid synthetic config");
    fixture.close();
    const paths = [...fixture.paths, configPath];
    const before = sourceArtifacts(paths);
    await expect(checkTargetDatabaseSchemas(supportedVersions, fixture.env)).rejects.toMatchObject({
      reason: "database-schema-preflight",
    });
    expect(
      await checkTargetDatabaseSchemasForContexts(undefined, [{ env: fixture.env, config: {} }]),
    ).toEqual({
      incompatible: [],
      indeterminate: [],
    });
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it("uses config-derived state selection without changing caller env or overriding explicit selection", async () => {
    const fixture = createFixture();
    fixture.worker.db.exec("PRAGMA user_version = 999;");
    const explicitFixture = createFixture();
    const configPath = path.join(fixture.env.OPENCLAW_STATE_DIR, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ env: { vars: { OPENCLAW_STATE_DIR: fixture.env.OPENCLAW_STATE_DIR } } }),
    );
    fixture.close();
    const callerEnv = Object.freeze({
      OPENCLAW_HOME: tempDirs.make("openclaw-preflight-application-root-"),
      OPENCLAW_CONFIG_PATH: configPath,
    });
    const paths = [...fixture.paths, ...explicitFixture.paths, configPath];
    const before = sourceArtifacts(paths);
    const expected = {
      incompatible: [expect.objectContaining({ path: fixture.worker.path, foundVersion: 999 })],
      indeterminate: [],
    };
    expect(await checkTargetDatabaseSchemas(supportedVersions, callerEnv)).toEqual(expected);
    expect(
      await checkTargetDatabaseSchemas(supportedVersions, { ...callerEnv, ...fixture.env }),
    ).toEqual(expected);
    expect(
      await checkTargetDatabaseSchemas(supportedVersions, { ...callerEnv, ...explicitFixture.env }),
    ).toEqual({ incompatible: [], indeterminate: [] });
    expect(callerEnv).not.toHaveProperty("OPENCLAW_STATE_DIR");
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it("classifies unavailable configured inventory as a pre-mutation refusal, but allows absent stores", async () => {
    const fixture = createFixture();
    const blockedDirectory = path.join(fixture.env.OPENCLAW_STATE_DIR, "not-a-directory");
    fs.writeFileSync(blockedDirectory, "inert regular file\n");
    fixture.close();
    const paths = [...fixture.paths, blockedDirectory];
    const before = sourceArtifacts(paths);
    await expect(
      checkTargetDatabaseSchemasForContexts(supportedVersions, [
        {
          env: fixture.env,
          config: { session: { store: path.join(blockedDirectory, "sessions.json") } },
        },
      ]),
    ).rejects.toMatchObject({
      name: "UpdatePreMutationError",
      reason: "database-schema-preflight",
      message: expect.stringContaining("ENOTDIR"),
    });
    expect(
      await checkTargetDatabaseSchemasForContexts(supportedVersions, [
        {
          env: fixture.env,
          config: {
            session: {
              store: path.join(fixture.env.OPENCLAW_STATE_DIR, "missing", "sessions.json"),
            },
          },
        },
      ]),
    ).toEqual({ incompatible: [], indeterminate: [] });
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it("refuses an unavailable direct SQLite locator without treating it as absent", async () => {
    const fixture = createFixture();
    const blockedDirectory = path.join(fixture.env.OPENCLAW_STATE_DIR, "not-a-directory");
    fs.writeFileSync(blockedDirectory, "inert regular file\n");
    fixture.close();
    const paths = [...fixture.paths, blockedDirectory];
    const before = sourceArtifacts(paths);
    const store = path.join(blockedDirectory, "agent.sqlite");
    expect(
      await checkTargetDatabaseSchemas(supportedVersions, fixture.env, { session: { store } }),
    ).toEqual({
      incompatible: [],
      indeterminate: [{ kind: "agent", path: store, reason: expect.stringContaining("ENOTDIR") }],
    });
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it.each(["compatible", "refusal"])("preserves closed WAL stores on %s", async (outcome) => {
    const fixture = createFixture();
    fixture.close();
    const before = sourceArtifacts(fixture.paths);
    const result = await checkTargetDatabaseSchemas(
      outcome === "compatible"
        ? supportedVersions
        : { state: supportedVersions.state - 1, agent: supportedVersions.agent - 1 },
      fixture.env,
    );
    expect(result.indeterminate).toEqual([]);
    expect(result.incompatible.map((database) => database.path)).toEqual(
      outcome === "compatible" ? [] : fixture.paths,
    );
    expect(sourceArtifacts(fixture.paths)).toEqual(before);
  });

  it("reads newer live WAL schemas without changing contents beyond agent SHM read marks", async () => {
    const fixture = createFixture();
    fixture.state.db.exec(`PRAGMA user_version = ${supportedVersions.state + 10};`);
    fixture.main.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
    fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
    // SQLite's WAL-index read-mark array occupies bytes 100..119 of SHM.
    const allowReadMarks = [fixture.main.path, fixture.worker.path];
    const before = sourceArtifacts(fixture.paths, allowReadMarks);
    let eventLoopServiced = false;
    const immediate = setImmediate(() => {
      eventLoopServiced = true;
    });
    try {
      const result = await preflightOpenClawDatabaseSchemas({
        env: fixture.env,
        supportedVersions,
        verifyCurrentSchemaShape: true,
      });
      expect(eventLoopServiced).toBe(true);
      expect(result.indeterminate).toEqual([]);
      expect(
        result.incompatible.map(({ path: pathname, foundVersion }) => [pathname, foundVersion]),
      ).toEqual([
        [fixture.state.path, supportedVersions.state + 10],
        [fixture.main.path, supportedVersions.agent + 10],
        [fixture.worker.path, supportedVersions.agent + 10],
      ]);
      expect(sourceArtifacts(fixture.paths, allowReadMarks)).toEqual(before);
    } finally {
      clearImmediate(immediate);
    }
  });

  it.each(["compatible", "incompatible"] as const)(
    "inspects %s agent schemas while an independent WAL writer keeps committing",
    async (outcome) => {
      const fixture = createFixture();
      const foundVersion = supportedVersions.agent + (outcome === "incompatible" ? 1 : 0);
      // A 64 MiB source makes each byte-copy attempt overlap real commits.
      fixture.main.db.exec(`
        CREATE TABLE payloads (value BLOB NOT NULL) STRICT;
        WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 1024)
        INSERT INTO payloads SELECT zeroblob(65536) FROM rows;
        CREATE TABLE heartbeat (value INTEGER NOT NULL) STRICT;
        INSERT INTO heartbeat VALUES (0);
        PRAGMA user_version = ${foundVersion};
      `);
      fixture.close();
      const mainHash = () =>
        createHash("sha256").update(fs.readFileSync(fixture.main.path)).digest("hex");
      const mainBefore = mainHash();
      const stateBefore = sourceArtifacts([fixture.state.path]);
      const writer = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
          import { DatabaseSync } from "node:sqlite";
          const database = new DatabaseSync(process.argv[1]);
          database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
          const write = database.prepare("UPDATE heartbeat SET value = value + 1");
          let commits = 0;
          function commit() {
            write.run();
            commits += 1;
            setImmediate(commit);
          }
          process.on("message", () => process.send(commits));
          process.on("disconnect", () => process.exit());
          commit();
          process.send(commits);
          `,
          fixture.main.path,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let stderr = "";
      writer.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const closed = once(writer, "close");
      // IPC samples committed progress without attaching a reader to the source.
      const receiveProgress = async () => {
        const [commits] = await Promise.race([
          once(writer, "message"),
          closed.then(() => {
            throw new Error(`SQLite writer exited during inspection: ${stderr}`);
          }),
        ]);
        if (typeof commits !== "number") {
          throw new Error("SQLite writer did not report its committed progress");
        }
        return commits;
      };
      try {
        await receiveProgress();
        const walBefore = fs.readFileSync(`${fixture.main.path}-wal`);
        for (const inspect of [
          () => preflightOpenClawDatabaseSchemas({ env: fixture.env, supportedVersions }),
          () =>
            checkTargetDatabaseSchemasForContexts(supportedVersions, [
              { env: fixture.env, config: {} },
            ]),
        ]) {
          const before = receiveProgress();
          writer.send("progress");
          const commitsBefore = await before;
          const result = await inspect();
          const after = receiveProgress();
          writer.send("progress");
          expect(await after).toBeGreaterThan(commitsBefore);
          expect(writer.exitCode).toBeNull();
          expect(result.indeterminate).toEqual([]);
          expect(result.incompatible).toEqual(
            outcome === "compatible"
              ? []
              : [expect.objectContaining({ kind: "agent", path: fixture.main.path, foundVersion })],
          );
          expect(hasSchemaRefusal(result)).toBe(outcome === "incompatible");
        }
        // The writer appends WAL frames. Inspection must not checkpoint the main
        // database or rewrite any preexisting WAL bytes while those commits run.
        expect(mainHash()).toBe(mainBefore);
        const wal = fs.openSync(`${fixture.main.path}-wal`, "r");
        try {
          const prefix = Buffer.alloc(walBefore.length);
          expect(fs.readSync(wal, prefix, 0, prefix.length, 0)).toBe(prefix.length);
          expect(prefix).toEqual(walBefore);
        } finally {
          fs.closeSync(wal);
        }
        expect(sourceArtifacts([fixture.state.path])).toEqual(stateBefore);
      } finally {
        writer.kill();
        await closed;
      }
    },
    30_000,
  );

  it("ignores uncommitted writer versions without ending the owning transactions", async () => {
    const fixture = createFixture();
    const databases = [fixture.state, fixture.main, fixture.worker];
    for (const opened of databases) {
      opened.db.exec("BEGIN IMMEDIATE; PRAGMA user_version = 999;");
    }
    try {
      const allowReadMarks = [fixture.main.path, fixture.worker.path];
      const before = sourceArtifacts(fixture.paths, allowReadMarks);
      const locks =
        process.platform === "linux" ? fixture.paths.map(readMainDatabasePosixLocks) : [];
      expect(await checkTargetDatabaseSchemas(supportedVersions, fixture.env)).toEqual({
        incompatible: [],
        indeterminate: [],
      });
      expect(sourceArtifacts(fixture.paths, allowReadMarks)).toEqual(before);
      for (const opened of databases) {
        expect(opened.db.isTransaction).toBe(true);
        expect(opened.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
      }
      if (process.platform === "linux") {
        expect(locks.every((held) => held.length > 0)).toBe(true);
        expect(fixture.paths.map(readMainDatabasePosixLocks)).toEqual(locks);
      }
    } finally {
      for (const opened of databases) {
        opened.db.exec("ROLLBACK");
      }
    }
  });

  it("preserves a candidate symlink locator and reads the physical database", async () => {
    const fixture = createFixture();
    unregisterOpenClawAgentDatabase({
      agentId: "worker",
      path: fixture.worker.path,
      env: fixture.env,
    });
    fixture.close();
    const alias = path.join(fixture.env.OPENCLAW_STATE_DIR, "worker-alias.sqlite");
    fs.symlinkSync(fixture.worker.path, alias);
    const before = sourceArtifacts([...fixture.paths, alias]);
    const result = await preflightOpenClawDatabaseSchemas({
      env: fixture.env,
      supportedVersions: { ...supportedVersions, agent: supportedVersions.agent - 1 },
      configuredAgentDatabaseCandidatePaths: [alias],
    });
    expect(result.indeterminate).toEqual([]);
    expect(result.incompatible.map((database) => database.path)).toEqual([
      fixture.main.path,
      alias,
    ]);
    expect(sourceArtifacts([...fixture.paths, alias])).toEqual(before);
  });

  it.each(["registered", "candidate"] as const)(
    "preserves native traversal and deduplication for a %s dot-dot locator",
    async (kind) => {
      const fixture = createFixture();
      fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
      unregisterOpenClawAgentDatabase({
        agentId: "worker",
        path: fixture.worker.path,
        env: fixture.env,
      });
      const link = path.join(fixture.env.OPENCLAW_STATE_DIR, "worker-link");
      fs.symlinkSync(path.dirname(fixture.worker.path), link, "dir");
      const locator = `${link}${path.sep}..${path.sep}agent${path.sep}openclaw-agent.sqlite`;
      if (kind === "registered") {
        registerOpenClawAgentDatabase({ agentId: "worker", path: locator, env: fixture.env });
      }
      fixture.close();
      const lexicalPath = path.resolve(locator);
      fs.mkdirSync(path.dirname(lexicalPath), { recursive: true });
      fs.copyFileSync(fixture.main.path, lexicalPath, fs.constants.COPYFILE_EXCL);
      expect(fs.realpathSync.native(locator)).toBe(fs.realpathSync.native(fixture.worker.path));
      expect(fs.realpathSync(locator)).toBe(fs.realpathSync.native(lexicalPath));
      const paths = [...fixture.paths, lexicalPath];
      const before = sourceArtifacts(paths);
      const result = await preflightOpenClawDatabaseSchemas({
        env: fixture.env,
        supportedVersions,
        configuredAgentDatabaseCandidatePaths:
          kind === "candidate"
            ? [locator, fixture.worker.path, lexicalPath]
            : [fixture.worker.path, lexicalPath],
      });
      expect(result.indeterminate).toEqual([]);
      expect(result.incompatible).toEqual([
        expect.objectContaining({
          path: locator,
          foundVersion: supportedVersions.agent + 10,
        }),
      ]);
      expect(sourceArtifacts(paths)).toEqual(before);
    },
  );

  it.each(["state", "main"] as const)(
    "fails closed when the %s snapshot cannot be prepared",
    async (kind) => {
      const fixture = createFixture();
      fixture.close();
      const before = sourceArtifacts(fixture.paths);
      const prepare = snapshots.prepareSqliteReadOnlyLocation;
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
        async (pathname, options) => {
          if (pathname === fixture[kind].path) {
            throw new Error("inert snapshot admission failure");
          }
          return await prepare(pathname, options);
        },
      );
      const result = await checkTargetDatabaseSchemas(supportedVersions, fixture.env);
      expect(result.incompatible).toEqual([]);
      expect(result.indeterminate).toEqual([
        {
          kind: kind === "state" ? "state" : "agent",
          path: fixture[kind].path,
          reason: "inert snapshot admission failure",
        },
      ]);
      expect(sourceArtifacts(fixture.paths)).toEqual(before);
    },
  );

  it.each(["state", "main"] as const)(
    "cleans the %s snapshot when its private open fails",
    async (kind) => {
      const fixture = createFixture();
      fixture.close();
      const before = sourceArtifacts(fixture.paths);
      const prepare = snapshots.prepareSqliteReadOnlyLocation;
      const cleanups: Array<{ location: string; cleanup: ReturnType<typeof vi.fn> }> = [];
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
        async (pathname, options) => {
          const prepared = await prepare(pathname, options);
          const cleanup = vi.fn(prepared.cleanup);
          cleanups.push({ location: prepared.location, cleanup });
          return {
            location:
              pathname === fixture[kind].path
                ? path.join(path.dirname(prepared.location), "missing.sqlite")
                : prepared.location,
            cleanup,
          };
        },
      );
      const result = await checkTargetDatabaseSchemas(supportedVersions, fixture.env);
      expect(result.indeterminate).toEqual([
        expect.objectContaining({
          kind: kind === "state" ? "state" : "agent",
          path: fixture[kind].path,
        }),
      ]);
      expect(cleanups.length).toBe(kind === "state" ? 1 : 3);
      for (const { location, cleanup } of cleanups) {
        expect(cleanup).toHaveBeenCalledOnce();
        expect(fs.existsSync(path.dirname(location))).toBe(false);
      }
      expect(sourceArtifacts(fixture.paths)).toEqual(before);
    },
  );
});
