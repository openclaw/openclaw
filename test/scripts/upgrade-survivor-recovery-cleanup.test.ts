import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRecoveryApplied,
  assertRecoveryHistory,
  assertRecoveryInventory,
  assertRecoveryOriginals,
  assertRecoverySnapshot,
  recoveryFileIdentity,
  recoveryTreeSnapshot,
  recoveryVolumeSpec,
  recoveryWalIndexPaths,
  seedRecoveryFixture,
  writeRecoveryTranscript,
} from "../../scripts/e2e/lib/upgrade-survivor/recovery-cleanup-fixture.mjs";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { expectStatus, readJson, writeJson } from "./upgrade-survivor-io.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const temporary = () => fs.realpathSync(tempDirs.make("upgrade-recovery-assertions-"));
const readLines = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
function archiveOriginal(source: string, archivePath: string) {
  const identity = recoveryFileIdentity(source);
  fs.renameSync(source, archivePath);
  return {
    original: { source, disposition: "candidate", identity },
    move: {
      sourcePath: source,
      archivePath,
      manifestVersion: 3,
      runId: "run",
      completedAt: "2026-07-01T00:00:00Z",
      artifact: { identity, classification: "imported", disposal: { state: "retained" } },
    },
  };
}

function runRecovery(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return runNodeScript(
    [path.resolve("scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs"), ...args],
    {
      HOME: root,
      TMPDIR: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: path.join(root, "artifacts"),
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
      ...env,
    },
    10_000,
  );
}

