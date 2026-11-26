import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  it.each([
    { form: "number", release: "candidate", parked: true },
    { form: "string-options", release: "candidate", parked: true },
    { form: "number", release: "previous", parked: false },
  ])(
    "scopes the exact TCP barrier to its target root ($release, $form)",
    async ({ form, release, parked }) => {
      const root = tempDirs.make("schema-barrier-");
      const sentinel = join(root, "sentinel.json");
      const listening = join(root, "listening.json");
      const target = join(root, "candidate");
      const previous = join(root, "previous");
      const slot = join(root, "slot");
      mkdirSync(target);
      mkdirSync(previous);
      symlinkSync(join(root, release), slot);
      const claim = await acquireTestPortBlock({ offsets: [0, 1] });
      const port = claim.port;
      const marked = sentinelAt(root, parked ? sentinel : listening);
      const argument = form === "number" ? String(port) : `{port:'${port}',host:'127.0.0.1'}`;
      const source = `
        import { createServer } from 'node:net';
        import { once } from 'node:events';
        import fs from 'node:fs';
        const other = createServer();
        other.listen(${port + 1}, '127.0.0.1');
        await once(other, 'listening');
        const exact = createServer();
        exact.listen(${argument});
        await once(exact, 'listening');
        fs.writeFileSync(${JSON.stringify(listening)}, JSON.stringify({pid:process.pid,port:${port}}));
      `;
      writeFileSync(join(target, "gateway.mjs"), source);
      writeFileSync(join(previous, "gateway.mjs"), source);
      const candidate = startNodeFixture(["--import", barrier, join(slot, "gateway.mjs")], {
        ...process.env,
        HOME: root,
        OPENCLAW_SCHEMA_DOWNGRADE_PORT: String(port),
        OPENCLAW_SCHEMA_DOWNGRADE_SENTINEL: sentinel,
        OPENCLAW_SCHEMA_DOWNGRADE_TARGET: target,
      });
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
        expect(await connect(port)).toBe(parked ? "ECONNREFUSED" : "connected");
        expect(existsSync(sentinel)).toBe(parked);
        expect(existsSync(listening)).toBe(!parked);
      } finally {
        await candidate.stop("SIGKILL");
        await claim.release();
      }
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
  const before = inspectFixtureStores(state, join(root, "before-candidate"));
  expect(before).toHaveLength(3);
  writeStore(shared, sharedRole, 5, 3);
  writeStore(agent, "agent", agentVersion, null);
  const after = inspectFixtureStores(state, join(root, "post-candidate"));
  const rollbackState = join(root, "rolled-back");
  writeStore(join(rollbackState, "state", "openclaw.sqlite"), "global", 5, 3);
  writeStore(
    join(rollbackState, "agents", "ops", "agent", "openclaw-agent.sqlite"),
    "agent",
    6,
    null,
  );
  writeStore(join(rollbackState, "agents", "lazy", "agent", "openclaw-agent.sqlite"), "agent", 6);
  const rolledBack = inspectFixtureStores(rollbackState, join(root, "after-rollback"));
  return { before, after, rolledBack };
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

  it.each(["neither", "rollback", "smoke"])(
    "keeps the gate pending until rollback facts and reader smoke both arrive (%s)",
    (available) => {
      const { before, after, rolledBack } = observations();
      const receipt = classifySchemaDowngrade({
        before,
        after,
        schemaVersions: targets,
        rolledBack: available === "rollback" ? rolledBack : undefined,
        smoke: available === "smoke" ? { status: "passed" } : null,
      });
      expect(receipt.structuralFailures).toEqual([]);
      expect(receipt.compatibilityFailures).toEqual([]);
      expect(receipt.gate).toMatchObject({ enforced: true, passed: false, result: "pending" });
    },
  );

  it("rejects invalid committed floor metadata", () => {
    const root = tempDirs.make("schema-store-invalid-");
    const file = join(root, "store.sqlite");
    writeStore(file, "global", 42, 43);
    expect(() => readSqliteStoreFacts(file)).toThrow("Invalid min_reader");
  });

  it("passes mixed-store rollback facts without requiring an explicit floor declaration", () => {
    const receipt = classifySchemaDowngrade({
      ...observations(),
      schemaVersions: targets,
      smoke: { status: "passed" },
    });
    expect(receipt.structuralFailures).toEqual([]);
    expect(receipt.compatibilityFailures).toEqual([]);
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
    expect(receipt.gate).toMatchObject({ enforced: true, passed: true, result: "passed" });
  });

  it.each([
    { store: "ops", field: "version", value: 7 },
    { store: "ops", field: "minReader", value: 5 },
    { store: "ops", field: "role", value: "shared" },
    { store: "state", field: "version", value: 4 },
    { store: "state", field: "minReader", value: 4 },
    { store: "state", field: "role", value: "agent" },
    { store: "state", field: "integrity", value: "corrupt" },
  ])("rejects wrong final $store $field facts", ({ store, field, value }) => {
    const facts = observations();
    const relativePath =
      store === "ops"
        ? join("agents", "ops", "agent", "openclaw-agent.sqlite")
        : join("state", "openclaw.sqlite");
    const rolledBack = facts.rolledBack.map((fact) =>
      fact.relativePath === relativePath ? { ...fact, [field]: value } : fact,
    );
    const receipt = classifySchemaDowngrade({
      ...facts,
      rolledBack,
      schemaVersions: targets,
      smoke: { status: "passed" },
    });
    expect(receipt.structuralFailures).toContainEqual(expect.objectContaining({ relativePath }));
    expect(receipt.gate).toMatchObject({ enforced: true, passed: false, result: "failed" });
  });

  it.each(["retained", "removed"])(
    "allows a candidate-created store to be %s without a T preimage",
    (disposition) => {
      const facts = observations();
      const root = tempDirs.make("schema-candidate-created-");
      const state = join(root, "state");
      writeStore(join(state, "agents", "new", "agent", "openclaw-agent.sqlite"), "agent", 7);
      const created = inspectFixtureStores(state, join(root, "inspection"));
      const receipt = classifySchemaDowngrade({
        ...facts,
        after: [...facts.after, ...created],
        rolledBack: [...facts.rolledBack, ...(disposition === "retained" ? created : [])],
        schemaVersions: targets,
        smoke: { status: "passed" },
      });
      expect(receipt.structuralFailures).toEqual([]);
      expect(receipt.compatibilityFailures).toEqual([]);
      expect(receipt.gate).toMatchObject({ enforced: true, passed: true, result: "passed" });
    },
  );

  it.each([
    { failureKind: "compatibility", category: "compatibilityFailures" },
    { failureKind: "setup", category: "structuralFailures" },
    { failureKind: undefined, category: "compatibilityFailures" },
  ] as const)(
    "fails previous-reader smoke while preserving its classification ($failureKind)",
    ({ failureKind, category }) => {
      const receipt = classifySchemaDowngrade({
        ...observations(),
        schemaVersions: targets,
        smoke: {
          status: "failed",
          failureKind,
          failure: { message: "Previous reader did not pass", command: undefined },
        },
      });
      expect(receipt[category]).toContainEqual(
        expect.objectContaining({ message: "Previous reader did not pass" }),
      );
      expect(receipt.gate).toMatchObject({ enforced: true, passed: false, result: "failed" });
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
    "fails candidate committed metadata violations ($message)",
    ({ agentVersion, sharedRole, message }) => {
      const facts = observations(agentVersion, sharedRole);
      const receipt = classifySchemaDowngrade({ ...facts, schemaVersions: targets });
      expect(receipt.structuralFailures).toContainEqual(expect.objectContaining({ message }));
      expect(receipt.gate).toMatchObject({ enforced: true, passed: false, result: "failed" });
    },
  );

  it("preserves a setup-failure receipt before throwing", async () => {
    const root = tempDirs.make("schema-downgrade-setup-");
    const previousRoot = join(root, "previous");
    const artifacts = join(root, "artifacts");
    mkdirSync(previousRoot);
    await expect(
      runSchemaDowngrade({
        previousRoot,
        candidateTarball: join(root, "candidate.tgz"),
        previousPrefix: join(root, "previous-install"),
        previousBuild: {},
        candidateBuild: {},
        npmCache: join(root, "npm-cache"),
        root: join(root, "run"),
        artifacts,
        env: process.env,
      }),
    ).rejects.toThrow();
    const receipt = JSON.parse(readFileSync(join(artifacts, "schema-downgrade.json"), "utf8"));
    expect(receipt).toMatchObject({
      result: "setup-failed",
      gate: { enforced: true, passed: false, result: "setup-failed" },
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
