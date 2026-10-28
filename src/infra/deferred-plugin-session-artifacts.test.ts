import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectArchivedSources } from "./deferred-plugin-session-artifacts.js";
import type { SessionSqliteMigrationTargetInput } from "./session-sqlite-migration-manifest.js";

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
let env: NodeJS.ProcessEnv;
let target: SessionSqliteMigrationTargetInput;

function manifest(runId: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      manifestVersion: 3,
      openClawVersion: "test",
      runId,
      startedAt: "2026-10-28T00:00:00.000Z",
      targets: [],
      ...extra,
    },
    null,
    2,
  )}\n`;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "openclaw-archived-sources-"));
  runsDir = path.join(root, "session-sqlite-migration-runs");
  mkdirSync(runsDir, { recursive: true });
  env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root };
  target = {
    agentId: "main",
    sqlitePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
  };
  reads.manifests = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("collectArchivedSources manifest reads", () => {
  it("parses each recorded manifest once for repeated scans of one target", () => {
    writeFileSync(path.join(runsDir, "run-a.json"), manifest("run-a"));
    writeFileSync(path.join(runsDir, "run-b.json"), manifest("run-b"));

    expect([...collectArchivedSources(target, env)]).toEqual([]);
    expect([...collectArchivedSources(target, env)]).toEqual([]);
    expect([...collectArchivedSources(target, env, true)]).toEqual([]);
    expect([...collectArchivedSources(target, env)]).toEqual([]);

    // Two manifests are parsed once per target/filter slot, not once per scan.
    expect(reads.manifests).toBe(4);
  });

  it("re-reads once a recorded manifest changes on disk", () => {
    const manifestPath = path.join(runsDir, "run-a.json");
    writeFileSync(manifestPath, manifest("run-a"));
    collectArchivedSources(target, env);
    expect(reads.manifests).toBe(1);

    writeFileSync(manifestPath, manifest("run-a", { startedAt: "2026-10-28T00:00:01.000Z" }));
    collectArchivedSources(target, env);
    expect(reads.manifests).toBe(2);

    collectArchivedSources(target, env);
    expect(reads.manifests).toBe(2);
  });

  it("keeps per-target scans independent and returns a fresh map", () => {
    writeFileSync(path.join(runsDir, "run-a.json"), manifest("run-a"));
    const first = collectArchivedSources(target, env);
    first.set("/kept", []);

    const other = { ...target, storePath: path.join(root, "agents", "other", "sessions.json") };
    collectArchivedSources(other, env);
    expect(reads.manifests).toBe(2);

    // A caller mutating its result must not corrupt the retained scan.
    expect([...collectArchivedSources(target, env)]).toEqual([]);
    expect(reads.manifests).toBe(2);
  });
});