describe.skipIf(process.platform === "win32")("recovery survivor package provenance", () => {
  type PackageFault =
    | "metadata-version"
    | "pack-version"
    | "integrity-mismatch"
    | "missing-metadata-integrity";

  async function packageEvidence({
    requested = "openclaw@2026.7.1-2",
    installedVersion = "2026.7.1-2",
    packShape = "array",
    viewShape = "object",
    fault,
  }: {
    requested?: string;
    installedVersion?: string;
    packShape?: "array" | "name-keyed";
    viewShape?: "object" | "array";
    fault?: PackageFault;
  } = {}) {
    const root = temporary();
    const artifacts = path.join(root, "artifacts");
    const state = path.join(root, "state");
    const runtime = path.join(root, "runtime");
    const bin = path.join(root, "bin");
    for (const directory of [artifacts, state, runtime, bin]) {
      fs.mkdirSync(directory);
    }
    const integrity = `sha512-${createHash("sha512").update(installedVersion).digest("base64")}`;
    const metadata = {
      version: fault === "metadata-version" ? "2026.1.1" : installedVersion,
      dist: {
        tarball: `https://registry.npmjs.org/openclaw/-/openclaw-${installedVersion}.tgz`,
        ...(fault === "missing-metadata-integrity" ? {} : { integrity }),
      },
    };
    const packed = {
      name: "openclaw",
      version: fault === "pack-version" ? "2026.1.1" : installedVersion,
      integrity:
        fault === "integrity-mismatch"
          ? `sha512-${createHash("sha512").update("different bytes").digest("base64")}`
          : integrity,
    };
    const calls = path.join(root, "npm-calls.jsonl");
    fs.writeFileSync(
      path.join(bin, "npm"),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[1] !== ${JSON.stringify(`openclaw@${installedVersion}`)}) {
  throw new Error("package evidence must use the installed exact baseline");
}
const responses = {
  view: ${JSON.stringify(viewShape === "array" ? [metadata] : metadata)},
  pack: ${JSON.stringify(packShape === "array" ? [packed] : { openclaw: packed })},
};
if (!Object.hasOwn(responses, args[0])) throw new Error("unexpected npm command");
console.log(JSON.stringify(responses[args[0]]));
`,
      { mode: 0o755 },
    );
    const candidate = path.join(root, "candidate.tgz");
    const candidateBytes = "candidate package fixture";
    fs.writeFileSync(candidate, candidateBytes);
    const result = await runRecovery(root, ["packages", requested, candidate], {
      PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      TMPDIR: runtime,
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: runtime,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: installedVersion,
    });
    return {
      result,
      metadata,
      calls: readLines(calls),
      evidencePath: path.join(artifacts, "recovery-evidence.json"),
      candidateSha256: createHash("sha256").update(candidateBytes).digest("hex"),
    };
  }

  it.each([
    {
      requested: "openclaw@2026.8.2",
      installedVersion: "2026.8.2",
      packShape: "name-keyed",
      viewShape: "array",
    },
    { requested: "openclaw@latest", installedVersion: "2026.8.2", packShape: "array" },
  ] as const)(
    "verifies $requested against installed $installedVersion ($packShape)",
    async (entry) => {
      const fixture = await packageEvidence(entry);
      expect(fixture.result.error).toBeUndefined();
      expectStatus(fixture.result);
      const exactSpec = `openclaw@${entry.installedVersion}`;
      expect(fixture.calls).toEqual([
        ["view", exactSpec, "version", "dist", "--json"],
        ["pack", exactSpec, "--ignore-scripts", "--dry-run", "--json"],
      ]);
      expect(readJson(fixture.evidencePath)).toMatchObject({
        baseline: fixture.metadata,
        candidate: { sha256: fixture.candidateSha256 },
      });
    },
  );

  it.each<PackageFault>([
    "metadata-version",
    "pack-version",
    "integrity-mismatch",
    "missing-metadata-integrity",
  ])("rejects %s without recording successful package evidence", async (fault) => {
    const fixture = await packageEvidence({ fault });
    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).toBe(1);
    expect(fs.existsSync(fixture.evidencePath)).toBe(false);
  });
});

describe("recovery survivor evidence", () => {
  it.each([false, true])(
    "requires transcript destinations while accepting unused shared-index owners (database missing: %s)",
    async (missingDatabase) => {
      const root = temporary();
      const artifacts = path.join(root, "artifacts");
      const state = path.join(root, "state");
      const sessions = path.join(state, "sessions");
      const archive = path.join(state, "session-sqlite-import-archive");
      const manifests = path.join(state, "session-sqlite-migration-runs");
      for (const directory of [artifacts, sessions, archive, manifests]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      const store = path.join(sessions, "sessions.json");
      const transcript = path.join(sessions, "old.jsonl");
      writeRecoveryTranscript(transcript, "old", 3);
      writeJson(store, { "agent:main:old": { sessionId: "old", sessionFile: transcript } });
      const archived = [transcript, store].map((source) =>
        archiveOriginal(source, path.join(archive, path.basename(source))),
      );
      const originals = archived.map((entry) => entry.original);
      const moves = archived.map(({ move }, index) =>
        Object.assign(move, { kind: index === 0 ? "transcript" : "legacy-store" }),
      );
      const database = path.join(state, "agents/main/agent/openclaw-agent.sqlite");
      const unusedDatabase = path.join(state, "agents/ops/agent/openclaw-agent.sqlite");
      const databaseBytes = "synthetic database bytes for the size observation";
      if (!missingDatabase) {
        fs.mkdirSync(path.dirname(database), { recursive: true });
        fs.writeFileSync(database, databaseBytes);
      }
      writeJson(path.join(manifests, "session-sqlite-fixture.json"), {
        manifestVersion: 3,
        runId: "session-sqlite-fixture",
        completedAt: "2026-09-26T00:00:00.000Z",
        targets: [
          { agentId: "main", storePath: store, sqlitePath: database, completedMoves: moves },
          {
            agentId: "ops",
            storePath: store,
            sqlitePath: unusedDatabase,
            completedMoves: [moves[1]],
          },
        ],
      });
      writeJson(path.join(artifacts, "recovery-fixture.json"), {
        originals,
        spec: { sessions: 1, eventsPerSession: 3 },
        preDoctorPaths: [],
      });
      fs.writeFileSync(path.join(artifacts, "recovery-update-metrics.log"), "");
      const evidence = path.join(artifacts, "recovery-evidence.json");
      const result = await runRecovery(root, ["migrated"]);
      expect(result.error).toBeUndefined();
      expect(fs.existsSync(unusedDatabase)).toBe(false);
      if (missingDatabase) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ENOENT");
        expect(result.stderr).toContain(database);
        expect(fs.existsSync(evidence)).toBe(false);
      } else {
        expectStatus(result);
        expect(readJson(evidence)).toMatchObject({
          migrationBeforeStandaloneDoctor: true,
          destinations: [{ file: database, bytes: Buffer.byteLength(databaseBytes) }],
        });
      }
    },
  );

  it("uses the existing volume controls and rejects unsafe counts", () => {
    expect(recoveryVolumeSpec({})).toEqual({ sessions: 2, eventsPerSession: 8 });
    expect(
      recoveryVolumeSpec({
        OPENCLAW_UPGRADE_SURVIVOR_VOLUME_SESSIONS: "1",
        OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION: "150000",
      }),
    ).toEqual({ sessions: 1, eventsPerSession: 150000 });
    for (const invalid of ["0", "-1", "1.5", "9007199254740992"]) {
      expect(() =>
        recoveryVolumeSpec({ OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION: invalid }),
      ).toThrow();
    }
  });

  it("produces independently indexed clean and protected originals with linked large history", () => {
    const root = temporary();
    const fixture = seedRecoveryFixture(root, { sessions: 2, eventsPerSession: 5 });
    const clean = readJson(path.join(root, "agents/recovery-clean/sessions/sessions.json"));
    const protectedStore = readJson(
      path.join(root, "agents/recovery-protected/sessions/sessions.json"),
    );
    expect(Object.keys(clean)).toHaveLength(4);
    expect(protectedStore["invalid-index-entry"]).toBe(42);
    expect(clean).not.toHaveProperty("invalid-index-entry");
    for (const original of fixture.originals) {
      expect(recoveryFileIdentity(original.source)).toEqual(original.identity);
    }
    for (const [agent, disposition, reported] of [
      ["recovery-protected", "unmanifested", false],
      ["recovery-clean", "protected", true],
    ] as const) {
      const source = path.join(root, `agents/${agent}/sessions/recovery-unreferenced.jsonl`);
      expect(fixture.originals.filter((original) => original.source === source)).toMatchObject([
        { disposition, reported },
      ]);
    }
    const scale = path.join(root, "agents/recovery-clean/sessions/recovery-scale-0.jsonl");
    const events = readLines(scale);
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ type: "session", version: 3, id: "recovery-scale-0" });
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].parentId).toBe(index === 1 ? null : events[index - 1].id);
    }
    expect(fs.statSync(scale).size).toBeGreaterThan(4 * 4096);
    expect(fs.readFileSync(path.join(root, "backups/operator-backup.bak"), "utf8")).toContain(
      "synthetic sentinel",
    );
  });

  it.each(["candidate", "unmanifested"] as const)("preserves %s originals", (disposition) => {
    const root = temporary();
    const source = path.join(root, "original.jsonl");
    writeRecoveryTranscript(source, "old", 3);
    const identity = recoveryFileIdentity(source);
    const original = {
      source,
      disposition,
      identity,
      ...(disposition === "unmanifested" ? { reported: false } : {}),
    };
    const fixture = { originals: [original] };
    const archived = disposition === "candidate";
    const archive = archived ? path.join(root, "archive.jsonl") : source;
    expect(() =>
      assertRecoveryOriginals(fixture, archived ? [] : [{ sourcePath: source }]),
    ).toThrow(archived ? /did not record/ : /recorded/);
    const moves = archived ? [archiveOriginal(source, archive).move] : [];
    expect(assertRecoveryOriginals(fixture, moves)).toMatchObject([{ ...original, archive }]);
    fs.appendFileSync(archive, "unexpected rewrite");
    expect(() => assertRecoveryOriginals(fixture, moves)).toThrow(
      archived ? /copied or rewritten/ : /changed/,
    );
    if (archived) {
      fs.rmSync(archive);
      expect(() => assertRecoveryOriginals(fixture, moves)).toThrow();
    }
  });

  it("allows only selected transient WAL indexes during offline maintenance", () => {
    const root = temporary();
    const database = path.join(root, "current.sqlite");
    const wal = `${database}-wal`;
    const shm = `${database}-shm`;
    const unrelatedShm = path.join(root, "unrelated.sqlite-shm");
    const sharedShm = path.join(root, "state", "openclaw.sqlite-shm");
    fs.mkdirSync(path.dirname(sharedShm));
    for (const file of [database, wal, shm, unrelatedShm, sharedShm]) {
      fs.writeFileSync(file, "original bytes");
    }
    const before = recoveryTreeSnapshot([root]);
    fs.writeFileSync(shm, "rebuilt agent WAL index");
    fs.writeFileSync(sharedShm, "rebuilt state WAL index");
    const after = recoveryTreeSnapshot([root]);
    expect(() => assertRecoverySnapshot(before, after)).toThrow();
    const allowed = recoveryWalIndexPaths(root, [{ sqlitePath: database }]);
    expect(() => assertRecoverySnapshot(before, after, allowed, true)).not.toThrow();

    for (const file of [database, wal, unrelatedShm]) {
      const baseline = recoveryTreeSnapshot([root]);
      fs.appendFileSync(file, "unexpected change");
      expect(() =>
        assertRecoverySnapshot(baseline, recoveryTreeSnapshot([root]), allowed, true),
      ).toThrow();
    }
  });

  it("rejects missing or misclassified originals even when aggregate candidates are nonzero", () => {
    const originals = [
      { archive: "/synthetic/clean", disposition: "candidate", identity: { size: 12 } },
      { archive: "/synthetic/protected", disposition: "protected", identity: { size: 17 } },
    ];
    const preview = {
      status: "preview",
      dryRun: true,
      artifacts: originals.map(({ archive, disposition, identity }) => ({
        path: archive,
        outcome: disposition,
        bytes: identity.size,
        reason: disposition === "candidate" ? "verified" : "unimported",
        runs: ["run"],
      })),
      totals: { candidateBytes: 12, protectedBytes: 17 },
    };
    expect(() => assertRecoveryInventory(preview, originals)).not.toThrow();
    expect(() =>
      assertRecoveryInventory({ ...preview, artifacts: preview.artifacts.slice(0, 1) }, originals),
    ).toThrow(/omitted/);
    const wrong = structuredClone(preview);
    wrong.artifacts[1]!.outcome = "candidate";
    expect(() => assertRecoveryInventory(wrong, originals)).toThrow(/classification/);
    expect(() => assertRecoveryInventory({ status: "preview" }, originals)).toThrow();
  });

  it("requires actual deletion, exact accounting, protected bytes, and every disposal receipt", () => {
    const root = temporary();
    const removedPath = path.join(root, "eligible");
    const protectedPath = path.join(root, "protected");
    fs.writeFileSync(removedPath, "eligible payload");
    fs.writeFileSync(protectedPath, "unique history");
    const originals = [removedPath, protectedPath].map((archive, index) => ({
      archive,
      disposition: index === 0 ? "candidate" : "protected",
      identity: recoveryFileIdentity(archive),
    }));
    const bytes = originals[0]!.identity.size;
    const preview = { artifacts: [{ path: removedPath, outcome: "candidate", bytes }] };
    const report = {
      status: "complete",
      dryRun: false,
      artifacts: [
        {
          path: removedPath,
          outcome: "removed",
          removedBytes: bytes,
          reason: "rollback-original-retired",
        },
      ],
      totals: { removedFiles: 1, removedBytes: bytes },
    };
    const receipts = [
      {
        archivePath: removedPath,
        artifact: { disposal: { state: "disposed", disposedAt: "2026-07-01T00:00:00Z" } },
      },
    ];
    const apply = (result = report, moves = receipts) =>
      assertRecoveryApplied(result, preview, originals, moves);
    expect(() => apply()).toThrow(/still exists/);
    fs.rmSync(removedPath);
    expect(apply()).toEqual([removedPath]);
    expect(() => apply(report, [])).toThrow(/receipt/);
    const incomplete = { archivePath: removedPath, artifact: { disposal: { state: "retained" } } };
    expect(() =>
      assertRecoveryApplied(report, preview, originals, [...receipts, incomplete]),
    ).toThrow(/receipt/);
    expect(() => apply({ ...report, totals: { removedFiles: 1, removedBytes: 0 } })).toThrow();
    fs.writeFileSync(protectedPath, "lost unique history");
    expect(() => apply()).toThrow(/protected/);
  });

  it("detects public history loss, reordering, and changed session identity", () => {
    const expected = ["old", "new"].map((id) => ({
      id,
      role: "assistant",
      content: [{ type: "text", text: id }],
    }));
    const messages = expected.map(({ id, ...message }) => ({ ...message, __openclaw: { id } }));
    const history = (entries: unknown[] = messages, sessionId = "session") =>
      assertRecoveryHistory({ sessionId, messages: entries }, "session", expected);
    expect(() => history()).not.toThrow();
    expect(() => history(messages, "replacement")).toThrow(/identity/);
    expect(() => history(messages.slice(1))).toThrow(/content or order/);
    expect(() => history(messages.toReversed())).toThrow(/content or order/);
    expect(() => history(messages.map(({ role, content }) => ({ role, content })))).toThrow(
      /message identity/,
    );
  });
});
