// Source install tests cover installing skill sources from local and remote inputs.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { installSkillFromSource } from "./source-install.js";

async function writeSkill(
  dir: string,
  params: { name?: string; description?: string; skillKey?: string } = {},
) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    [
      "---",
      `name: ${params.name ?? path.basename(dir)}`,
      `description: ${params.description ?? "A local skill"}`,
      ...(params.skillKey
        ? [`metadata: ${JSON.stringify({ openclaw: { skillKey: params.skillKey } })}`]
        : []),
      "---",
      "",
      "# Skill",
      "",
    ].join("\n"),
  );
}

async function initGitSkillRepo(repoDir: string, name = "git-skill") {
  await writeSkill(repoDir, { name });
  await runCommandWithTimeout(["git", "init"], { cwd: repoDir, timeoutMs: 30_000 });
  await runCommandWithTimeout(["git", "add", "SKILL.md"], { cwd: repoDir, timeoutMs: 30_000 });
  const commit = await runCommandWithTimeout(
    [
      "git",
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-m",
      "add skill",
    ],
    { cwd: repoDir, timeoutMs: 30_000 },
  );
  if (commit.code !== 0) {
    throw new Error(commit.stderr || commit.stdout || "git commit failed");
  }
}

async function runGitOk(repoDir: string, args: string[]) {
  const result = await runCommandWithTimeout(["git", ...args], {
    cwd: repoDir,
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function writeCapturePolicyScript(root: string) {
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
  return scriptPath;
}

function capturePolicyConfig(params: { scriptPath: string; capturePath: string }) {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: {
          source: "exec" as const,
          command: params.scriptPath,
          env: { CAPTURE_PATH: params.capturePath },
          trustedDirs: [path.dirname(params.scriptPath)],
        },
      },
    },
  };
}

