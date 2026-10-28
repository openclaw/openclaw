import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectArchivedSources } from "./deferred-plugin-session-artifacts.js";

const reads = vi.hoisted(() => ({ manifests: 0 }));

vi.mock("./session-sqlite-migration-manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-sqlite-migration-manifest.js")>();
  return {
    ...actual,
    readSessionSqliteMigrationManifest: (manifestPath: string) => {
      reads.manifests += 1;
      return actual.readSessionSqliteMigrationManifest(manifestPath);
    },
  };
});

let root: string;
let runsDir: string;
let sessionsDir: string;
let archiveDir: string;
let storePath: string;
let sqlitePath: string;
let env: NodeJS.ProcessEnv;

function move(name: string, disposal: "retained" | "disposed" = "retained") {
  return {
    archivePath: path.join(archiveDir, `${name}.jsonl`),
    artifact: {
      classification: "imported",
      reason: "deferred-plugin-session-import",
      dependencies: [],
      disposal:
        disposal === "retained"
          ? { state: "retained" }
          : { state: "disposed", disposedAt: "2026-10-28T00:00:00.000Z" },
      identity: {
        dev: "1",
        ino: name,
        mtimeNs: "1",
        size: 1,
        sha256: "a".repeat(64),
      },
    },
    kind: "transcript",
    sourcePath: path.join(sessionsDir, `${name}.jsonl`),
  };
}

function manifest(runId: string, moves: ReturnType<typeof move>[], targetSqlitePath = sqlitePath) {
  return `${JSON.stringify(
    {
      manifestVersion: 3,
      openClawVersion: "test",
      runId,
      startedAt: "2026-10-28T00:00:00.000Z",
      targets: [
        {
          agentId: "main",
          completedMoves: [],
          issues: [],
          plannedMoves: moves,
          sqlitePath: targetSqlitePath,
          storePath,
          validationBeforeArchive: "not_run",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function writeManifest(runId: string, content: string): string {
  const manifestPath = path.join(runsDir, `${runId}.json`);
  writeFileSync(manifestPath, content);
  return manifestPath;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "openclaw-archived-sources-"));
  runsDir = path.join(root, "session-sqlite-migration-runs");
  sessionsDir = path.join(root, "agents", "main", "sessions");
  archiveDir = path.join(root, "agents", "main", "session-sqlite-import-archive");
  storePath = path.join(sessionsDir, "sessions.json");
  sqlitePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  mkdirSync(runsDir, { recursive: true });
  env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root };
  reads.manifests = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("collectArchivedSources scan reuse", () => {
  it("parses unchanged manifests once and keeps the archive inventory observable", () => {
    writeManifest("run-a", manifest("run-a", [move("alpha")]));
    writeManifest("run-b", manifest("run-b", [move("beta")]));
    const target = { agentId: "main", sqlitePath, storePath };

    const first = collectArchivedSources(target, env);
    expect([...first.keys()].sort()).toEqual([
      path.join(sessionsDir, "alpha.jsonl"),
      path.join(sessionsDir, "beta.jsonl"),
    ]);
    expect(first.get(path.join(sessionsDir, "alpha.jsonl"))?.[0]?.path).toBe(
      path.join(archiveDir, "alpha.jsonl"),
    );
    expect(reads.manifests).toBe(2);

    expect([...collectArchivedSources(target, env).keys()]).toHaveLength(2);
    expect(reads.manifests).toBe(2);

    // A different filter shape is a different question and re-reads.
    expect([...collectArchivedSources(target, env, true).keys()]).toHaveLength(2);
    expect(reads.manifests).toBe(4);
  });

  it("keeps the selected SQLite database part of the target identity", () => {
    writeManifest("run-a", manifest("run-a", [move("alpha")]));
    const otherSqlitePath = path.join(root, "agents", "main", "agent", "replacement.sqlite");

    expect([...collectArchivedSources({ agentId: "main", sqlitePath, storePath }, env).keys()])
      .toHaveLength(1);
    expect(reads.manifests).toBe(1);

    // Same agent and store, different database: the manifest does not describe it.
    expect(
      [...collectArchivedSources({ agentId: "main", sqlitePath: otherSqlitePath, storePath }, env)],
    ).toEqual([]);
    expect(reads.manifests).toBe(2);

    expect([...collectArchivedSources({ agentId: "main", sqlitePath, storePath }, env).keys()])
      .toHaveLength(1);
    expect(reads.manifests).toBe(2);
  });

  it("re-reads a manifest that changed on disk", () => {
    const target = { agentId: "main", sqlitePath, storePath };
    const manifestPath = writeManifest("run-a", manifest("run-a", [move("alpha")]));
    expect([...collectArchivedSources(target, env).keys()]).toHaveLength(1);
    expect(reads.manifests).toBe(1);

    writeFileSync(manifestPath, manifest("run-a", [move("alpha"), move("beta")]));
    expect([...collectArchivedSources(target, env).keys()]).toHaveLength(2);
    expect(reads.manifests).toBe(2);

    expect([...collectArchivedSources(target, env).keys()]).toHaveLength(2);
    expect(reads.manifests).toBe(2);
  });

  it("keeps disposed archives out of the retained scan", () => {
    writeManifest("run-a", manifest("run-a", [move("alpha"), move("beta", "disposed")]));
    const target = { agentId: "main", sqlitePath, storePath };

    expect([...collectArchivedSources(target, env).keys()]).toHaveLength(2);
    expect([...collectArchivedSources(target, env, true).keys()]).toEqual([
      path.join(sessionsDir, "alpha.jsonl"),
    ]);
  });
});
