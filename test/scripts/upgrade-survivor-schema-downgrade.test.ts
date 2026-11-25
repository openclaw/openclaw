import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { watch } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startNodeFixture } from "../../scripts/e2e/lib/upgrade-survivor/release-process.mjs";
import { needsSchemaDowngrade } from "../../scripts/e2e/lib/upgrade-survivor/schema-downgrade-source.mjs";
import {
  classifySchemaDowngrade,
  runSchemaDowngrade,
} from "../../scripts/e2e/lib/upgrade-survivor/schema-downgrade.mjs";
import {
  inspectFixtureStores,
  readSqliteStoreFacts,
  restoreRaisedFloorStores,
  snapshotFixtureStores,
} from "../../scripts/e2e/lib/upgrade-survivor/schema-store-facts.mjs";
import { acquireTestPortBlock } from "../../src/test-utils/port-claims.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const barrier = resolve("scripts/e2e/lib/upgrade-survivor/schema-downgrade-barrier.mjs");
const targets = { state: 5, agent: 7 };

async function sentinelAt(directory: string, filename: string) {
  for await (const event of watch(directory, { signal: AbortSignal.timeout(5000) })) {
    if (event.filename && join(directory, event.filename) !== filename) {
      continue;
    }
    try {
      return JSON.parse(readFileSync(filename, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error("Barrier sentinel watcher closed before observation");
}

function connect(port: number): Promise<string> {
  const { promise, resolve: complete } = Promise.withResolvers<string>();
  const socket = createConnection({ port, host: "127.0.0.1", signal: AbortSignal.timeout(2000) });
  socket.once("connect", () => {
    socket.destroy();
    complete("connected");
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    socket.destroy();
    complete(error.code ?? error.message);
  });
  return promise;
}

describe("schema downgrade pre-listen barrier", () => {
  it.each(["number", "string-options"])(
    "parks only the exact requested TCP port (%s), leaving a real adjacent listener untouched",
    async (form) => {
      const root = tempDirs.make("schema-barrier-");
      const sentinel = join(root, "sentinel.json");
      const claim = await acquireTestPortBlock({ offsets: [0, 1] });
      const port = claim.port;
      const marked = sentinelAt(root, sentinel);
      const argument = form === "number" ? String(port) : `{port:'${port}',host:'127.0.0.1'}`;
      const candidate = startNodeFixture(
        [
          "--import",
          barrier,
          "--input-type=module",
          "--eval",
          `
          import { createServer } from 'node:net';
          import { once } from 'node:events';
          const other = createServer();
          other.listen(${port + 1}, '127.0.0.1');
          await once(other, 'listening');
          createServer().listen(${argument});
          console.log('returned-past-barrier');
        `,
        ],
        {
          ...process.env,
          HOME: root,
          OPENCLAW_SCHEMA_DOWNGRADE_PORT: String(port),
          OPENCLAW_SCHEMA_DOWNGRADE_SENTINEL: sentinel,
        },
      );
      try {
        const mark = await Promise.race([
          marked,
          candidate.done.then((exit): never => {
            throw new Error(
              `Barrier process exited ${JSON.stringify(exit)}: ${candidate.output()}`,
            );
          }),
        ]);
        expect(mark).toEqual({ pid: candidate.child.pid, port });
        expect(await connect(port + 1)).toBe("connected");
        expect(await connect(port)).toBe("ECONNREFUSED");
      } finally {
        await candidate.stop("SIGKILL");
        await claim.release();
      }
      expect(candidate.output()).not.toContain("returned-past-barrier");
      expect(candidate.child.signalCode).toBe("SIGKILL");
    },
  );
});

// Offline SQLite metadata fixtures exercise the controller's gate, not Gateway boot
// or product seeding. Actual reader success remains the genuine-release E2E's job.
function writeStore(
  file: string,
  role: "global" | "agent",
  version: number,
  floor?: number | null,
  content?: number,
) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      DROP TABLE IF EXISTS schema_meta;
      DROP TABLE IF EXISTS config_machine_state;
      PRAGMA user_version = ${version};
      CREATE TABLE schema_meta (
        meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT
        ${floor === undefined ? "" : ", min_reader INTEGER"}
      );
      CREATE TABLE config_machine_state (
        state_key TEXT PRIMARY KEY, value_json TEXT
        ${floor === undefined ? "" : ", min_reader INTEGER"}
      );
      CREATE TABLE IF NOT EXISTS sentinel (value TEXT); INSERT INTO sentinel VALUES ('v${version}');
    `);
    db.prepare(
      `INSERT INTO schema_meta VALUES (?, ?, ?, ?${floor === undefined ? "" : ", ?"})`,
    ).run(
      "primary",
      role,
      version,
      role === "agent" ? "ops" : null,
      ...(floor === undefined ? [] : [floor]),
    );
    if (role === "global") {
      db.prepare(
        `INSERT INTO config_machine_state VALUES (?, ?${floor === undefined ? "" : ", ?"})`,
      ).run(
        "state.schema.contentVersion",
        String(content ?? version),
        ...(floor === undefined ? [] : [floor]),
      );
    }
  } finally {
    db.close();
  }
}

function observations(agentVersion = 7, sharedRole: "global" | "agent" = "global") {
  const root = tempDirs.make("schema-downgrade-facts-");
  const state = join(root, "state");
  const shared = join(state, "state", "openclaw.sqlite");
  const agent = join(state, "agents", "ops", "agent", "openclaw-agent.sqlite");
  const lazy = join(state, "agents", "lazy", "agent", "openclaw-agent.sqlite");
  writeStore(shared, "global", 4, 3);
  writeStore(agent, "agent", 6, null);
  writeStore(lazy, "agent", 6);
  // Native snapshots with a live-store basename are not additional owners.
  writeStore(join(state, "snapshots", "old", "openclaw.sqlite"), "global", 1);
  const baseline = join(root, "baseline");
  const before = snapshotFixtureStores(state, baseline);
  expect(before).toHaveLength(3);
  writeStore(shared, sharedRole, 5, 3);
  writeStore(agent, "agent", agentVersion, null);
  const after = inspectFixtureStores(state, join(root, "post-candidate"));
  return { root, state, shared, agent, baseline, before, after };
}

describe("schema downgrade controller classification", () => {
  it("reads legacy deferred content and nullable reader floors without inventing declarations", () => {
    const root = tempDirs.make("schema-store-facts-");
    const shared = join(root, "shared.sqlite");
    const agent = join(root, "agent.sqlite");
    writeStore(shared, "global", 40, undefined, 41);
    writeStore(agent, "agent", 42, null);
    expect(readSqliteStoreFacts(shared)).toMatchObject({
      role: "shared",
      version: 41,
      headerVersion: 40,
      minReader: 41,
      hasMinReader: false,
    });
    expect(readSqliteStoreFacts(agent)).toMatchObject({
      role: "agent",
      version: 42,
      minReader: 42,
      hasMinReader: false,
    });
  });

  it("does not claim a reader pass from valid candidate metadata alone", () => {
    const facts = observations();
    const receipt = classifySchemaDowngrade({
      ...facts,
      schemaVersions: targets,
      readerFloorSupported: true,
    });
    expect(receipt.structuralFailures).toEqual([]);
    expect(receipt.compatibilityFailures).toEqual([]);
    expect(receipt.gate).toMatchObject({ enforced: true, passed: false, result: "pending" });
  });

  it("rejects invalid floor metadata and an unraised store changed after observation", () => {
    const root = tempDirs.make("schema-store-invalid-");
    const state = join(root, "state");
    const file = join(state, "state", "openclaw.sqlite");
    writeStore(file, "global", 42, 43);
    expect(() => readSqliteStoreFacts(file)).toThrow("Invalid min_reader");
    const db = new DatabaseSync(file);
    db.exec("UPDATE config_machine_state SET min_reader=42;");
    db.close();
    const baseline = join(root, "baseline");
    const before = snapshotFixtureStores(state, baseline);
    const after = inspectFixtureStores(state, join(root, "after"));
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("changed")]));
    expect(() => restoreRaisedFloorStores(state, baseline, before, after)).toThrow(
      "Unraised store changed",
    );
  });

  it.each([true, false])(
    "classifies a T refusal after mixed-store projection using source capability, not nullable floor presence (%s)",
    (readerFloorSupported) => {
      const facts = observations();
      const kept = readFileSync(facts.shared);
      const projection = restoreRaisedFloorStores(
        facts.state,
        facts.baseline,
        facts.before,
        facts.after,
      );
      expect(readFileSync(facts.shared)).toEqual(kept);
      expect(readSqliteStoreFacts(facts.agent).version).toBe(6);
      using restored = new DatabaseSync(facts.agent, { readOnly: true });
      expect(
        restored
          .prepare("SELECT value FROM sentinel")
          .all()
          .map((row) => row.value),
      ).toEqual(["v6"]);
      const refusal = {
        status: "failed",
        failureKind: "compatibility",
        failure: { message: "T refused the projected rollback store", command: undefined },
      };
      const receipt = classifySchemaDowngrade({
        ...facts,
        schemaVersions: targets,
        readerFloorSupported,
        projection,
        smoke: refusal,
      });
      expect(receipt.structuralFailures).toEqual([]);
      expect(receipt.stores).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "shared",
            status: "advanced",
            beforeFloor: 3,
            afterFloor: 3,
            raised: false,
          }),
          expect.objectContaining({
            role: "agent",
            status: "advanced",
            beforeFloor: 6,
            afterFloor: 7,
            beforeHasMinReader: false,
            afterHasMinReader: false,
            raised: true,
          }),
          expect.objectContaining({
            role: "agent",
            status: "untouched",
            beforeVersion: 6,
            afterVersion: 6,
          }),
        ]),
      );
      expect(receipt.compatibilityFailures).toHaveLength(1);
      expect(receipt.gate).toMatchObject({
        enforced: readerFloorSupported,
        passed: !readerFloorSupported,
        result: readerFloorSupported ? "failed" : "report-only",
      });
      expect(projection.unrestoredRaised).toEqual([]);
    },
  );

  it.each([
    {
      agentVersion: 8,
      sharedRole: "global" as const,
      message: "Advanced store did not reach candidate target 7",
    },
    { agentVersion: 7, sharedRole: "agent" as const, message: "Candidate changed the store owner" },
  ])(
    "fails candidate metadata violations even without ReaderFloor support ($message)",
    ({ agentVersion, sharedRole, message }) => {
      const facts = observations(agentVersion, sharedRole);
      const receipt = classifySchemaDowngrade({ ...facts, schemaVersions: targets });
      expect(receipt.structuralFailures).toContainEqual(expect.objectContaining({ message }));
      expect(receipt.gate).toMatchObject({ enforced: false, passed: false, result: "failed" });
    },
  );

  it("preserves a setup-failure receipt before throwing instead of downgrading it to report-only", async () => {
    const root = tempDirs.make("schema-downgrade-setup-");
    const previousRoot = join(root, "previous");
    const candidateRoot = join(root, "candidate");
    const artifacts = join(root, "artifacts");
    mkdirSync(previousRoot);
    mkdirSync(candidateRoot);
    await expect(
      runSchemaDowngrade({
        previousRoot,
        candidateRoot,
        previousBuild: {},
        candidateBuild: {},
        root: join(root, "run"),
        artifacts,
        env: process.env,
      }),
    ).rejects.toThrow();
    const receipt = JSON.parse(readFileSync(join(artifacts, "schema-downgrade.json"), "utf8"));
    expect(receipt).toMatchObject({
      result: "setup-failed",
      gate: { enforced: false, passed: false, result: "setup-failed" },
    });
    expect(receipt.error).toContain("build-info.json");
    expect(existsSync(join(artifacts, "schema-downgrade.log"))).toBe(true);
  });
});

describe("downgrade diff selection", () => {
  const manifest = { openclaw: { schemaVersions: { state: 41, agent: 42 } } };
  it("selects a schema version or production migration, not test or unrelated state work", () => {
    expect(
      needsSchemaDowngrade(
        manifest,
        { openclaw: { schemaVersions: { state: 42, agent: 42 } } },
        [],
      ),
    ).toBe(true);
    expect(
      needsSchemaDowngrade(manifest, manifest, ["src/state/openclaw-agent-db-schema.ts"]),
    ).toBe(true);
    expect(
      needsSchemaDowngrade(manifest, manifest, ["src/state/openclaw-state-db-layout-migration.ts"]),
    ).toBe(true);
    expect(
      needsSchemaDowngrade(manifest, manifest, [
        "src/state/openclaw-state-db-layout-migration.test.ts",
        "src/state/agent-deletion.ts",
        "package.json",
      ]),
    ).toBe(false);
  });
});
