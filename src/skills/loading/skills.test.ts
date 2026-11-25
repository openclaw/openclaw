// Skill loading tests cover bundled, plugin, and workspace skill resolution.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listReservedChatSlashCommandNames } from "../../auto-reply/commands-registry.data.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import {
  captureEnv,
  createPathResolutionEnv,
  withEnv,
  withEnvAsync,
  withPathResolutionEnv,
} from "../../test-utils/env.js";
import { buildWorkspaceSkillCommandSpecs } from "../discovery/command-specs.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  getActiveSkillEnvKeysCore,
} from "../runtime/env-overrides.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillEntry, SkillSnapshot } from "../types.js";
import { shouldIncludeSkill } from "./config.js";
import { useLoadingFixture } from "./loading.test-support.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const fixture = useLoadingFixture("openclaw-skills-suite-", "state");
const pluginEnvSnapshot = captureEnv(["OPENCLAW_DISABLE_BUNDLED_PLUGINS"]);

const resolveTestSkillDirs = (workspaceDir: string) => ({
  config: { plugins: { enabled: false } },
  managedSkillsDir: path.join(workspaceDir, ".managed"),
  bundledSkillsDir: path.join(workspaceDir, ".bundled"),
});

const makeWorkspace = () => fixture.createDir();
const apiKeyField = ["api", "Key"].join("");

function writeWorkspaceSkill(
  workspaceDir: string,
  name: string,
  description: string,
  extra?: Partial<Parameters<typeof writeSkill>[0]>,
) {
  return writeSkill({ dir: path.join(workspaceDir, "skills", name), name, description, ...extra });
}

const withClearedEnv = <T>(keys: string[], run: () => T): T =>
  withEnv(Object.fromEntries(keys.map((key) => [key, undefined])), run);

