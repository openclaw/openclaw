import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  registerSealedRuntimeProcessEntrypoint,
  resolveRuntimeProcessEntrypointUrl,
} from "./runtime-process-url.js";
import {
  captureLegacyStateSnapshotIdentity,
  readLegacyStateMigrationPlanConfig,
} from "./state-migrations.plan.js";
import { createMigrationFixture } from "./state-migrations.shard-fixture.test-support.js";
import { captureLegacyStateSnapshotIdentityInProcess } from "./state-migrations.snapshot.worker.js";
import type { LegacyStateMigrationPlan } from "./state-migrations.types.js";

const tempDirs = createTrackedTempDirs();
const digest = expect.stringMatching(/^sha256:[0-9a-f]{64}$/u);
const changedConfig = '{"agents":{"defaults":{"workspace":"./changed"}}}\n';

function expectWarning(warnings: string[], message: string) {
  expect(warnings).toEqual([expect.stringContaining(message)]);
}

function expectBoundPlan(plan: LegacyStateMigrationPlan) {
  expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
  expect(plan.snapshot.stateDigest).toEqual(digest);
}

let fixture: ReturnType<typeof createMigrationFixture>;
beforeEach(async () => {
  fixture = createMigrationFixture(await tempDirs.make("openclaw-migration-snapshot-identity-"));
});

