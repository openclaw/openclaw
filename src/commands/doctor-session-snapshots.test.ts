// Doctor session snapshot tests cover advisory metadata inspection and retained-source preservation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSessionSnapshotsHealth } from "../flows/doctor-health-contribution-runners.state.js";
import { saveLegacySessionStore as saveSessionStore } from "../infra/state-migrations.legacy-session-store.js";
import type { Skill } from "../skills/loading/skill-contract.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readMigrationArtifactIdentity } from "./doctor-session-sqlite-artifact.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

import {
  detectSessionSnapshotHealthIssues,
  noteSessionSnapshotHealth,
  sessionSnapshotIssueToHealthFinding,
} from "./doctor-session-snapshots.js";
import {
  resolveSessionSnapshotBundledSkillsDir,
  scanSessionStoreForStaleRuntimeSnapshotPaths,
} from "./doctor-session-snapshots.test-support.js";

function sessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: Date.now(),
    ...patch,
  };
}

function skillPrompt(location: string): string {
  return [
    "<available_skills>",
    "  <skill>",
    "    <name>doctor</name>",
    "    <description>Doctor skill</description>",
    `    <location>${location}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");
}

function resolvedSkill(skillPath: string): Skill {
  const baseDir = path.dirname(skillPath);
  return {
    name: "doctor",
    description: "Doctor skill",
    filePath: skillPath,
    baseDir,
    source: "bundled",
    sourceInfo: {
      path: skillPath,
      source: "bundled",
      scope: "user",
      origin: "top-level",
      baseDir,
    },
    disableModelInvocation: false,
  };
}

async function writeSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

describe("doctor session snapshot stale runtime metadata", () => {
  let root = "";
  let bundledSkillsDir = "";

  beforeEach(async () => {
    note.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-session-snapshots-"));
    bundledSkillsDir = path.join(root, "current", "skills");
    await fs.mkdir(path.join(bundledSkillsDir, "doctor"), { recursive: true });
    await fs.writeFile(path.join(bundledSkillsDir, "doctor", "SKILL.md"), "# Doctor\n");
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("flags cached bundled skill locations from inactive and temp-backed runtime roots", () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const tempBackedPath = path.join(
      path.sep,
      "private",
      "tmp",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir,
      store: {
        "agent:main": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(stalePath),
            skills: [{ name: "doctor" }],
          },
        }),
        "agent:temp": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(tempBackedPath),
            skills: [{ name: "doctor" }],
          },
        }),
      },
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:main",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: path.join(bundledSkillsDir, "doctor", "SKILL.md"),
      },
      {
        sessionKey: "agent:temp",
        field: "skillsSnapshot.prompt",
        cachedPath: tempBackedPath,
        expectedPath: path.join(bundledSkillsDir, "doctor", "SKILL.md"),
      },
    ]);
  });

  it("maps stale snapshot paths to advisory findings without repair guidance", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    const [issue] = await detectSessionSnapshotHealthIssues({
      storePaths: [storePath],
      bundledSkillsDir,
    });

    if (!issue) {
      throw new Error("expected session snapshot health issue");
    }
    expect(issue).toMatchObject({
      storePath,
      sessionKey: "agent:main",
      field: "skillsSnapshot.prompt",
      cachedPath: stalePath,
      expectedPath: path.join(bundledSkillsDir, "doctor", "SKILL.md"),
    });
    expect(sessionSnapshotIssueToHealthFinding(issue)).toMatchObject({
      checkId: "core/doctor/session-snapshots",
      severity: "info",
      path: storePath,
      target: stalePath,
      requirement: expect.stringContaining(bundledSkillsDir),
      fixHint: expect.stringContaining("No repair is needed"),
    });
  });

  it("uses the OS home for cached OCM paths when OPENCLAW_HOME differs", () => {
    const homeDir = path.join(root, "home");
    const currentBundledSkillsDir = path.join(homeDir, ".ocm/current/node_modules/openclaw/skills");
    const expectedPath = path.join(currentBundledSkillsDir, "doctor", "SKILL.md");
    const currentPath = "~/.ocm/current/node_modules/openclaw/skills/doctor/SKILL.md";
    const stalePath = "~/.ocm/old/node_modules/openclaw/skills/doctor/SKILL.md";

    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir: currentBundledSkillsDir,
      env: { HOME: homeDir, OPENCLAW_HOME: path.join(root, "ocm-profile") },
      store: {
        "agent:current": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(currentPath), skills: [{ name: "doctor" }] },
        }),
        "agent:stale": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(stalePath), skills: [{ name: "doctor" }] },
        }),
      },
      pathExists: (filePath) => filePath === expectedPath,
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:stale",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath,
      },
    ]);
  });

  it("identifies stale imsg bundled paths to the generated plugin skill path", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "imsg",
      "SKILL.md",
    );
    const stateDir = path.join(root, "state");
    const pluginSkillPath = path.join(stateDir, "plugin-skills", "imsg", "SKILL.md");
    await fs.mkdir(path.dirname(pluginSkillPath), { recursive: true });
    await fs.writeFile(pluginSkillPath, "# imsg\n");

    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir,
      env: { OPENCLAW_STATE_DIR: stateDir },
      store: {
        "agent:imsg": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(stalePath),
            skills: [{ name: "imsg" }],
          },
        }),
      },
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:imsg",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: pluginSkillPath,
      },
    ]);
  });

  it("identifies retired imsg paths even when cached under the current package skills root", async () => {
    const packageSkillsDir = path.join(root, "node_modules", "openclaw", "skills");
    const stalePath = path.join(packageSkillsDir, "imsg", "SKILL.md");
    const stateDir = path.join(root, "state");
    const pluginSkillPath = path.join(stateDir, "plugin-skills", "imsg", "SKILL.md");
    await fs.mkdir(path.dirname(pluginSkillPath), { recursive: true });
    await fs.writeFile(pluginSkillPath, "# imsg\n");

    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir: packageSkillsDir,
      env: { OPENCLAW_STATE_DIR: stateDir },
      store: {
        "agent:imsg": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(stalePath),
            skills: [{ name: "imsg" }],
          },
        }),
      },
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:imsg",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: pluginSkillPath,
      },
    ]);
  });

  it("resolves the retired package skills root for moved-skill snapshot inspection", async () => {
    const packageRoot = path.join(root, "package");
    const distDir = path.join(packageRoot, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw" }),
    );
    const modulePath = path.join(distDir, "doctor-session-snapshots.js");
    await fs.writeFile(modulePath, "// stub\n");

    expect(
      resolveSessionSnapshotBundledSkillsDir({
        moduleUrl: pathToFileURL(modulePath).href,
        argv1: path.join(packageRoot, "bin", "openclaw"),
        cwd: distDir,
      }),
    ).toBe(path.join(packageRoot, "skills"));
  });

  it("ignores current bundled locations and unrelated workspace skill locations", () => {
    const currentPath = path.join(bundledSkillsDir, "doctor", "SKILL.md");
    const workspacePath = path.join(root, "workspace", "skills", "doctor", "SKILL.md");
    const openClawWorkspacePath = path.join(
      root,
      "projects",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir,
      store: {
        "agent:current": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(currentPath), skills: [{ name: "doctor" }] },
        }),
        "agent:workspace": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(workspacePath), skills: [{ name: "doctor" }] },
        }),
        "agent:openclaw-workspace": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(openClawWorkspacePath),
            skills: [{ name: "doctor" }],
          },
        }),
      },
      pathExists: (filePath) => filePath === currentPath,
    });

    expect(findings).toEqual([]);
  });

  it("handles Windows current and stale bundled skill paths without false positives", () => {
    const windowsBundledSkillsDir = path.win32.join(
      "C:\\",
      "Users",
      "alice",
      ".openclaw",
      "lib",
      "node_modules",
      "openclaw",
      "skills",
    );
    const currentPath = path.win32.join(windowsBundledSkillsDir, "doctor", "SKILL.md");
    const stalePath = path.win32.join(
      "C:\\",
      "opt",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );

    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir: windowsBundledSkillsDir,
      store: {
        "agent:current": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(currentPath), skills: [{ name: "doctor" }] },
        }),
        "agent:stale": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(stalePath), skills: [{ name: "doctor" }] },
        }),
      },
      pathExists: (filePath) => filePath === currentPath,
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:stale",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: currentPath,
      },
    ]);
  });

  it("reports stale cached metadata while distinguishing the live runtime root", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({ storePaths: [storePath], bundledSkillsDir });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session snapshots");
    expect(message).toContain("stale cached session metadata paths");
    expect(message).toContain("Live bundled skills root is healthy");
    expect(message).toContain("inactive runtime root");
    expect(message).toContain(stalePath);
    expect(message).toContain(path.join(bundledSkillsDir, "doctor", "SKILL.md"));
  });

  it.each(["path", "sourceInfo"] as const)(
    "scans resolvedSkills %s before normalization strips them",
    async (field) => {
      const stalePath = path.join(
        root,
        "old-runtime",
        "node_modules",
        "openclaw",
        "skills",
        "doctor",
        "SKILL.md",
      );
      const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
      const skill = resolvedSkill(
        field === "path" ? stalePath : path.join(bundledSkillsDir, "doctor", "SKILL.md"),
      );
      skill.sourceInfo.path = stalePath;
      skill.sourceInfo.baseDir = path.dirname(stalePath);
      await writeSessionStore(storePath, {
        "agent:main": sessionEntry({
          skillsSnapshot: {
            prompt: "",
            skills: [{ name: "doctor" }],
            resolvedSkills: [skill],
          },
        }),
      });

      await noteSessionSnapshotHealth({ storePaths: [storePath], bundledSkillsDir });

      expect(note).toHaveBeenCalledTimes(1);
      const [message] = note.mock.calls[0] as [string, string];
      expect(message).toContain("agent:main");
      expect(message).toContain("skillsSnapshot.resolvedSkills");
      expect(message).toContain(stalePath);
    },
  );

  it("hydrates blobbed skills prompts before scanning raw session stores", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    const prompt = `${skillPrompt(stalePath)}\n${"padding\n".repeat(200)}`;
    await saveSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt,
          skills: [{ name: "doctor" }],
        },
      }),
    });
    const raw = await fs.readFile(storePath, "utf-8");
    expect(raw).not.toContain(stalePath);
    expect(raw).toContain("promptRef");

    await noteSessionSnapshotHealth({ storePaths: [storePath], bundledSkillsDir });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("agent:main");
    expect(message).toContain("skillsSnapshot.prompt");
    expect(message).toContain(stalePath);
  });

  it("reports stale cached metadata from configured session stores", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const stateDir = path.join(root, "state");
    const defaultStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await writeSessionStore(defaultStorePath, {});
    await writeSessionStore(configuredStorePath, {
      "agent:configured": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      cfg: { session: { store: configuredStorePath } } as OpenClawConfig,
      bundledSkillsDir,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain(configuredStorePath);
    expect(message).toContain("agent:configured");
    expect(message).toContain(stalePath);
  });

  it("reports stale cached metadata from templated configured session stores", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const templatedStore = path.join(root, "stores", "{agentId}", "sessions.json");
    const opsStorePath = path.join(root, "stores", "ops", "sessions.json");
    await writeSessionStore(opsStorePath, {
      "agent:ops": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      cfg: {
        session: { store: templatedStore },
        agents: { list: [{ id: "main" }, { id: "ops" }] },
      } as OpenClawConfig,
      bundledSkillsDir,
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain(opsStorePath);
    expect(message).toContain("agent:ops");
    expect(message).toContain(stalePath);
  });

  it("preserves a missing prompt blob without reporting false findings", async () => {
    const storePath = path.join(root, "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: "",
          promptRef: { version: 1, algorithm: "sha256", hash: "a".repeat(64), bytes: 100 },
          skills: [{ name: "doctor" }],
        },
      }),
    });
    const original = await fs.readFile(storePath);

    await noteSessionSnapshotHealth({ storePaths: [storePath], bundledSkillsDir });

    expect(note).not.toHaveBeenCalled();
    expect(await fs.readFile(storePath)).toEqual(original);
  });

  it("preserves imported plugin source bytes and canonical sessions during Doctor repair", async () => {
    await withOpenClawTestState(
      { label: "retained-snapshot-source", env: { OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir } },
      async (state) => {
        const { cfg, storePath, scope } = seedDeferredPluginSessionSource(state, "default");
        const store = JSON.parse(await fs.readFile(storePath, "utf8"));
        const prompt = skillPrompt(
          path.join(root, "old", "node_modules", "openclaw", "skills", "doctor", "SKILL.md"),
        );
        store["agent:main:kept"].skillsSnapshot = {
          prompt,
          skills: [{ name: "doctor" }],
        };
        await fs.writeFile(storePath, JSON.stringify(store));
        const imported = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
        expect(imported.totals.importedEntries).toBe(2);
        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "current" },
        );
        const original = await fs.readFile(storePath);
        const identity = readMigrationArtifactIdentity(storePath);
        note.mockClear();

        await runSessionSnapshotsHealth({
          cfg,
          cfgForPersistence: cfg,
          configResult: { cfg },
          configPath: state.configPath,
          sourceConfigValid: true,
          env: state.env,
          options: { repair: true, nonInteractive: true },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          prompter: {
            confirm: async () => true,
            confirmAutoFix: async () => true,
            confirmAggressiveAutoFix: async () => true,
            confirmRuntimeRepair: async () => true,
            select: async (_params, fallback) => fallback,
            shouldRepair: true,
            shouldForce: false,
            repairMode: {
              shouldRepair: true,
              shouldForce: false,
              nonInteractive: true,
              canPrompt: false,
              updateInProgress: false,
            },
          },
        });

        expect(await fs.readFile(storePath)).toEqual(original);
        expect(readMigrationArtifactIdentity(storePath)).toEqual(identity);
        expect(
          (await fs.readdir(path.dirname(storePath))).some((file) =>
            file.startsWith("sessions.json.bak."),
          ),
        ).toBe(false);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry,
        ).toMatchObject({
          sessionId: "legacy-kept",
          label: "current",
          skillsSnapshot: { prompt },
        });
        expect(note).toHaveBeenCalledTimes(1);
        expect(note.mock.calls[0]?.[0]).toContain("No cleanup or session reset is needed");
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      },
    );
  });
});
