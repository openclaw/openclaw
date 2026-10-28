import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { buildWorkspaceSkillStatus, prepareWorkspaceSkillStatus } from "../discovery/status.js";
import { installSkill } from "./install.js";
import { installSkillFromSource } from "./source-install.js";

async function writeSkill(
  dir: string,
  params: { name?: string; description?: string; skillKey?: string } = {},
) {
  await fs.mkdir(dir, { recursive: true });
  const metadata = params.skillKey
    ? `metadata: ${JSON.stringify({ openclaw: { skillKey: params.skillKey } })}\n`
    : "";
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${params.name ?? path.basename(dir)}
description: ${params.description ?? "A local skill"}
${metadata}---
`,
  );
}

async function initGitSkillRepo(repoDir: string, name = "git-skill") {
  await writeSkill(repoDir, { name });
  await runGitOk(repoDir, ["init"]);
  await commitGitSkill(repoDir, "add skill");
}

async function commitGitSkill(repoDir: string, message: string) {
  await runGitOk(repoDir, ["add", "SKILL.md"]);
  await runGitOk(repoDir, ["commit", "-m", message]);
}

async function runGitOk(repoDir: string, args: string[]) {
  const result = await runCommandWithTimeout(
    ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test User", ...args],
    { cwd: repoDir, timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function capturePolicyConfig(capturePath: string) {
  await fs.chmod(root, 0o700);
  const scriptPath = path.join(root, "capture-policy.cjs");
  await fs.writeFile(
    scriptPath,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.env.CAPTURE_PATH, input);",
      "  process.stdout.write(JSON.stringify({ protocolVersion: 1, decision: 'allow' }));",
      "});",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: {
          source: "exec" as const,
          command: scriptPath,
          env: { CAPTURE_PATH: capturePath },
          trustedDirs: [root],
        },
      },
    },
  };
}

const tempDirs = createTempDirTracker();
let root: string, workspaceDir: string, sourceDir: string;
beforeEach(() => {
  root = tempDirs.make("openclaw-skill-source-");
  workspaceDir = path.join(root, "workspace");
  sourceDir = path.join(root, "source");
});
afterEach(() => {
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});
function install(overrides: Partial<Parameters<typeof installSkillFromSource>[0]> = {}) {
  return installSkillFromSource({ workspaceDir, spec: sourceDir, ...overrides });
}

async function prepareOrigin() {
  await writeSkill(sourceDir, { name: "frontmatter-skill" });
  const skillDir = path.join(workspaceDir, "skills", "custom-name");
  expect(await install({ slug: "custom-name" })).toMatchObject({
    slug: "custom-name",
    source: "path",
    targetDir: skillDir,
  });
  const metadataDir = path.join(skillDir, ".openclaw");
  return { skillDir, metadataDir, marker: path.join(metadataDir, "source-origin.json") };
}

function skillStatus() {
  return buildWorkspaceSkillStatus(workspaceDir, {
    managedSkillsDir: path.join(root, "managed-skills"),
  });
}

function mutateAfterStat(marker: string, mutate: () => void) {
  let changed = false;
  const lstat = fsSync.lstatSync.bind(fsSync);
  const observation = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (!changed && String(args[0]) === marker) {
      changed = true;
      mutate();
    }
    return stat;
  });
  return { changed: () => changed, restore: () => observation.mockRestore() };
}

describe("installSkillFromSource", () => {
  it.each(["", "Display name with spaces"])(
    "uses the source label for display name %j",
    async (name) => {
      sourceDir = path.join(root, "source-label");
      await writeSkill(sourceDir, { name });
      const result = await install();
      expect(result.slug).toBe("source-label");
      await expect(fs.readFile(path.join(result.targetDir, "SKILL.md"), "utf8")).resolves.toContain(
        "A local skill",
      );
    },
  );

  it("rejects an invalid explicit slug before inspecting malformed source content", async () => {
    await fs.mkdir(sourceDir);
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), "description: unfenced\n");
    await expect(install({ slug: "../invalid" })).rejects.toThrow("Invalid skill slug: ../invalid");
    await expect(fs.access(path.join(workspaceDir, "skills"))).rejects.toThrow();
  });

  it.each(["active", "stopped"])(
    "installs local sources with a %s document-only adapter",
    async (state) => {
      await writeSkill(sourceDir, { name: "local-guide" });
      const release = registerAgentWorkspaceAccess(workspaceDir, {
        bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
      });
      if (state === "stopped") {
        release();
      }
      try {
        expect(await install()).toMatchObject({ slug: "local-guide", source: "path" });
        await expect(
          fs.readFile(path.join(workspaceDir, "skills/local-guide/SKILL.md"), "utf8"),
        ).resolves.toContain("local-guide");
        expect((await prepareWorkspaceSkillStatus(workspaceDir)).report.skills).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "local-guide" })]),
        );
        expect(
          await installSkill({ workspaceDir, skillName: "local-guide", installId: "missing" }),
        ).toMatchObject({ ok: false, message: "Installer not found: missing" });
      } finally {
        release();
      }
    },
  );

  it.each(["unfenced", "oversized", "comment-only", "indented-comment-only"] as const)(
    "rejects %s SKILL.md before copying it",
    async (kind) => {
      const slug = kind === "unfenced" ? "probe-x" : "oversized-skill";
      if (kind === "unfenced") {
        await fs.mkdir(sourceDir, { recursive: true });
        await fs.writeFile(
          path.join(sourceDir, "SKILL.md"),
          "name: probe-x\nversion: 1.0.0\ndescription: probe\n\n---\n\nUse when testing.\n",
        );
      } else if (kind === "comment-only" || kind === "indented-comment-only") {
        await writeSkill(sourceDir, {
          name: slug,
          description:
            kind === "comment-only" ? "# Add a description here" : "\n  # Add a description here",
        });
      } else {
        await writeSkill(sourceDir, { name: slug, description: "x".repeat(80) });
      }
      const result = install(
        kind === "oversized"
          ? { config: { skills: { limits: { maxSkillFileBytes: 64 } } } }
          : { slug },
      );
      await expect(result).rejects.toThrow(
        kind === "oversized" ? "File exceeds 64 bytes" : "description is required",
      );
      if (kind === "oversized") {
        await expect(result).rejects.not.toThrow("invalid frontmatter");
      }
      await expect(fs.access(path.join(workspaceDir, "skills", slug))).rejects.toThrow();
    },
  );

  it("installs a valid SKILL.md that is hardlinked to another file", async () => {
    await writeSkill(sourceDir, { name: "linked-skill" });
    const alias = path.join(root, "linked-alias.md");
    await fs.link(path.join(sourceDir, "SKILL.md"), alias);

    const result = await install();

    const installed = path.join(workspaceDir, "skills", "linked-skill", "SKILL.md");
    expect(result).toMatchObject({
      slug: "linked-skill",
      source: "path",
      targetDir: path.dirname(installed),
    });
    const [installedStat, aliasStat] = await Promise.all([fs.lstat(installed), fs.lstat(alias)]);
    expect(installedStat.nlink).toBe(1);
    expect(installedStat.ino).not.toBe(aliasStat.ino);
    await expect(fs.readFile(installed, "utf8")).resolves.toContain("linked-skill");
  });

  it.each(["hardlink", "frontmatter"])(
    "resolves source-installed skill keys with %s metadata",
    async (kind) => {
      const { skillDir } = await prepareOrigin();
      if (kind === "hardlink") {
        await fs.link(
          path.join(skillDir, ".openclaw", "source-origin.json"),
          path.join(root, "origin-hardlink.json"),
        );
      } else if (kind === "frontmatter") {
        await writeSkill(skillDir, { name: "frontmatter-skill", skillKey: "declared-key" });
      }
      const skillKey = kind === "frontmatter" ? "declared-key" : "custom-name";
      expect(skillStatus().skills.find((entry) => entry.skillKey === skillKey)).toMatchObject({
        name: "frontmatter-skill",
        skillKey,
      });
    },
  );

  it.each(["before-read", "during-admission"])(
    "ignores source-origin metadata that becomes oversized %s",
    async (when) => {
      const { marker } = await prepareOrigin();
      if (when === "before-read") {
        await fs.appendFile(marker, " ".repeat(20 * 1024));
      }
      const observation =
        when === "during-admission"
          ? mutateAfterStat(marker, () => fsSync.appendFileSync(marker, " ".repeat(20 * 1024)))
          : undefined;

      try {
        const status = skillStatus();
        expect(status.skills.find((entry) => entry.skillKey === "custom-name")).toBeUndefined();
        expect(status.skills.find((entry) => entry.skillKey === "frontmatter-skill")).toBeDefined();
        if (when === "during-admission") {
          expect(observation?.changed()).toBe(true);
        }
      } finally {
        observation?.restore();
      }
    },
  );

  it
    .runIf(process.platform !== "win32")
    .each(["contained-parent", "escaping-parent", "final-symlink", "swapped-final-symlink"])(
    "preserves source-origin link policy for %s",
    async (kind) => {
      const { skillDir, metadataDir, marker } = await prepareOrigin();
      const replacement = path.join(metadataDir, "origin-copy.json");
      if (kind.endsWith("parent")) {
        const target = path.join(kind === "contained-parent" ? skillDir : root, "origin");
        await fs.rename(metadataDir, target);
        await fs.symlink(target, metadataDir, "dir");
      } else if (kind === "final-symlink") {
        await fs.rename(marker, replacement);
        await fs.symlink(replacement, marker);
      }
      const observation =
        kind === "swapped-final-symlink"
          ? mutateAfterStat(marker, () => {
              fsSync.renameSync(marker, replacement);
              fsSync.symlinkSync(replacement, marker);
            })
          : undefined;
      try {
        const status = skillStatus();
        expect(status.skills.find((entry) => entry.name === "frontmatter-skill")?.skillKey).toBe(
          kind === "contained-parent" ? "custom-name" : "frontmatter-skill",
        );
        if (kind === "swapped-final-symlink") {
          expect(observation?.changed()).toBe(true);
        }
      } finally {
        observation?.restore();
      }
    },
  );

  it.each(["GIT_DIR", "GIT_CONFIG_SYSTEM"] as const)(
    "isolates git commands from inherited %s",
    async (variable) => {
      const repoDir = path.join(root, "repo");
      const poisonRepoDir = path.join(root, "poison");
      await initGitSkillRepo(repoDir, "good-skill");
      await initGitSkillRepo(poisonRepoDir, "poison-skill");
      const expectedCommit = await runGitOk(repoDir, ["rev-parse", "HEAD"]);
      let poisonPath = path.join(poisonRepoDir, ".git");
      if (variable === "GIT_CONFIG_SYSTEM") {
        poisonPath = path.join(root, "system.gitconfig");
        await fs.writeFile(
          poisonPath,
          `[url "file://${poisonRepoDir}/"]\n\tinsteadOf = file://${repoDir}\n`,
        );
      }
      vi.stubEnv(variable, poisonPath);
      const result = await install({ spec: `git:file://${repoDir}` });
      expect(result).toMatchObject({
        slug: "good-skill",
        source: "git",
        git: { commit: expectedCommit },
      });
    },
  );

  it.each([
    ["default branch", undefined, true],
    ["full commit", "commit", false],
    ["slash-containing branch", "feature/skill", true],
  ] as const)(
    "reports %s git skill sources with expected mutability to policy",
    async (_name, sourceRef, expectedMutable) => {
      const repoDir = path.join(root, "repo");
      await initGitSkillRepo(repoDir);
      if (sourceRef === "feature/skill") {
        await runGitOk(repoDir, ["branch", "-M", "main"]);
        await runGitOk(repoDir, ["checkout", "-b", sourceRef]);
        await writeSkill(repoDir, { name: "feature-skill", description: "Feature branch skill" });
        await commitGitSkill(repoDir, "update skill on branch");
        await runGitOk(repoDir, ["checkout", "main"]);
      }
      const commit = await runGitOk(repoDir, ["rev-parse", "HEAD"]);
      const capturePath = path.join(root, "policy-stdin.json");
      const ref = sourceRef === "commit" ? commit : sourceRef;

      const result = await install({
        spec: `git:file://${repoDir}${ref ? `@${ref}` : ""}`,
        config: await capturePolicyConfig(capturePath),
      });

      const slug = sourceRef === "feature/skill" ? "feature-skill" : "git-skill";
      const targetDir = path.join(workspaceDir, "skills", slug);
      expect(result).toMatchObject({ slug, source: "git", targetDir });
      expect(result.git?.commit).toMatch(/^[0-9a-f]{40}$/);
      await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).resolves.toContain(
        sourceRef === "feature/skill" ? "Feature branch skill" : "git-skill",
      );
      await expect(fs.access(path.join(targetDir, ".git"))).rejects.toThrow();
      const payload = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        source?: { kind?: string; mutable?: boolean };
      };
      expect(payload.source).toMatchObject({ kind: "git", mutable: expectedMutable });
    },
  );

  it("removes stale ClawHub lock tracking after source installs", async () => {
    await writeSkill(sourceDir, { name: "frontmatter-skill" });
    await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
    await fs.mkdir(path.join(sourceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, ".clawhub", "origin.json"),
      JSON.stringify({
        version: 1,
        registry: "https://clawhub.example",
        slug: "frontmatter-skill",
        installedVersion: "1.0.0",
        installedAt: 1,
      }),
    );
    await fs.writeFile(
      path.join(workspaceDir, ".clawhub", "lock.json"),
      JSON.stringify({
        version: 1,
        skills: { "frontmatter-skill": { version: "1.0.0", installedAt: 1 } },
      }),
    );

    expect(await install()).toMatchObject({ slug: "frontmatter-skill" });
    const lock = JSON.parse(
      await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
    ) as { skills: Record<string, unknown> };
    expect(lock.skills["frontmatter-skill"]).toBeUndefined();
    await expect(
      fs.access(path.join(workspaceDir, "skills", "frontmatter-skill", ".clawhub")),
    ).rejects.toThrow();
  });

  it.each(["missing path", "git option injection"] as const)(
    "rejects a source spec containing %s",
    async (kind) => {
      const result = install({
        spec:
          kind === "missing path"
            ? "./missing-skill"
            : `git:--upload-pack=${path.join(root, "payload.git")}`,
      });
      await expect(result).rejects.toThrow(
        kind === "missing path" ? "Skill path not found" : "Unsupported git skill spec",
      );
    },
  );
});