function makeSkillEntry(
  name: string,
  metadata: SkillEntry["metadata"],
  description = "Needs env",
): SkillEntry {
  const baseDir = `/virtual/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return {
    skill: {
      name,
      description,
      filePath,
      baseDir,
      source: "test",
      sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
      disableModelInvocation: false,
    },
    frontmatter: {},
    metadata,
  };
}

function envSkillEntries(name: string, metadata: SkillEntry["metadata"]): SkillEntry[] {
  return [makeSkillEntry(name, metadata)];
}

function skillConfig(
  name: string,
  config: NonNullable<NonNullable<OpenClawConfig["skills"]>["entries"]>[string],
): OpenClawConfig {
  return { skills: { entries: { [name]: config } } };
}

function rawSkillApiKeyRefConfig(skillName: string): OpenClawConfig {
  return skillConfig(skillName, {
    apiKey: { source: "file", provider: "default", id: `/skills/entries/${skillName}/apiKey` },
  });
}

function checkOverrides(
  restore: () => void,
  check: () => void,
  checkRestored: () => void = () => {},
) {
  try {
    check();
  } finally {
    restore();
    checkRestored();
  }
}

function expectEnv(expected: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(process.env[key], key).toBe(value);
  }
}

beforeAll(async () => {
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  await fs.mkdir(path.join(fixture.home, ".openclaw", "agents", "main", "sessions"), {
    recursive: true,
  });
});

afterAll(() => pluginEnvSnapshot.restore());

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  setActiveDegradedSecretOwners([]);
});

describe("buildWorkspaceSkillCommandSpecs", () => {
  it.each([["dashboard", "dashboard_2"]])(
    "moves a colliding %s skill to the generated alias %s",
    async (skillName, commandName) => {
      const workspaceDir = await makeWorkspace();
      await writeWorkspaceSkill(workspaceDir, skillName, "Custom command skill");

      const [command] = withPathResolutionEnv(workspaceDir, { PATH: "" }, () =>
        buildWorkspaceSkillCommandSpecs(workspaceDir, {
          ...resolveTestSkillDirs(workspaceDir),
          reservedNames: listReservedChatSlashCommandNames(),
        }),
      );

      expect(command).toMatchObject({ name: commandName, skillName });
    },
  );

  it("preserves descriptions and tool-dispatch metadata", async () => {
    const workspaceDir = await makeWorkspace();
    const longDescription =
      "This is a very long description that exceeds Discord's 100 character limit for slash command descriptions and should be truncated";
    await writeWorkspaceSkill(workspaceDir, "long-desc", longDescription, {
      body: "# Short Description\n",
    });
    await writeWorkspaceSkill(workspaceDir, "tool-dispatch", "Dispatch to a tool", {
      frontmatterExtra: "command-dispatch: tool\ncommand-tool: sessions_send",
    });

    const commands = buildWorkspaceSkillCommandSpecs(
      workspaceDir,
      resolveTestSkillDirs(workspaceDir),
    );

    const cmd = commands.find((entry) => entry.skillName === "tool-dispatch");
    expect(commands.find((entry) => entry.skillName === "long-desc")).toMatchObject({
      displayName: "Short Description",
      description: longDescription,
    });
    expect(cmd?.dispatch).toEqual({ kind: "tool", toolName: "sessions_send", argMode: "raw" });
    expect(cmd?.skillSource).toBe("workspace");
  });

  it("includes enabled Claude bundle markdown commands as native OpenClaw slash commands", async () => {
    const workspaceDir = await makeWorkspace();
    const config = {
      plugins: { entries: { "compound-bundle": { enabled: true } } },
    } satisfies OpenClawConfig;

    // Prime plugin discovery before the bundle exists; clear the lifecycle cache
    // below to model the install/reload boundary that exposes new plugin files.
    buildWorkspaceSkillCommandSpecs(workspaceDir, {
      ...resolveTestSkillDirs(workspaceDir),
      config,
    });

    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "compound-bundle");
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "commands"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "compound-bundle" }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginRoot, "commands", "workflows-review.md"),
      "---\nname: workflows:review\ndescription: Review code with a structured checklist\n---\nReview the branch carefully.\n",
      "utf-8",
    );
    clearPluginMetadataLifecycleCaches();

    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      ...resolveTestSkillDirs(workspaceDir),
      config,
    });

    const command = commands.find((entry) => entry.skillName === "workflows:review");
    expect(command).toMatchObject({
      name: "workflows_review",
      description: "Review code with a structured checklist",
      promptTemplate: "Review the branch carefully.",
    });
    expect(command?.sourceFilePath).toContain(
      path.join(pluginRoot, "commands", "workflows-review.md"),
    );
  });
});

describe("buildWorkspaceSkillsPrompt", () => {
  it("applies per-agent skillsLimits.maxSkillsPromptChars", async () => {
    const workspaceDir = await makeWorkspace();
    for (const name of ["alpha-skill", "beta-skill", "gamma-skill"]) {
      await writeWorkspaceSkill(workspaceDir, name, "D".repeat(240));
    }

    const { prompt } = await withEnvAsync(
      createPathResolutionEnv(workspaceDir, { PATH: "" }),
      async () =>
        await buildSkillSnapshot(workspaceDir, {
          ...resolveTestSkillDirs(workspaceDir),
          config: {
            plugins: { enabled: false },
            skills: { limits: { maxSkillsPromptChars: 4_000 } },
            agents: {
              entries: {
                writer: {
                  workspace: workspaceDir,
                  skillsLimits: { maxSkillsPromptChars: 220 },
                },
              },
            },
          },
          agentId: "writer",
        }),
    );

    expect(prompt).toContain("Skills truncated: included 0 of 3");
  });
});

describe("shouldIncludeSkill", () => {
  const envName = "OPENCLAW_TEST_SKILL_REQUIREMENT";
  const entry = makeSkillEntry("env-skill", {
    primaryEnv: envName,
    requires: { env: [envName] },
  });

  function shouldInclude(config?: OpenClawConfig): boolean {
    return shouldIncludeSkill({ entry, config, bundledAllowlist: undefined });
  }

  it("requires non-blank host and configured env values", () => {
    withClearedEnv([envName], () => {
      expect(shouldInclude()).toBe(false);

      process.env[envName] = "   ";
      expect(shouldInclude()).toBe(false);

      process.env[envName] = " example ";
      expect(shouldInclude()).toBe(true);

      delete process.env[envName];
      expect(
        shouldInclude({ skills: { entries: { "env-skill": { env: { [envName]: "   " } } } } }),
      ).toBe(false);
      expect(
        shouldInclude({
          skills: { entries: { "env-skill": { env: { [envName]: " example " } } } },
        }),
      ).toBe(true);
    });
  });
});

describe("applySkillEnvOverrides", () => {
  const skillName = "env-skill";
  const entries = envSkillEntries(skillName, {
    primaryEnv: "ENV_KEY",
    requires: { env: ["ENV_KEY"] },
  });
  it("skips only the skill whose configured secret is unavailable", () => {
    const unavailable = envSkillEntries("cold-skill", {
      primaryEnv: "COLD_SKILL_KEY",
      requires: { env: ["COLD_SKILL_KEY"] },
    });
    const healthy = envSkillEntries("healthy-skill", {
      primaryEnv: "HEALTHY_SKILL_KEY",
      requires: { env: ["HEALTHY_SKILL_KEY"] },
    });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:cold-skill",
        state: "unavailable",
        paths: ["skills.entries.cold-skill.apiKey"],
        refKeys: ["env:default:MISSING_SKILL_KEY"],
        reason: "secret provider failed",
      },
    ]);

    withClearedEnv(["COLD_SKILL_KEY", "HEALTHY_SKILL_KEY"], () => {
      const restore = applySkillEnvOverrides({
        skills: [...unavailable, ...healthy],
        config: {
          skills: {
            entries: {
              "cold-skill": {
                apiKey: { source: "env", provider: "default", id: "MISSING_SKILL_KEY" },
              },
              "healthy-skill": { apiKey: "healthy" }, // pragma: allowlist secret
            },
          },
        },
      });

      checkOverrides(restore, () =>
        expectEnv({ COLD_SKILL_KEY: undefined, HEALTHY_SKILL_KEY: "healthy" }),
      );
    });
  });

  it("keeps env keys tracked until all overlapping overrides restore", () => {
    withClearedEnv(["ENV_KEY"], () => {
      const config = { skills: { entries: { "env-skill": { [apiKeyField]: "injected" } } } }; // pragma: allowlist secret
      const restoreFirst = applySkillEnvOverrides({ skills: entries, config });
      const restoreSecond = applySkillEnvOverrides({ skills: entries, config });

      try {
        expect(process.env.ENV_KEY).toBe("injected");
        expect(getActiveSkillEnvKeysCore().has("ENV_KEY")).toBe(true);

        restoreFirst();
        expect(process.env.ENV_KEY).toBe("injected");
        expect(getActiveSkillEnvKeysCore().has("ENV_KEY")).toBe(true);
      } finally {
        restoreSecond();
        expect(process.env.ENV_KEY).toBeUndefined();
        expect(getActiveSkillEnvKeysCore().has("ENV_KEY")).toBe(false);
      }
    });
  });

  it("skips disabled snapshot skills before resolving raw apiKey SecretRefs", () => {
    const snapshot: SkillSnapshot = {
      prompt: "",
      skills: [{ name: skillName, primaryEnv: "ENV_KEY", requiredEnv: ["ENV_KEY"] }],
    };
    const config = skillConfig(skillName, {
      enabled: false,
      apiKey: { source: "env", provider: "default", id: "GITHUB_PAT" },
    });

    withClearedEnv(["ENV_KEY", "GITHUB_PAT"], () => {
      const check = () => {
        expect(process.env.ENV_KEY).toBeUndefined();
        expect(process.env.GITHUB_PAT).toBeUndefined();
      };
      checkOverrides(applySkillEnvOverridesFromSnapshot({ snapshot, config }), check, check);
    });
  });

  it.each(["runtime", "caller"] as const)(
    "prefers resolved %s skill config over raw SecretRefs",
    (resolved) => {
      const sourceConfig = rawSkillApiKeyRefConfig(skillName);
      const resolvedConfig = skillConfig(skillName, { apiKey: "resolved-key" });
      setRuntimeConfigSnapshot(
        resolved === "runtime" ? resolvedConfig : sourceConfig,
        sourceConfig,
      );

      withClearedEnv(["ENV_KEY"], () => {
        checkOverrides(
          applySkillEnvOverrides({
            skills: entries,
            config: resolved === "runtime" ? sourceConfig : resolvedConfig,
          }),
          () => expect(process.env.ENV_KEY).toBe("resolved-key"),
          () => expect(process.env.ENV_KEY).toBeUndefined(),
        );
      });
    },
  );

  it("does not resolve raw skill apiKey refs when the host already provides primaryEnv", () => {
    withClearedEnv(["ENV_KEY"], () => {
      process.env.ENV_KEY = "host-key";
      const restore = applySkillEnvOverrides({
        skills: entries,
        config: skillConfig("env-skill", {
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        }),
      });

      const check = () => expect(process.env.ENV_KEY).toBe("host-key");
      checkOverrides(restore, check, check);
    });
  });

  it.each<{ kind: string; env: Record<string, string> }>([
    { kind: "unsafe", env: { NODE_OPTIONS: "--require /tmp/evil.js" } },
    {
      kind: "dangerous host",
      env: {
        BASH_ENV: "/tmp/pwn.sh",
        SHELL: "/tmp/evil-shell",
        NODE_REDIRECT_WARNINGS: "/tmp/node-warnings.log",
        NODE_REPL_EXTERNAL_MODULE: "/tmp/pwn.js",
        NODE_REPL_HISTORY: "/tmp/node-repl-history",
        NODE_V8_COVERAGE: "/tmp/coverage",
      },
    },
    {
      kind: "override-only host",
      env: {
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        DOCKER_HOST: "tcp://docker.example.test:2376",
      },
    },
  ])("blocks $kind env overrides even when declared, but allows secrets", ({ env }) => {
    const blocked = Object.fromEntries(Object.keys(env).map((key) => [key, undefined]));
    const keys = ["OPENAI_API_KEY", ...Object.keys(env)];
    withClearedEnv(keys, () => {
      checkOverrides(
        applySkillEnvOverrides({
          skills: envSkillEntries("unsafe-env-skill", {
            primaryEnv: "OPENAI_API_KEY",
            requires: { env: keys },
          }),
          config: skillConfig("unsafe-env-skill", {
            env: { ...env, OPENAI_API_KEY: "sk-test" }, // pragma: allowlist secret
          }),
        }),
        () => expectEnv({ ...blocked, OPENAI_API_KEY: "sk-test" }),
        () => expectEnv({ ...blocked, OPENAI_API_KEY: undefined }),
      );
    });
  });
});