describe("installSkillFromSource", () => {
  it("installs a local skill directory using the SKILL.md frontmatter name", async () => {
    await withTestDir({ prefix: "openclaw-skill-source-local-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const sourceDir = path.join(root, "source");
      await writeSkill(sourceDir, { name: "frontmatter-skill" });

      const result = await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
      });

      expect(result).toMatchObject({
        ok: true,
        slug: "frontmatter-skill",
        source: "path",
        targetDir: path.join(workspaceDir, "skills", "frontmatter-skill"),
      });
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "frontmatter-skill", "SKILL.md"), "utf8"),
      ).resolves.toContain("frontmatter-skill");
    });
  });

  it.each(["regular", "hardlink", "frontmatter"])(
    "resolves source-installed skill keys with %s metadata",
    async (kind) => {
      await withTestDir({ prefix: "openclaw-skill-source-as-" }, async (root) => {
        const workspaceDir = path.join(root, "workspace");
        const sourceDir = path.join(root, "source");
        await writeSkill(sourceDir, { name: "frontmatter-skill" });

        const result = await installSkillFromSource({
          workspaceDir,
          spec: sourceDir,
          slug: "custom-name",
        });

        expect(result).toMatchObject({
          ok: true,
          slug: "custom-name",
          source: "path",
          targetDir: path.join(workspaceDir, "skills", "custom-name"),
        });
        const skillDir = path.join(workspaceDir, "skills", "custom-name");
        if (kind === "hardlink") {
          await fs.link(
            path.join(skillDir, ".openclaw", "source-origin.json"),
            path.join(root, "origin-hardlink.json"),
          );
        } else if (kind === "frontmatter") {
          await writeSkill(skillDir, { name: "frontmatter-skill", skillKey: "declared-key" });
        }
        const status = buildWorkspaceSkillStatus(workspaceDir, {
          managedSkillsDir: path.join(root, "managed-skills"),
        });
        const skillKey = kind === "frontmatter" ? "declared-key" : "custom-name";
        const skill = status.skills.find((entry) => entry.skillKey === skillKey);
        expect(skill).toMatchObject({
          name: "frontmatter-skill",
          skillKey,
        });
      });
    },
  );

  it.each(["before-read", "during-admission"])(
    "ignores source-origin metadata that becomes oversized %s",
    async (when) => {
      await withTestDir({ prefix: "openclaw-skill-source-origin-cap-" }, async (root) => {
        const workspaceDir = path.join(root, "workspace");
        const sourceDir = path.join(root, "source");
        await writeSkill(sourceDir, { name: "frontmatter-skill" });

        const result = await installSkillFromSource({
          workspaceDir,
          spec: sourceDir,
          slug: "custom-name",
        });

        expect(result).toMatchObject({ ok: true });
        const marker = path.join(
          workspaceDir,
          "skills",
          "custom-name",
          ".openclaw",
          "source-origin.json",
        );
        if (when === "before-read") {
          await fs.appendFile(marker, " ".repeat(20 * 1024));
        }
        let grew = false;
        const lstat = fsSync.lstatSync.bind(fsSync);
        const observation =
          when === "during-admission"
            ? vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
                const stat = lstat(...args);
                if (!grew && String(args[0]) === marker) {
                  grew = true;
                  fsSync.appendFileSync(marker, " ".repeat(20 * 1024));
                }
                return stat;
              })
            : undefined;

        try {
          const status = buildWorkspaceSkillStatus(workspaceDir, {
            managedSkillsDir: path.join(root, "managed-skills"),
          });
          expect(status.skills.find((entry) => entry.skillKey === "custom-name")).toBeUndefined();
          expect(
            status.skills.find((entry) => entry.skillKey === "frontmatter-skill"),
          ).toBeDefined();
          if (when === "during-admission") {
            expect(grew).toBe(true);
          }
        } finally {
          observation?.mockRestore();
        }
      });
    },
  );

  it
    .runIf(process.platform !== "win32")
    .each(["contained-parent", "escaping-parent", "final-symlink", "swapped-final-symlink"])(
    "preserves source-origin link policy for %s",
    async (kind) => {
      await withTestDir({ prefix: "openclaw-skill-source-origin-links-" }, async (root) => {
        const workspaceDir = path.join(root, "workspace");
        const sourceDir = path.join(root, "source");
        await writeSkill(sourceDir, { name: "frontmatter-skill" });
        const result = await installSkillFromSource({
          workspaceDir,
          spec: sourceDir,
          slug: "custom-name",
        });
        expect(result).toMatchObject({ ok: true });
        const skillDir = path.join(workspaceDir, "skills", "custom-name");
        const metadataDir = path.join(skillDir, ".openclaw");
        const marker = path.join(metadataDir, "source-origin.json");
        const replacement = path.join(metadataDir, "origin-copy.json");
        if (kind.endsWith("parent")) {
          const target = path.join(kind === "contained-parent" ? skillDir : root, "origin");
          await fs.rename(metadataDir, target);
          await fs.symlink(target, metadataDir, "dir");
        } else if (kind === "final-symlink") {
          await fs.rename(marker, replacement);
          await fs.symlink(replacement, marker);
        }
        let swapped = false;
        const lstat = fsSync.lstatSync.bind(fsSync);
        const observation =
          kind === "swapped-final-symlink"
            ? vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
                const stat = lstat(...args);
                if (!swapped && String(args[0]) === marker) {
                  swapped = true;
                  fsSync.renameSync(marker, replacement);
                  fsSync.symlinkSync(replacement, marker);
                }
                return stat;
              })
            : undefined;
        try {
          const status = buildWorkspaceSkillStatus(workspaceDir, {
            managedSkillsDir: path.join(root, "managed-skills"),
          });
          expect(status.skills.find((entry) => entry.name === "frontmatter-skill")?.skillKey).toBe(
            kind === "contained-parent" ? "custom-name" : "frontmatter-skill",
          );
          if (kind === "swapped-final-symlink") {
            expect(swapped).toBe(true);
          }
        } finally {
          observation?.mockRestore();
        }
      });
    },
  );

  it("installs git: file repositories and records the resolved commit", async () => {
    await withTestDir({ prefix: "openclaw-skill-source-git-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const repoDir = path.join(root, "repo");
      await fs.mkdir(repoDir, { recursive: true });
      await initGitSkillRepo(repoDir);

      const result = await installSkillFromSource({
        workspaceDir,
        spec: `git:file://${repoDir}`,
      });

      expect(result).toMatchObject({
        ok: true,
        slug: "git-skill",
        source: "git",
        targetDir: path.join(workspaceDir, "skills", "git-skill"),
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(result.git?.commit).toMatch(/^[0-9a-f]{40}$/);
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "git-skill", "SKILL.md"), "utf8"),
      ).resolves.toContain("git-skill");
      await expect(
        fs.access(path.join(workspaceDir, "skills", "git-skill", ".git")),
      ).rejects.toThrow();
    });
  });

  it("isolates git commands from inherited Git hook environment", async () => {
    await withTestDir({ prefix: "openclaw-skill-source-git-env-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const repoDir = path.join(root, "repo");
      const poisonRepoDir = path.join(root, "poison");
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(poisonRepoDir, { recursive: true });
      await initGitSkillRepo(repoDir);
      await initGitSkillRepo(poisonRepoDir);
      await fs.writeFile(path.join(poisonRepoDir, "extra.txt"), "poison\n");
      await runGitOk(poisonRepoDir, ["add", "extra.txt"]);
      await runGitOk(poisonRepoDir, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-m",
        "poison commit",
      ]);
      const expectedCommit = await runGitOk(repoDir, ["rev-parse", "HEAD"]);
      const oldGitDir = process.env.GIT_DIR;
      try {
        process.env.GIT_DIR = path.join(poisonRepoDir, ".git");
        const result = await installSkillFromSource({
          workspaceDir,
          spec: `git:file://${repoDir}`,
        });

        expect(result).toMatchObject({
          ok: true,
          source: "git",
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        expect(result.git?.commit).toBe(expectedCommit);
      } finally {
        if (oldGitDir === undefined) {
          delete process.env.GIT_DIR;
        } else {
          process.env.GIT_DIR = oldGitDir;
        }
      }
    });
  });

  it("disables system git config while preserving sanitized git command env", async () => {
    await withTestDir({ prefix: "openclaw-skill-source-git-system-config-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const repoDir = path.join(root, "repo");
      const poisonRepoDir = path.join(root, "poison");
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(poisonRepoDir, { recursive: true });
      await initGitSkillRepo(repoDir, "good-skill");
      await initGitSkillRepo(poisonRepoDir, "poison-skill");
      const systemConfig = path.join(root, "system.gitconfig");
      await fs.writeFile(
        systemConfig,
        `[url "file://${poisonRepoDir}/"]\n\tinsteadOf = file://${repoDir}\n`,
      );
      const oldSystemConfig = process.env.GIT_CONFIG_SYSTEM;
      try {
        process.env.GIT_CONFIG_SYSTEM = systemConfig;
        const result = await installSkillFromSource({
          workspaceDir,
          spec: `git:file://${repoDir}`,
        });

        expect(result).toMatchObject({
          ok: true,
          slug: "good-skill",
          source: "git",
        });
      } finally {
        if (oldSystemConfig === undefined) {
          delete process.env.GIT_CONFIG_SYSTEM;
        } else {
          process.env.GIT_CONFIG_SYSTEM = oldSystemConfig;
        }
      }
    });
  });

  it("installs slash-containing git branch refs from fresh clones", async () => {
    await withTestDir({ prefix: "openclaw-skill-source-git-ref-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const repoDir = path.join(root, "repo");
      await fs.mkdir(repoDir, { recursive: true });
      await initGitSkillRepo(repoDir);
      await runGitOk(repoDir, ["branch", "-M", "main"]);
      await runGitOk(repoDir, ["checkout", "-b", "feature/skill"]);
      await writeSkill(repoDir, { name: "feature-skill", description: "Feature branch skill" });
      await runGitOk(repoDir, ["add", "SKILL.md"]);
      await runGitOk(repoDir, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-m",
        "update skill on branch",
      ]);
      await runGitOk(repoDir, ["checkout", "main"]);

      const result = await installSkillFromSource({
        workspaceDir,
        spec: `git:file://${repoDir}@feature/skill`,
      });

      expect(result).toMatchObject({
        ok: true,
        slug: "feature-skill",
        source: "git",
        targetDir: path.join(workspaceDir, "skills", "feature-skill"),
      });
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "feature-skill", "SKILL.md"), "utf8"),
      ).resolves.toContain("Feature branch skill");
    });
  });

  it.each([
    {
      name: "default branch",
      ref: undefined,
      expectedMutable: true,
    },
    {
      name: "full commit",
      ref: "commit",
      expectedMutable: false,
    },
  ] as const)(
    "reports $name git skill sources with expected mutability to policy",
    async (entry) => {
      await withTestDir({ prefix: "openclaw-skill-source-git-policy-" }, async (root) => {
        const workspaceDir = path.join(root, "workspace");
        const repoDir = path.join(root, "repo");
        await fs.mkdir(repoDir, { recursive: true });
        await initGitSkillRepo(repoDir);
        const commit = await runGitOk(repoDir, ["rev-parse", "HEAD"]);
        const scriptPath = await writeCapturePolicyScript(root);
        const capturePath = path.join(root, "policy-stdin.json");
        const ref = entry.ref === "commit" ? commit : entry.ref;

        const result = await installSkillFromSource({
          workspaceDir,
          spec: `git:file://${repoDir}${ref ? `@${ref}` : ""}`,
          config: capturePolicyConfig({ scriptPath, capturePath }),
        });

        if (!result.ok) {
          throw new Error(result.error);
        }
        expect(result.ok).toBe(true);
        const payload = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
          source?: { kind?: string; mutable?: boolean };
        };
        expect(payload.source).toMatchObject({
          kind: "git",
          mutable: entry.expectedMutable,
        });
      });
    },
  );

  it("removes stale ClawHub lock tracking after source installs", async () => {
    await withTestDir({ prefix: "openclaw-skill-source-untrack-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const sourceDir = path.join(root, "source");
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
        JSON.stringify(
          {
            version: 1,
            skills: {
              "frontmatter-skill": {
                version: "1.0.0",
                installedAt: 1,
              },
            },
          },
          null,
          2,
        ),
      );

      const result = await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
      });

      expect(result).toMatchObject({
        ok: true,
        slug: "frontmatter-skill",
      });
      const lock = JSON.parse(
        await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ) as { skills: Record<string, unknown> };
      expect(lock.skills["frontmatter-skill"]).toBeUndefined();
      await expect(
        fs.access(path.join(workspaceDir, "skills", "frontmatter-skill", ".clawhub")),
      ).rejects.toThrow();
    });
  });

  it("rejects missing local skill roots before treating them as ClawHub slugs", async () => {
    await withTestDir({ prefix: "openclaw-skill-source-missing-" }, async (root) => {
      const result = await installSkillFromSource({
        workspaceDir: path.join(root, "workspace"),
        spec: "./missing-skill",
      });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Skill path not found"),
      });
    });
  });

  it("refuses git specs whose url would be consumed as a git clone option", async () => {
    await withTestDir({ prefix: "openclaw-skill-source-opt-inject-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const payload = path.join(root, "payload.git");

      const result = await installSkillFromSource({
        workspaceDir,
        spec: `git:--upload-pack=${payload}`,
      });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Unsupported git skill spec"),
      });
    });
  });
});
