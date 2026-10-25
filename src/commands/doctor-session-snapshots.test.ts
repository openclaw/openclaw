import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry as loadEntry,
  upsertSessionEntryCore as upsertEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { assertSessionStoreMigrationComplete as assertMigrated } from "../config/sessions/startup-migration.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { initialDoctorHealthContribution } from "../flows/doctor-health-contributions-selection.test-support.js";
import * as packageRoots from "../infra/openclaw-root.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import * as bundledSkills from "../skills/loading/bundled-dir.js";
import type { Skill } from "../skills/loading/skill-contract.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

import {
  detectSessionSnapshotHealthIssues as detectIssues,
  noteSessionSnapshotHealth as noteHealth,
  sessionSnapshotIssueToHealthFinding as toHealthFinding,
} from "./doctor-session-snapshots.js";

function expectNote(...parts: string[]) {
  expect(note).toHaveBeenCalledTimes(1);
  for (const part of parts) {
    expect(note.mock.calls[0]?.[0]).toContain(part);
  }
}

function sessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "session-1", updatedAt: Date.now(), ...patch };
}

function skillPrompt(location: string): string {
  return `<available_skills>\n  <skill>\n    <name>doctor</name>\n    <description>Doctor skill</description>\n    <location>${location}</location>\n  </skill>\n</available_skills>`;
}

function skillSession(location: string, name = "doctor") {
  return sessionEntry({ skillsSnapshot: { prompt: skillPrompt(location), skills: [{ name }] } });
}

