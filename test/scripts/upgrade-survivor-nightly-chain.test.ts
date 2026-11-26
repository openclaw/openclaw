import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { RootCopyPublicationReceipt } from "@openclaw/fs-safe/root";
import { afterEach, expect, it, vi } from "vitest";
import { readSqliteStoreFacts } from "../../scripts/e2e/lib/upgrade-survivor/schema-store-facts.mjs";
import {
  assertMigrationVolume,
  classifyMigrationTiming,
  MIN_MIGRATION_BYTES,
  readMigrationFileFacts,
  readMigrationFilesystem,
  readMigrationRows,
  readOccupiedSqliteBytes,
} from "../../scripts/e2e/lib/upgrade-survivor/sqlite-migration-facts.mjs";
import { seedBaselineMigrationFixture } from "../../scripts/e2e/lib/upgrade-survivor/sqlite-migration-seed.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("counts occupied SQLite pages, not deleted pages, file padding, or WAL bytes", () => {
  const file = path.join(tempDirs.make("nightly-occupied-"), "store.sqlite");
  {
    using db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE content (payload BLOB); INSERT INTO content VALUES (zeroblob(1048576)); DELETE FROM content;",
    );
  }
  const before = readMigrationFileFacts(file);
  expect(before.freePages).toBeGreaterThan(0);
  expect(readOccupiedSqliteBytes(file)).toBe(before.occupiedBytes);
  fs.truncateSync(file, before.fileBytes + 1024 * 1024);
  expect(readOccupiedSqliteBytes(file)).toBe(before.occupiedBytes);
  expect(() => assertMigrationVolume(readMigrationFileFacts(file))).toThrow("10 GiB");
  const occupied = {
    occupiedBytes: MIN_MIGRATION_BYTES,
    walBytes: 0,
    fileBytes: MIN_MIGRATION_BYTES,
    allocatedBytes: MIN_MIGRATION_BYTES,
  };
  expect(() => assertMigrationVolume({ ...occupied, walBytes: 4096 })).toThrow("empty WAL");
  expect(() => assertMigrationVolume({ ...occupied, allocatedBytes: 4096 })).toThrow(
    "physically allocated",
  );
});

it.each([
  { total: 610_000, start: 5000, end: 605_000, passed: true },
  { total: 610_001, start: 5000, end: 605_000, passed: false },
  { total: 610_001, start: 5000, end: 605_001, passed: false },
])(
  "keeps separate fixed schema and copy budgets ($total, $end)",
  ({ total, start, end, passed }) => {
    expect(classifyMigrationTiming(total, [{ startedMs: start, endedMs: end }]).passed).toBe(
      passed,
    );
  },
);

it("rejects overlapping or out-of-owner copy intervals instead of hiding schema work", () => {
  expect(() =>
    classifyMigrationTiming(10, [
      { startedMs: 0, endedMs: 6 },
      { startedMs: 5, endedMs: 7 },
    ]),
  ).toThrow("Overlapping");
  expect(() => classifyMigrationTiming(10, [{ startedMs: 0, endedMs: 11 }])).toThrow(
    "Invalid copy",
  );
});

const fixturePreflightRoot = process.env.OPENCLAW_NIGHTLY_FIXTURE_PREFLIGHT_ROOT;
it.runIf(Boolean(fixturePreflightRoot))(
  "seeds the native baseline plugin when its controller is loaded by Vitest",
  async () => {
    const baselineRoot = process.env.OPENCLAW_NIGHTLY_BASELINE_ROOT;
    const artifacts = process.env.OPENCLAW_NIGHTLY_ARTIFACT_ROOT;
    assert(fixturePreflightRoot && baselineRoot && artifacts);
    const minimumBytes = 64 * 1024 ** 2;
    const fixture = await seedBaselineMigrationFixture({
      baselineRoot,
      root: fixturePreflightRoot,
      artifacts,
      minimumBytes,
    });
    const facts = readMigrationFileFacts(fixture.agentPath);
    expect(facts.occupiedBytes).toBeGreaterThanOrEqual(minimumBytes);
    expect(facts.walBytes).toBe(0);
    readMigrationRows(fixture, fixture.witnesses);
  },
  600_000,
);

type CopyObservation = {
  source: string;
  target: string;
  bytes: number;
  startedMs: number;
  endedMs: number;
  mode: "not observed";
  publication?: RootCopyPublicationReceipt;
};