afterEach(async () => {
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration snapshot identity", () => {
  it("captures accepted config include identities larger than OS argument limits", async () => {
    const includeDir = path.join(fixture.root, "a".repeat(180), "b".repeat(180), "c".repeat(180));
    fs.mkdirSync(includeDir, { recursive: true });
    const paths = Array.from({ length: 2300 }, (_, index) => {
      const pathname = path.join(includeDir, `${index}.json`);
      fs.writeFileSync(pathname, "{}\n");
      return pathname;
    });
    fs.writeFileSync(
      fixture.configPath,
      JSON.stringify({ $include: paths.map((pathname) => path.relative(fixture.root, pathname)) }),
    );
    const config = await readLegacyStateMigrationPlanConfig(fixture);
    expect(config.warnings).toEqual([]);
    expect(config.configInputHashes?.includes).toHaveLength(paths.length);
    const params = {
      configPath: fixture.configPath,
      stateDir: fixture.stateDir,
      configInputHashes: config.configInputHashes,
    };
    expect(Buffer.byteLength(JSON.stringify(params))).toBeGreaterThan(1024 * 1024);

    const identity = await captureLegacyStateSnapshotIdentity(params);

    expect(identity).toMatchObject({
      warnings: [],
      configDigest: config.rootDigest,
      stateDigest: digest,
    });
    fs.writeFileSync(path.join(includeDir, "0.json"), changedConfig);
    const changed = await captureLegacyStateSnapshotIdentity(params);
    expect(changed.configDigest).toBeUndefined();
    expectWarning(changed.warnings, "Snapshot config input changed while planning:");
  });

  it("refuses unavailable snapshot workers without falling back to caller-process hashing", async () => {
    const original = resolveRuntimeProcessEntrypointUrl("stateMigrationSnapshot");
    registerSealedRuntimeProcessEntrypoint(
      "stateMigrationSnapshot",
      pathToFileURL(path.join(fixture.root, "missing-worker.js")),
    );
    try {
      const refused = await fixture.plan();
      expect(refused.refusal?.code).toBe("snapshot-identity-unavailable");
      expect(refused.snapshot.stateDigest).toBeUndefined();
      expect(refused.steps).toEqual([]);
      expectWarning(refused.warnings, "Could not bind copied snapshot:");
    } finally {
      registerSealedRuntimeProcessEntrypoint("stateMigrationSnapshot", original);
    }
    expectBoundPlan(await fixture.plan());
  });

  it("refuses an ordinary file replaced between tree inspection and open", async () => {
    const probePath = path.join(fixture.stateDir, "identity-probe.json");
    const originalPath = `${probePath}.original`;
    fs.writeFileSync(probePath, '{"value":"original"}\n');
    const realOpen = fs.promises.open.bind(fs.promises);
    let replacementTriggered = false;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (!replacementTriggered && path.resolve(String(args[0])) === probePath) {
        replacementTriggered = true;
        fs.renameSync(probePath, originalPath);
        fs.writeFileSync(probePath, '{"value":"replacement"}\n');
      }
      return realOpen(...args);
    });

    const identity = await captureLegacyStateSnapshotIdentityInProcess(fixture);
    expect(replacementTriggered).toBe(true);
    expect(identity.stateDigest).toBeUndefined();
    expectWarning(identity.warnings, `Snapshot file changed while opening: ${probePath}`);
  });

  it.each([
    ["DELETE", "held.sqlite"],
    ["WAL", "held.sqlite"],
    ["DELETE", "state/openclaw.sqlite"],
    ["WAL", "state/openclaw.sqlite"],
  ])(
    "preserves a caller-held %s read transaction on %s through the complete planner",
    async (journalMode, relativePath) => {
      const databasePath = path.join(fixture.stateDir, relativePath);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      const compete = () => {
        const child = spawnSync(
          process.execPath,
          [
            "-e",
            `const { DatabaseSync } = require('node:sqlite');
             const database = new DatabaseSync(process.argv[1]);
             try {
               database.exec('PRAGMA busy_timeout=0;');
               if (process.argv[2] === 'WAL') {
                 console.log(JSON.stringify({ blocked: database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy === 1 }));
               } else {
                 database.exec('BEGIN EXCLUSIVE; ROLLBACK;');
                 console.log(JSON.stringify({ blocked: false }));
               }
             } catch (error) {
               if (error.errcode !== 5) throw error;
               console.log(JSON.stringify({ blocked: true }));
             } finally { database.close(); }`,
            databasePath,
            journalMode,
          ],
          { encoding: "utf8" },
        );
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(child.stdout);
      };
      try {
        database.exec(
          `PRAGMA journal_mode=${journalMode}; PRAGMA wal_autocheckpoint=0;
           CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original'); BEGIN;`,
        );
        expect(database.prepare("SELECT value FROM held").all()).toEqual([{ value: "original" }]);
        if (journalMode === "WAL") {
          using writer = new DatabaseSync(databasePath);
          writer.exec("INSERT INTO held VALUES ('later');");
        }
        expect(compete()).toEqual({ blocked: true });

        const plan = await fixture.plan();

        expectBoundPlan(plan);
        expect(compete()).toEqual({ blocked: true });
        expect(database.prepare("SELECT value FROM held").all()).toEqual([{ value: "original" }]);
      } finally {
        database.close();
      }
      expect(compete()).toEqual({ blocked: false });
    },
  );

  it("binds in-snapshot hard-link topology", async () => {
    const firstPath = path.join(fixture.stateDir, "first.json");
    const secondPath = path.join(fixture.stateDir, "second.json");
    fs.writeFileSync(firstPath, '{"value":"same"}\n');
    fs.writeFileSync(secondPath, '{"value":"same"}\n');
    const independent = await fixture.plan();

    fs.unlinkSync(secondPath);
    fs.linkSync(firstPath, secondPath);
    const linked = await fixture.plan();

    expect(independent.snapshot.stateDigest).toEqual(digest);
    expect(linked.snapshot.stateDigest).toEqual(digest);
    expect(linked.snapshot.stateDigest).not.toBe(independent.snapshot.stateDigest);
  });

  it("refuses a snapshot file with an unbound external hard link", async () => {
    const externalPath = path.join(fixture.root, "external.json");
    const linkedPath = path.join(fixture.stateDir, "linked.json");
    fs.writeFileSync(externalPath, '{"value":"shared"}\n');
    fs.linkSync(externalPath, linkedPath);

    const plan = await fixture.plan();

    expect(plan.snapshot.stateDigest).toBeUndefined();
    expectWarning(plan.warnings, `Snapshot file has links outside copied state: ${linkedPath}`);
  });
});