function expectedIssue(sessionKey: string, cachedPath: string, expectedPath: string) {
  return { sessionKey, field: "skillsSnapshot.prompt", cachedPath, expectedPath };
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
  let stalePath = "";
  let storePath = "";
  let currentSkillPath = "";

  beforeEach(async () => {
    note.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-session-snapshots-"));
    bundledSkillsDir = path.join(root, "current", "skills");
    currentSkillPath = path.join(bundledSkillsDir, "doctor", "SKILL.md");
    stalePath = path.join(root, "old-runtime/node_modules/openclaw/skills/doctor/SKILL.md");
    storePath = path.join(root, "state/agents/main/sessions/sessions.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", bundledSkillsDir);
    await fs.mkdir(path.dirname(currentSkillPath), { recursive: true });
    await fs.writeFile(currentSkillPath, "# Doctor\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearSessionStoreCacheForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function scanStore(store: Record<string, SessionEntry>) {
    await writeSessionStore(storePath, store);
    return detectIssues({ cfg: { session: { store: storePath } } });
  }

  it("flags cached bundled skill locations from inactive and temp-backed runtime roots", async () => {
    const tempBackedPath = path.join(path.sep, "private/tmp/openclaw/skills/doctor/SKILL.md");
    const findings = await scanStore({
      "agent:main": skillSession(stalePath),
      "agent:temp": skillSession(tempBackedPath),
    });

    expect(findings).toEqual([
      { storePath, ...expectedIssue("agent:main", stalePath, currentSkillPath) },
      { storePath, ...expectedIssue("agent:temp", tempBackedPath, currentSkillPath) },
    ]);
    expect(toHealthFinding(findings[0]!)).toMatchObject({
      checkId: "core/doctor/session-snapshots",
      severity: "info",
      path: storePath,
      target: stalePath,
      requirement: expect.stringContaining(bundledSkillsDir),
      fixHint: expect.stringContaining("No repair is needed"),
    });
  });

  it("resolves the retired package skills root for moved-skill snapshot inspection", async () => {
    const packageRoot = path.join(root, "package");
    const stateDir = path.join(root, "state");
    const expectedPath = path.join(stateDir, "plugin-skills", "imsg", "SKILL.md");
    await fs.mkdir(path.dirname(expectedPath), { recursive: true });
    await fs.writeFile(expectedPath, "# imsg\n");
    const movedStorePath = path.join(root, "snapshot-scan.json");
    await writeSessionStore(movedStorePath, {
      "agent:main": skillSession(
        path.join(root, "node_modules/openclaw/skills/imsg/SKILL.md"),
        "imsg",
      ),
    });
    vi.spyOn(bundledSkills, "resolveBundledSkillsDir").mockReturnValue(undefined);
    vi.spyOn(packageRoots, "resolveOpenClawPackageRootSync").mockReturnValue(packageRoot);

    expect(
      await detectIssues({
        cfg: { session: { store: movedStorePath } },
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toEqual([expect.objectContaining({ expectedPath })]);
  });

  it("handles Windows current and stale bundled skill paths without false positives", async () => {
    const windowsBundledSkillsDir = path.win32.join(
      "C:\\",
      "Users/alice/.openclaw/lib/node_modules/openclaw/skills",
    );
    const currentPath = path.win32.join(windowsBundledSkillsDir, "doctor", "SKILL.md");
    const windowsStalePath = path.win32.join(
      "C:\\",
      "opt/node_modules/openclaw/skills/doctor/SKILL.md",
    );

    vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", windowsBundledSkillsDir);
    vi.spyOn(fsSync, "existsSync").mockImplementation(
      (file) => String(file) === storePath || String(file) === currentPath,
    );
    const findings = await scanStore({
      "agent:current": skillSession(currentPath),
      "agent:stale": skillSession(windowsStalePath),
    });

    expect(findings).toEqual([
      { storePath, ...expectedIssue("agent:stale", windowsStalePath, currentPath) },
    ]);
  });

  it("scans resolvedSkills sourceInfo before normalization strips it", async () => {
    const skill = resolvedSkill(currentSkillPath);
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

    await noteHealth({ cfg: { session: { store: storePath } } });

    expectNote("agent:main", "skillsSnapshot.resolvedSkills", stalePath);
  });

  it("reports stale cached metadata from configured session stores", async () => {
    const stateDir = path.join(root, "state");
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await writeSessionStore(storePath, {});
    await writeSessionStore(configuredStorePath, { "agent:configured": skillSession(stalePath) });

    await noteHealth({
      cfg: { session: { store: configuredStorePath } },
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expectNote(configuredStorePath, "agent:configured", stalePath);
  });

  it("preserves a missing prompt blob without reporting false findings", async () => {
    const missingStorePath = path.join(root, "sessions", "sessions.json");
    await writeSessionStore(missingStorePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: "",
          promptRef: { version: 1, algorithm: "sha256", hash: "a".repeat(64), bytes: 100 },
          skills: [{ name: "doctor" }],
        },
      }),
    });
    const original = await fs.readFile(missingStorePath);

    await noteHealth({ cfg: { session: { store: missingStorePath } } });

    expect(note).not.toHaveBeenCalled();
    expect(await fs.readFile(missingStorePath)).toEqual(original);
  });

  it("preserves imported plugin source bytes and canonical sessions during Doctor repair", async () => {
    await withOpenClawTestState(
      { label: "retained-snapshot-source", env: { OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir } },
      async (state) => {
        const {
          cfg,
          storePath: retainedStorePath,
          scope,
        } = await seedDeferredPluginSessionSource(state, "default");
        const store = JSON.parse(await fs.readFile(retainedStorePath, "utf8"));
        const prompt = skillPrompt(
          path.join(root, "old", "node_modules", "openclaw", "skills", "doctor", "SKILL.md"),
        );
        store["agent:main:kept"].skillsSnapshot = {
          prompt,
          skills: [{ name: "doctor" }],
        };
        await fs.writeFile(retainedStorePath, JSON.stringify(store));
        const imported = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
        expect(imported.totals.importedEntries).toBe(2);
        await upsertEntry({ ...scope, sessionKey: "agent:main:kept" }, { label: "current" });
        const original = await fs.readFile(retainedStorePath);
        const identity = readMigrationArtifactIdentity(retainedStorePath);
        note.mockClear();
        const options = { repair: true, nonInteractive: true };
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        await initialDoctorHealthContribution("doctor:session-snapshots").run({
          cfg,
          cfgForPersistence: cfg,
          configResult: { cfg },
          configPath: state.configPath,
          sourceConfigValid: true,
          env: state.env,
          options,
          runtime,
          prompter: createDoctorPrompter({ runtime, options }),
        });

        expect(await fs.readFile(retainedStorePath)).toEqual(original);
        expect(readMigrationArtifactIdentity(retainedStorePath)).toEqual(identity);
        expect(
          (await fs.readdir(path.dirname(retainedStorePath))).some((file) =>
            file.startsWith("sessions.json.bak."),
          ),
        ).toBe(false);
        expect(loadEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry).toMatchObject({
          sessionId: "legacy-kept",
          label: "current",
          skillsSnapshot: { prompt },
        });
        expectNote("No cleanup or session reset is needed");
        expect(() => assertMigrated({ cfg, env: state.env })).not.toThrow();
      },
    );
  });
});