const sourceRoot = process.env.OPENCLAW_NIGHTLY_SOURCE_ROOT;
// Resource-gated by the existing update-migration cell, never a ten-GiB PR unit fixture.
it.runIf(Boolean(sourceRoot))(
  "migrates the published support-floor corpus through the complete startup owner",
  async () => {
    const baselineRoot = process.env.OPENCLAW_NIGHTLY_BASELINE_ROOT;
    const candidateTarball = process.env.OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC;
    const root = process.env.OPENCLAW_NIGHTLY_RUNTIME_ROOT;
    const artifacts = process.env.OPENCLAW_NIGHTLY_ARTIFACT_ROOT;
    const sourceSha = process.env.OPENCLAW_NIGHTLY_SOURCE_SHA;
    assert(sourceRoot && baselineRoot && candidateTarball && root && artifacts && sourceSha);
    assert.equal(process.platform, "linux");
    assert(
      fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"),
      "Requires an isolated container",
    );
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(artifacts, { recursive: true });
    const filesystem = readMigrationFilesystem(root);
    assert(
      filesystem.availableBytes >= 40 * 1024 ** 3,
      "Nightly SQLite fixture needs 40 GiB free on its data volume",
    );
    const candidatePrefix = path.join(root, "candidate");
    const install = spawnSync(
      "bash",
      [
        path.join(sourceRoot, "scripts/e2e/lib/prepublish-plugin-registry.sh"),
        "npm",
        "install",
        "--global",
        "--prefix",
        candidatePrefix,
        candidateTarball,
        "--no-audit",
        "--no-fund",
      ],
      { env: process.env, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 ** 2 },
    );
    fs.writeFileSync(
      path.join(artifacts, "sqlite-migration-candidate-install.log"),
      `${install.stdout ?? ""}${install.stderr ?? ""}`,
    );
    assert.ifError(install.error);
    assert.equal(install.status, 0, "Candidate package installation failed");
    const candidateRoot = path.join(candidatePrefix, "lib", "node_modules", "openclaw");
    const candidateBuild = JSON.parse(
      fs.readFileSync(path.join(candidateRoot, "dist/build-info.json"), "utf8"),
    );
    const candidateManifest = JSON.parse(
      fs.readFileSync(path.join(candidateRoot, "package.json"), "utf8"),
    );
    const sourceManifest = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"),
    );
    assert.equal(
      candidateBuild.commit,
      sourceSha,
      "Candidate package is not the selected source SHA",
    );
    assert.equal(candidateManifest.version, sourceManifest.version);
    assert.deepEqual(
      candidateManifest.openclaw.schemaVersions,
      sourceManifest.openclaw.schemaVersions,
    );
    const fixture = await seedBaselineMigrationFixture({
      baselineRoot,
      root: path.join(root, "fixture"),
      artifacts,
    });
    const context = {
      ...fixture,
      baselineRoot,
      candidateRoot,
      candidateBuild,
      candidateManifest,
      sourceSha,
      artifacts,
      filesystem,
      runner: {
        backend: process.env.OPENCLAW_NIGHTLY_RUNNER_BACKEND ?? "not supplied",
        availableParallelism: availableParallelism(),
        totalMemoryBytes: totalmem(),
        availableMemoryBytes: process.availableMemory(),
      },
    };
    const trialFile = path.join(context.stateDir, "git-install", "releases", ".trial");
    const restoreFile = path.join(path.dirname(context.candidateRoot), ".restore");
    const receipt: Record<string, unknown> = {
      scope: "published-writer-startup-owner-not-boot-to-ready",
      sourceSha: context.sourceSha,
      baseline: context.baselineManifest,
      candidate: context.candidateBuild,
      filesystem: context.filesystem,
      runner: context.runner,
      status: "fixture-failed",
    };
    const save = () =>
      fs.writeFileSync(
        path.join(context.artifacts, "sqlite-migration.json"),
        `${JSON.stringify(receipt, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
      );
    try {
      const before = readMigrationFileFacts(context.agentPath);
      assertMigrationVolume(before);
      assert.equal(before.schemaVersion, context.baselineManifest.openclaw.schemaVersions.agent);
      assert.equal(
        readMigrationFileFacts(context.statePath).schemaVersion,
        context.baselineManifest.openclaw.schemaVersions.state,
      );
      const rows = readMigrationRows(context, context.witnesses);
      receipt.before = before;
      receipt.rowsBefore = rows;
      save();
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("OPENCLAW_")) {
          vi.stubEnv(key, undefined);
        }
      }
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VITEST", undefined);
      for (const [key, value] of Object.entries(context.env)) {
        vi.stubEnv(key, value);
      }
      const { TRIAL_BUDGET_MS } = await import("../../src/update/launcher.js");
      receipt.compiledTrialBudgetMs = TRIAL_BUDGET_MS;
      const { createTrialPending, readTrial, resolvePrefix, writeTrial } =
        await import("../../src/update/store.js");
      const prefix = resolvePrefix(context.env);
      const trial = await createTrialPending(
        {
          runId: randomUUID(),
          target: path.relative(prefix, context.candidateRoot),
          previous: context.baselineRoot,
          version: context.candidateBuild.version,
          buildId: context.candidateBuild.buildId,
          acceptCapabilities: false,
        },
        prefix,
      );
      // Use the production writers and a real installed candidate, not a made-up release tree.
      await writeTrial({ ...trial, phase: "trial", createdAt: Date.now(), attempts: 1 }, prefix);
      const copyModule = await import("../../src/infra/sqlite-file-copy.js");
      const original = copyModule.copySqliteFile;
      const copies: CopyObservation[] = [];
      let started = Number.NaN;
      let elapsedMs = Number.NaN;
      const spy = vi.spyOn(copyModule, "copySqliteFile").mockImplementation(async (...args) => {
        const call: CopyObservation = {
          source: args[0],
          target: args[1],
          bytes: Number(args[2].size),
          startedMs: performance.now() - started,
          endedMs: Number.NaN,
          mode: "not observed",
        };
        try {
          const publication = await original(...args);
          call.publication = publication;
          return publication;
        } finally {
          call.endedMs = performance.now() - started;
          copies.push(call);
        }
      });
      const { upgradeStateOnGatewayStart } =
        await import("../../src/state/state-upgrade-startup.js");
      started = performance.now();
      try {
        await upgradeStateOnGatewayStart(context.env, ({ configExists, mode }) => {
          assert(
            configExists && mode === "local",
            "Fixture Gateway admission is not local/configured",
          );
          return true;
        });
      } catch (error) {
        receipt.status = "owner-failed";
        throw error;
      } finally {
        elapsedMs = performance.now() - started;
        receipt.elapsedMs = elapsedMs;
        receipt.copies = copies;
        spy.mockRestore();
      }
      receipt.status = "owner-returned";
      receipt.trial = await readTrial(prefix);
      const manifest = JSON.parse(fs.readFileSync(restoreFile, "utf8"));
      assert.equal(manifest.v, 1);
      assert.equal(
        manifest.runId,
        trial.runId,
        "Startup did not publish this real trial's restore manifest",
      );
      receipt.restoreManifest = manifest;
      const images: { live: string; preimage: string }[] = manifest.files.filter(
        (file: { preimage: string | null }) => file.preimage !== null,
      );
      const preimageCopies = copies.filter((copy) =>
        images.some((image) => {
          const identity = fs.statSync(image.preimage, { bigint: true });
          return (
            copy.source === image.live &&
            copy.publication?.dev === identity.dev &&
            copy.publication.ino === identity.ino
          );
        }),
      );
      assert.equal(
        preimageCopies.length,
        images.length,
        "Copy observation did not cover the real pre-images",
      );
      const agentSchema = readSqliteStoreFacts(context.agentPath);
      const stateSchema = readSqliteStoreFacts(context.statePath);
      receipt.schemas = [agentSchema, stateSchema];
      assert.equal(agentSchema.version, context.candidateManifest.openclaw.schemaVersions.agent);
      assert.equal(stateSchema.version, context.candidateManifest.openclaw.schemaVersions.state);
      const after = readMigrationRows(context, context.witnesses);
      assert.deepEqual(after, rows, "Migration changed selected row counts or canonical content");
      receipt.rowsAfter = after;
      const timing = classifyMigrationTiming(elapsedMs, preimageCopies);
      receipt.timing = timing;
      receipt.status = timing.passed ? "passed" : "budget-failed";
      save();
      assert(
        timing.passed,
        `Migration budget exceeded: schema=${timing.schemaMs}ms/10000ms, copies=${timing.copyMs}ms/600000ms; see sqlite-migration.json`,
      );
    } catch (error) {
      if (receipt.status === "owner-returned") {
        receipt.status = "verification-failed";
      }
      for (const [field, file] of [
        ["trial", trialFile],
        ["restoreManifest", restoreFile],
      ] as const) {
        if (fs.existsSync(file)) {
          try {
            receipt[field] = JSON.parse(fs.readFileSync(file, "utf8"));
          } catch (evidenceError) {
            receipt[`${field}ReadError`] = String(evidenceError);
          }
        }
      }
      receipt.error = error instanceof Error ? error.stack : String(error);
      save();
      throw error;
    } finally {
      vi.restoreAllMocks();
    }
  },
  45 * 60_000,
);
