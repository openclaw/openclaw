import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverWorkspaceDirs,
  MANAGED_SKILLS,
  seedWorkspaceFromAssets,
  syncManagedSkills,
} from "./workspace-seed.js";

function createTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `denchclaw-seed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createPackageRoot(tempDir: string): string {
  const pkgRoot = path.join(tempDir, "pkg");
  const seedDir = path.join(pkgRoot, "assets", "seed");
  const skillsDir = path.join(pkgRoot, "skills", "crm");
  mkdirSync(seedDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(path.join(seedDir, "workspace.duckdb"), "SEED_DB_CONTENT", "utf-8");
  writeFileSync(
    path.join(skillsDir, "SKILL.md"),
    "---\nname: database-crm-system\n---\n# CRM\n",
    "utf-8",
  );
  return pkgRoot;
}

describe("seedWorkspaceFromAssets", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("seeds CRM skill inside the workspace (not in state dir)", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-main");

    seedWorkspaceFromAssets({ workspaceDir, packageRoot });

    const skillPath = path.join(workspaceDir, "skills", "crm", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toContain("database-crm-system");

    const stateSkillPath = path.join(tempDir, "skills", "crm", "SKILL.md");
    expect(existsSync(stateSkillPath)).toBe(false);
  });

  it("does not write IDENTITY.md (identity is injected via dench-identity plugin)", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-test");

    seedWorkspaceFromAssets({ workspaceDir, packageRoot });

    const identityPath = path.join(workspaceDir, "IDENTITY.md");
    expect(existsSync(identityPath)).toBe(false);
  });

  it("creates CRM object projection files on first seed", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-proj");

    const result = seedWorkspaceFromAssets({ workspaceDir, packageRoot });

    expect(result.seeded).toBe(true);
    expect(result.reason).toBe("seeded");
    expect(existsSync(path.join(workspaceDir, "people", ".object.yaml"))).toBe(true);
    expect(existsSync(path.join(workspaceDir, "company", ".object.yaml"))).toBe(true);
    expect(existsSync(path.join(workspaceDir, "task", ".object.yaml"))).toBe(true);
    expect(existsSync(path.join(workspaceDir, "WORKSPACE.md"))).toBe(true);
  });

  it("skips DuckDB seeding when workspace.duckdb already exists", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-existing");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(path.join(workspaceDir, "workspace.duckdb"), "EXISTING_DB", "utf-8");

    const result = seedWorkspaceFromAssets({ workspaceDir, packageRoot });

    expect(result.seeded).toBe(false);
    expect(result.reason).toBe("already-exists");
    expect(readFileSync(path.join(workspaceDir, "workspace.duckdb"), "utf-8")).toBe("EXISTING_DB");
  });

  it("does not overwrite user IDENTITY.md when workspace already exists", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-resync");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(path.join(workspaceDir, "workspace.duckdb"), "DB", "utf-8");
    writeFileSync(path.join(workspaceDir, "IDENTITY.md"), "# my custom identity\n", "utf-8");

    seedWorkspaceFromAssets({ workspaceDir, packageRoot });

    const identityContent = readFileSync(path.join(workspaceDir, "IDENTITY.md"), "utf-8");
    expect(identityContent).toBe("# my custom identity\n");
  });

  it("includes skills/crm/SKILL.md in projection files list but not IDENTITY.md", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-list");

    const result = seedWorkspaceFromAssets({ workspaceDir, packageRoot });

    expect(result.projectionFiles).toContain("skills/crm/SKILL.md");
    expect(result.projectionFiles).not.toContain("skills/browser/SKILL.md");
    expect(result.projectionFiles).not.toContain("IDENTITY.md");
  });
});

describe("syncManagedSkills", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("syncs all managed skills and returns their names", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-sync");

    const result = syncManagedSkills({ workspaceDirs: [workspaceDir], packageRoot });

    expect(result.syncedSkills).toEqual(MANAGED_SKILLS.map((s) => s.name));
    expect(result.syncedSkills).not.toContain("browser");
    expect(result.identityUpdated).toBe(false);
    const skillPath = path.join(workspaceDir, "skills", "crm", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
  });

  it("does not write IDENTITY.md (identity is injected via plugin)", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-identity");

    const result = syncManagedSkills({ workspaceDirs: [workspaceDir], packageRoot });

    const identityPath = path.join(workspaceDir, "IDENTITY.md");
    expect(existsSync(identityPath)).toBe(false);
    expect(result.identityUpdated).toBe(false);
  });

  it("overwrites stale skills with updated content", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-overwrite");
    const skillPath = path.join(workspaceDir, "skills", "crm", "SKILL.md");
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "# old stale skill content\n", "utf-8");

    syncManagedSkills({ workspaceDirs: [workspaceDir], packageRoot });

    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("database-crm-system");
    expect(content).not.toContain("old stale skill content");
  });

  it("creates workspace dir if it does not exist", () => {
    const packageRoot = createPackageRoot(tempDir);
    const workspaceDir = path.join(tempDir, "workspace-fresh");

    expect(existsSync(workspaceDir)).toBe(false);
    syncManagedSkills({ workspaceDirs: [workspaceDir], packageRoot });
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it("syncs skills into multiple workspace directories", () => {
    const packageRoot = createPackageRoot(tempDir);
    const wsA = path.join(tempDir, "workspace-a");
    const wsB = path.join(tempDir, "workspace-b");

    const result = syncManagedSkills({ workspaceDirs: [wsA, wsB], packageRoot });

    expect(result.workspaceDirs).toEqual([wsA, wsB]);
    for (const ws of [wsA, wsB]) {
      expect(existsSync(path.join(ws, "skills", "crm", "SKILL.md"))).toBe(true);
    }
  });
});

describe("discoverWorkspaceDirs", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns all workspace dirs from agents.list and agents.defaults.workspace", () => {
    const wsDefault = path.join(tempDir, "workspace");
    const wsUser = path.join(tempDir, "workspace-user");
    mkdirSync(wsDefault, { recursive: true });
    mkdirSync(wsUser, { recursive: true });
    writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: { workspace: wsDefault },
          list: [
            { id: "main", workspace: wsDefault },
            { id: "user", workspace: wsUser },
          ],
        },
      }),
      "utf-8",
    );

    const dirs = discoverWorkspaceDirs(tempDir);

    expect(dirs).toContain(path.resolve(wsDefault));
    expect(dirs).toContain(path.resolve(wsUser));
    expect(dirs).toHaveLength(2);
  });

  it("ignores chat-slot agent workspace entries", () => {
    const wsDefault = path.join(tempDir, "workspace");
    const wsUser = path.join(tempDir, "workspace-user");
    const wsSlot = path.join(tempDir, "workspace-chat-slot-main-1");
    mkdirSync(wsDefault, { recursive: true });
    mkdirSync(wsUser, { recursive: true });
    mkdirSync(wsSlot, { recursive: true });
    writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: { workspace: wsDefault },
          list: [
            { id: "main", workspace: wsDefault },
            { id: "user", workspace: wsUser },
            { id: "chat-slot-main-1", workspace: wsSlot },
          ],
        },
      }),
      "utf-8",
    );

    const dirs = discoverWorkspaceDirs(tempDir);
    expect(dirs).toContain(path.resolve(wsDefault));
    expect(dirs).toContain(path.resolve(wsUser));
    expect(dirs).not.toContain(path.resolve(wsSlot));
  });

  it("deduplicates workspace dirs", () => {
    const ws = path.join(tempDir, "workspace");
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: { workspace: ws },
          list: [{ id: "main", workspace: ws }],
        },
      }),
      "utf-8",
    );

    const dirs = discoverWorkspaceDirs(tempDir);

    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(path.resolve(ws));
  });

  it("falls back to stateDir/workspace when no config exists", () => {
    const dirs = discoverWorkspaceDirs(tempDir);

    expect(dirs).toEqual([path.join(tempDir, "workspace")]);
  });

  it("skips workspace dirs that do not exist on disk", () => {
    const wsReal = path.join(tempDir, "workspace-real");
    mkdirSync(wsReal, { recursive: true });
    writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          list: [
            { id: "real", workspace: wsReal },
            { id: "ghost", workspace: path.join(tempDir, "workspace-ghost") },
          ],
        },
      }),
      "utf-8",
    );

    const dirs = discoverWorkspaceDirs(tempDir);

    expect(dirs).toEqual([path.resolve(wsReal)]);
  });
});
