import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

const skill = (dir: string, name: string, description = name) =>
  writeSkill({ dir, name, description });
async function link(target: string, destination: string, type: "dir" | "file" = "dir") {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.symlink(target, destination, type);
  return destination;
}

let fakeHome = "";
let envSnapshot: SkillsHomeEnvSnapshot;
let tempRoot = "";
let workspaceCaseIndex = 0;

async function createTempWorkspaceDir() {
  const workspaceDir = path.join(tempRoot, `workspace-${++workspaceCaseIndex}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

async function writeHardlinkedSkill(params: { dir: string; name: string; description: string }) {
  const sourceDir = path.join(tempRoot, `hardlink-source-${++workspaceCaseIndex}`);
  await writeSkill({ ...params, dir: sourceDir });
  await fs.mkdir(params.dir, { recursive: true });
  const skillFilePath = path.join(params.dir, "SKILL.md");
  await fs.link(path.join(sourceDir, "SKILL.md"), skillFilePath);
  expect((await fs.stat(skillFilePath)).nlink).toBeGreaterThan(1);
}

function captureWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return warn;
}

function firstWarningLine(warn: ReturnType<typeof vi.fn>): string {
  const [line] = warn.mock.calls[0] ?? [];
  return String(line);
}

function loadTestWorkspaceSkills(
  workspaceDir: string,
  opts?: Parameters<typeof loadWorkspaceSkills>[1],
) {
  return loadWorkspaceSkills(workspaceDir, {
    managedSkillsDir: path.join(workspaceDir, ".managed"),
    bundledSkillsDir: "",
    pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    ...opts,
  });
}

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-containment-"));
  fakeHome = path.join(tempRoot, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  envSnapshot = setMockSkillsHomeEnv(fakeHome);
});

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

afterAll(async () => {
  await restoreMockSkillsHomeEnv(envSnapshot, async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});

it("rejects hardlinked workspace skills while preserving ordinary files", async () => {
  const workspaceDir = await createTempWorkspaceDir();
  const skillRoot = path.join(workspaceDir, "skills");
  const rejectedSkillName = "workspace-hardlinked-skill";
  const acceptedSkillName = "workspace-ordinary-skill";
  await writeHardlinkedSkill({
    dir: path.join(skillRoot, rejectedSkillName),
    name: rejectedSkillName,
    description: "Untrusted workspace hardlink",
  });
  await skill(
    path.join(skillRoot, acceptedSkillName),
    acceptedSkillName,
    "Ordinary workspace skill",
  );
  const warn = captureWarningLogger();

  const entries = loadTestWorkspaceSkills(workspaceDir);

  expect(entries).toEqual([
    expect.objectContaining({
      skill: expect.objectContaining({ name: acceptedSkillName, source: "openclaw-workspace" }),
    }),
  ]);
  const warningLine = firstWarningLine(warn);
  expect(warningLine).toContain("Skipping invalid skill:");
  expect(warningLine).toContain(rejectedSkillName);
  expect(warningLine).toMatch(/hardlink/iu);
});

it.runIf(process.platform !== "win32")(
  "skips workspace skill paths that resolve outside the workspace root",
  async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const outsideDir = await createTempWorkspaceDir();
    const escapedSkillDir = path.join(outsideDir, "outside-skill");
    await skill(escapedSkillDir, "outside-skill", "Outside");
    const requestedPath = path.join(workspaceDir, "skills", "escaped-skill");
    await link(escapedSkillDir, requestedPath);
    const fileLinkSkillDir = path.join(workspaceDir, "skills", "escaped-file");
    await link(path.join(outsideDir, "SKILL.md"), path.join(fileLinkSkillDir, "SKILL.md"), "file");
    const targetDir = path.join(workspaceDir, "safe-target");
    await skill(targetDir, "symlink-target", "Target skill");
    const symlinkedSkillDir = path.join(workspaceDir, "skills", "symlinked");
    await link(path.join(targetDir, "SKILL.md"), path.join(symlinkedSkillDir, "SKILL.md"), "file");
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir);

    expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-file-skill");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("symlink-target");
    const warningLine = firstWarningLine(warn);
    expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
    expect(warningLine).toContain("reason=symlink-escape");
    expect(warningLine).toContain("source=openclaw-workspace");
    expect(warningLine).toContain(`root=${path.join(workspaceDir, "skills")}`);
    expect(warningLine).toContain(`requested=${requestedPath}`);
    expect(warningLine).toContain("resolved=");
  },
);

it.runIf(process.platform !== "win32")(
  "rejects symlinked skills in the Workshop-owned directory",
  async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const config = {
      agents: { entries: { main: { agentDir: path.join(workspaceDir, ".agent") } } },
    };
    const workshopSkillsDir = resolveWorkshopSkillsDir(config, "main");
    const outsideDir = await createTempWorkspaceDir();
    const outsideSkillDir = path.join(outsideDir, "outside-workshop-skill");
    await skill(outsideSkillDir, "outside-workshop-skill", "Outside Workshop");
    await link(outsideSkillDir, path.join(workshopSkillsDir, "outside-workshop-skill"));
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir, { config, agentId: "main" });

    expect(entries).toEqual([]);
    expect(firstWarningLine(warn)).toContain("source=openclaw-workshop");
    expect(firstWarningLine(warn)).toContain("reason=symlink-escape");
  },
);

it.runIf(process.platform !== "win32")(
  "allows configured skill symlink targets outside their source root",
  async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillName = `manager-${++workspaceCaseIndex}`;
    const targetRoot = path.join(tempRoot, `${skillName}-skills`);
    const targetSkillDir = path.join(targetRoot, skillName);
    await skill(targetSkillDir, skillName, "Manager skill");
    const workspaceSkillsDir = path.join(workspaceDir, "skills");
    const symlinkPath = path.join(workspaceSkillsDir, skillName);
    await link(targetSkillDir, symlinkPath);
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir, {
      config: { skills: { load: { allowSymlinkTargets: [targetRoot] } } },
    });

    expect(entries.map((entry) => entry.skill.name)).toContain(skillName);
    expect(warn).not.toHaveBeenCalled();
  },
);

it.runIf(process.platform !== "win32")(
  "keeps SKILL.md containment for managed symlinked skill directories",
  async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const skillName = `managed-file-link-${++workspaceCaseIndex}`;
    const targetSkillDir = path.join(tempRoot, `${skillName}-target`, skillName);
    const outsideDir = path.join(tempRoot, `${skillName}-outside`);
    await skill(outsideDir, skillName, "Escaped metadata");
    await link(path.join(outsideDir, "SKILL.md"), path.join(targetSkillDir, "SKILL.md"), "file");
    const symlinkPath = path.join(managedDir, skillName);
    await link(targetSkillDir, symlinkPath);
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir, {
      managedSkillsDir: managedDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain(skillName);
    const warningLine = firstWarningLine(warn);
    expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
    expect(warningLine).toContain("source=openclaw-managed");
    expect(warningLine).toContain("reason=symlink-escape");
  },
);

it.runIf(process.platform !== "win32")(
  "uses compact home-relative paths in escaped skill console warnings",
  async () => {
    const workspaceDir = path.join(fakeHome, "workspace");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const escaped = path.join(fakeHome, "outside", "outside-bundled-skill");
    await skill(escaped, "outside-bundled-skill");
    await link(escaped, path.join(bundledDir, "escaped-bundled-skill"));
    const warn = captureWarningLogger();

    expect(
      loadTestWorkspaceSkills(workspaceDir, {
        bundledSkillsDir: bundledDir,
      }),
    ).toEqual([]);

    const warningLine = firstWarningLine(warn);
    expect(warningLine).toContain("root=~/workspace/.bundled");
    expect(warningLine).toContain("requested=~/workspace/.bundled/escaped-bundled-skill");
    expect(warningLine).toContain("resolved=~/outside/outside-bundled-skill");
  },
);

it.runIf(process.platform !== "win32").each([false, true])(
  "discovers nested roots without following unapproved symlinks (allowed=%s)",
  async (allowed) => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    const outsideDir = await createTempWorkspaceDir();
    const target = allowed ? path.join(outsideDir, "linked") : outsideDir;
    const name = allowed ? "linked-skill" : "outside-linked-skill";
    await skill(path.join(outsideDir, "linked"), name);
    await link(target, path.join(repoDir, allowed ? "group" : "examples", "linked"));
    await skill(path.join(repoDir, "skills", "group", "valid"), "repo-nested-skill");
    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: {
            extraDirs: [repoDir],
            ...(allowed ? { allowSymlinkTargets: [outsideDir] } : {}),
          },
        },
      },
    }).map((entry) => entry.skill.name);
    expect(names).toContain("repo-nested-skill");
    expect(names.includes(name)).toBe(allowed);
  },
);
