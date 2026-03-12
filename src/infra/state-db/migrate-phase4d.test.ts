import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import {
  getClawhubSyncMeta,
  getSkillPreviewFromDb,
  getAllLockEntriesFromDb,
  getCatalogSkillsFromDb,
  resetClawhubDbForTest,
  setClawhubDbForTest,
} from "./clawhub-sqlite.js";
import { resetCoreSettingsDbForTest, setCoreSettingsDbForTest } from "./core-settings-sqlite.js";
import {
  loadExecApprovalsFromDb,
  resetExecApprovalsDbForTest,
  setExecApprovalsDbForTest,
} from "./exec-approvals-sqlite.js";
import { migratePhase4dToSqlite } from "./migrate-phase4d.js";
import { runMigrations } from "./schema.js";
import {
  getWorkspaceStateFromDb,
  resetWorkspaceStateDbForTest,
  setWorkspaceStateDbForTest,
} from "./workspace-state-sqlite.js";

describe("migratePhase4dToSqlite", () => {
  let db: ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
  let tmpDir: string;

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    // Wire all adapters to the same in-memory DB
    setExecApprovalsDbForTest(db);
    setCoreSettingsDbForTest(db);
    setWorkspaceStateDbForTest(db);
    setClawhubDbForTest(db);
  });

  afterEach(() => {
    resetExecApprovalsDbForTest();
    resetCoreSettingsDbForTest();
    resetWorkspaceStateDbForTest();
    resetClawhubDbForTest();
    try {
      db.close();
    } catch {
      // ignore
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function makeStateDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-migrate-4d-"));
    return tmpDir;
  }

  function writeJsonFile(dir: string, relPath: string, data: unknown) {
    const filePath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  }

  function makeEnv(stateDir: string): NodeJS.ProcessEnv {
    return { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
  }

  // ── exec-approvals ──────────────────────────────────────────────────────

  it("migrates exec-approvals.json", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "exec-approvals.json", {
      version: 1,
      socket: { path: "~/.openclaw/exec-approvals.sock" },
      defaults: { security: "allowlist", ask: "on-miss" },
      agents: {
        main: {
          security: "full",
          allowlist: [{ pattern: "npm *", lastUsedAt: 1700000000000 }],
        },
      },
    });

    const results = migratePhase4dToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "exec-approvals");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(1);
    // Source file removed
    expect(fs.existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);

    const stored = loadExecApprovalsFromDb();
    expect(stored?.defaults?.security).toBe("allowlist");
    expect(stored?.agents?.main?.security).toBe("full");
    expect(stored?.agents?.main?.allowlist?.[0]?.pattern).toBe("npm *");
  });

  it("skips exec-approvals.json if DB already has data", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "exec-approvals.json", {
      version: 1,
      defaults: { security: "deny" },
      agents: {},
    });

    // Pre-populate DB
    migratePhase4dToSqlite(makeEnv(stateDir));
    // Write the file back for a second migration attempt
    writeJsonFile(stateDir, "exec-approvals.json", {
      version: 1,
      defaults: { security: "full" },
      agents: {},
    });

    const results = migratePhase4dToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "exec-approvals");
    expect(r?.migrated).toBe(false);
    // Original value preserved
    expect(loadExecApprovalsFromDb()?.defaults?.security).toBe("deny");
    // File was removed (idempotent cleanup)
    expect(fs.existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
  });

  it("skips missing exec-approvals.json without error", () => {
    const stateDir = makeStateDir();
    const results = migratePhase4dToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "exec-approvals");
    expect(r?.migrated).toBe(false);
    expect(r?.error).toBeUndefined();
  });

  // ── workspace-state ──────────────────────────────────────────────────────

  it("migrates workspace-state.json for all discovered workspaces", () => {
    const stateDir = makeStateDir();
    const ws1 = path.join(stateDir, "workspace");
    const ws2 = path.join(stateDir, "workspace-secondary");
    writeJsonFile(ws1, ".openclaw/workspace-state.json", {
      version: 1,
      onboardingCompletedAt: "2026-03-01T10:00:00.000Z",
    });
    writeJsonFile(ws2, ".openclaw/workspace-state.json", {
      version: 1,
      bootstrapSeededAt: "2026-03-05T09:00:00.000Z",
    });

    const results = migratePhase4dToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "workspace-state");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(2);

    const s1 = getWorkspaceStateFromDb<{ onboardingCompletedAt?: string }>(ws1);
    expect(s1?.onboardingCompletedAt).toBe("2026-03-01T10:00:00.000Z");
    const s2 = getWorkspaceStateFromDb<{ bootstrapSeededAt?: string }>(ws2);
    expect(s2?.bootstrapSeededAt).toBe("2026-03-05T09:00:00.000Z");

    expect(fs.existsSync(path.join(ws1, ".openclaw", "workspace-state.json"))).toBe(false);
    expect(fs.existsSync(path.join(ws2, ".openclaw", "workspace-state.json"))).toBe(false);
  });

  // ── clawhub catalog ──────────────────────────────────────────────────────

  it("migrates clawhub catalog.json", () => {
    const stateDir = makeStateDir();
    const ws = path.join(stateDir, "workspace");
    writeJsonFile(ws, ".openclaw/clawhub/catalog.json", {
      syncedAt: "2026-03-10T08:00:00.000Z",
      totalSkills: 2,
      skills: [
        { slug: "gh-pr", displayName: "GitHub PR", latestVersion: { version: "1.0.0" } },
        { slug: "twitter", displayName: "Twitter Bot", latestVersion: { version: "2.0.0" } },
      ],
    });

    migratePhase4dToSqlite(makeEnv(stateDir));

    const meta = getClawhubSyncMeta(ws);
    expect(meta?.syncedAt).toBe("2026-03-10T08:00:00.000Z");
    const skills = getCatalogSkillsFromDb(ws);
    expect(skills.map((s) => s.slug)).toEqual(["gh-pr", "twitter"]);
    expect(fs.existsSync(path.join(ws, ".openclaw", "clawhub", "catalog.json"))).toBe(false);
  });

  it("migrates clawhub previews", () => {
    const stateDir = makeStateDir();
    const ws = path.join(stateDir, "workspace");
    writeJsonFile(ws, ".openclaw/clawhub/previews/gh-pr.json", {
      slug: "gh-pr",
      version: "1.0.0",
      fetchedAt: "2026-03-10T08:00:00.000Z",
      content: "# GitHub PR\nPreview content",
    });

    migratePhase4dToSqlite(makeEnv(stateDir));

    const preview = getSkillPreviewFromDb(ws, "gh-pr");
    expect(preview?.content).toBe("# GitHub PR\nPreview content");
    expect(preview?.version).toBe("1.0.0");
    expect(fs.existsSync(path.join(ws, ".openclaw", "clawhub", "previews", "gh-pr.json"))).toBe(
      false,
    );
  });

  it("migrates clawhub lock file", () => {
    const stateDir = makeStateDir();
    const ws = path.join(stateDir, "workspace");
    writeJsonFile(ws, ".openclaw/clawhub/clawhub.lock.json", {
      "gh-pr": { version: "1.2.0" },
      twitter: { version: "2.0.0" },
    });

    migratePhase4dToSqlite(makeEnv(stateDir));

    const locks = getAllLockEntriesFromDb(ws);
    expect(locks["gh-pr"]?.version).toBe("1.2.0");
    expect(locks["twitter"]?.version).toBe("2.0.0");
    expect(fs.existsSync(path.join(ws, ".openclaw", "clawhub", "clawhub.lock.json"))).toBe(false);
  });

  it("returns empty results when no files exist", () => {
    const stateDir = makeStateDir();
    const results = migratePhase4dToSqlite(makeEnv(stateDir));
    expect(results.every((r) => !r.migrated && !r.error)).toBe(true);
  });
});
