// Skill loading tests cover bundled, plugin, and workspace skill resolution.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { listReservedChatSlashCommandNames } from "../discovery/chat-command-invocation.js";
import { buildWorkspaceSkillCommandSpecs } from "../discovery/command-specs.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  getActiveSkillEnvKeysCore,
} from "../runtime/env-overrides.js";
import { writeSkill, writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import type { SkillEntry, SkillSnapshot } from "../types.js";
import { shouldIncludeSkill } from "./config.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const fixtureSuite = createFixtureSuite("openclaw-skills-suite-");
let tempHome: TempHomeEnv | null = null;
let skillsHomeEnv: SkillsHomeEnvSnapshot | null = null;
const pluginEnvSnapshot = captureEnv(["OPENCLAW_DISABLE_BUNDLED_PLUGINS"]);

const resolveTestSkillDirs = (workspaceDir: string) => ({
  config: { plugins: { enabled: false } },
  managedSkillsDir: path.join(workspaceDir, ".managed"),
  bundledSkillsDir: path.join(workspaceDir, ".bundled"),
});

const makeWorkspace = async () => await fixtureSuite.createCaseDir("workspace");
const buildWorkspaceSkillsPrompt = async (
  workspaceDir: string,
  opts?: Parameters<typeof buildSkillSnapshot>[1],
): Promise<string> => (await buildSkillSnapshot(workspaceDir, opts)).prompt;
const apiKeyField = ["api", "Key"].join("");

function withWorkspaceHome<T>(workspaceDir: string, cb: () => T): T {
  return withPathResolutionEnv(workspaceDir, { PATH: "" }, () => cb());
}

async function writePromptLimitSkills(workspaceDir: string) {
  for (const name of ["alpha-skill", "beta-skill", "gamma-skill"]) {
    await writeSkill({
      dir: path.join(workspaceDir, "skills", name),
      name,
      description: "D".repeat(240),
    });
  }
}

const withClearedEnv = <T>(keys: string[], run: () => T): T =>
  withEnv(Object.fromEntries(keys.map((key) => [key, undefined])), run);

function makeSkillEntry(name: string, metadata: SkillEntry["metadata"]): SkillEntry {
  const baseDir = `/virtual/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return {
    skill: {
      name,
      description: "Needs env",
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

const keyedSkill = (name = "env-skill", key = "ENV_KEY") =>
  envSkillEntries(name, { primaryEnv: key, requires: { env: [key] } });

function envSkillSnapshot(name: string, metadata: SkillEntry["metadata"]): SkillSnapshot {
  return {
    prompt: "",
    skills: [
      {
        name,
        primaryEnv: metadata?.primaryEnv,
        requiredEnv: metadata?.requires?.env,
      },
    ],
  };
}

function skillConfig(
  name: string,
  entry: NonNullable<NonNullable<OpenClawConfig["skills"]>["entries"]>[string],
): OpenClawConfig {
  return { skills: { entries: { [name]: entry } } };
}

function expectOverride(
  apply: () => () => void,
  active: Record<string, string | undefined>,
  restored: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(active).map((key) => [key, undefined]),
  ),
) {
  const check = (values: Record<string, string | undefined>) =>
    expect(Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))).toEqual(
      values,
    );
  const restore = apply();
  try {
    check(active);
  } finally {
    restore();
    check(restored);
  }
}

beforeAll(async () => {
  await fixtureSuite.setup();
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  tempHome = await createTempHomeEnv("openclaw-skills-home-");
  skillsHomeEnv = setMockSkillsHomeEnv(tempHome.home);
  await fs.mkdir(path.join(tempHome.home, ".openclaw", "agents", "main", "sessions"), {
    recursive: true,
  });
});

afterAll(async () => {
  if (skillsHomeEnv) {
    await restoreMockSkillsHomeEnv(skillsHomeEnv);
    skillsHomeEnv = null;
  }
  if (tempHome) {
    await tempHome.restore();
    tempHome = null;
  }
  pluginEnvSnapshot.restore();
  await fixtureSuite.cleanup();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  setActiveDegradedSecretOwners([]);
});

describe("buildWorkspaceSkillCommandSpecs", () => {
  it("moves a colliding dashboard skill to dashboard_2", async () => {
    const workspaceDir = await makeWorkspace();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "dashboard"),
      name: "dashboard",
      description: "Custom command skill",
    });

    const [command] = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillCommandSpecs(workspaceDir, {
        ...resolveTestSkillDirs(workspaceDir),
        reservedNames: listReservedChatSlashCommandNames(),
      }),
    );

    expect(command).toMatchObject({ name: "dashboard_2", skillName: "dashboard" });
  });

  it("preserves descriptions and tool-dispatch metadata", async () => {
    const workspaceDir = await makeWorkspace();
    const longDescription = "Description ".repeat(12);
    await writeWorkspaceSkills(workspaceDir, [
      { name: "long-desc", description: longDescription },
      {
        name: "short-desc",
        description: "Short description",
        body: "# Short Description\n",
      },
      {
        name: "tool-dispatch",
        description: "Dispatch to a tool",
        frontmatterExtra: "command-dispatch: tool\ncommand-tool: sessions_send",
      },
    ]);

    const commands = buildWorkspaceSkillCommandSpecs(
      workspaceDir,
      resolveTestSkillDirs(workspaceDir),
    );

    const longCmd = commands.find((entry) => entry.skillName === "long-desc");
    const shortCmd = commands.find((entry) => entry.skillName === "short-desc");
    const cmd = commands.find((entry) => entry.skillName === "tool-dispatch");

    expect(longCmd?.description).toBe(longDescription);
    expect(shortCmd).toMatchObject({
      displayName: "Short Description",
      description: "Short description",
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
    await writePromptLimitSkills(workspaceDir);

    const prompt = await withEnvAsync(
      createPathResolutionEnv(workspaceDir, { PATH: "" }),
      async () =>
        await buildWorkspaceSkillsPrompt(workspaceDir, {
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
  it("skips only the skill whose configured secret is unavailable", () => {
    const unavailable = keyedSkill("cold-skill", "COLD_SKILL_KEY");
    const healthy = keyedSkill("healthy-skill", "HEALTHY_SKILL_KEY");
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

      try {
        expect(process.env.COLD_SKILL_KEY).toBeUndefined();
        expect(process.env.HEALTHY_SKILL_KEY).toBe("healthy");
      } finally {
        restore();
      }
    });
  });

  it("keeps env keys tracked until all overlapping overrides restore", () => {
    const entries = keyedSkill("env-skill", "ENV_KEY");

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
    const skillName = "env-skill";
    const snapshot = envSkillSnapshot(skillName, {
      primaryEnv: "ENV_KEY",
      requires: { env: ["ENV_KEY"] },
    });
    const config = skillConfig(skillName, {
      enabled: false,
      apiKey: { source: "env", provider: "default", id: "GITHUB_PAT" },
    });

    withClearedEnv(["ENV_KEY", "GITHUB_PAT"], () => {
      expectOverride(() => applySkillEnvOverridesFromSnapshot({ snapshot, config }), {
        ENV_KEY: undefined,
        GITHUB_PAT: undefined,
      });
    });
  });

  it.each(["runtime", "caller"] as const)(
    "prefers resolved %s config over raw SecretRefs",
    (resolvedAt) => {
      const skillName = "env-skill";
      const entries = keyedSkill(skillName);
      const sourceConfig = skillConfig(skillName, {
        apiKey: { source: "file", provider: "default", id: `/skills/entries/${skillName}/apiKey` },
      });
      const resolved = skillConfig(skillName, { apiKey: "resolved-key" }); // pragma: allowlist secret
      setRuntimeConfigSnapshot(resolvedAt === "runtime" ? resolved : sourceConfig, sourceConfig);

      withClearedEnv(["ENV_KEY"], () => {
        expectOverride(
          () =>
            applySkillEnvOverrides({
              skills: entries,
              config: resolvedAt === "runtime" ? sourceConfig : resolved,
            }),
          { ENV_KEY: "resolved-key" },
        );
      });
    },
  );

  it("does not resolve raw skill apiKey refs when the host already provides primaryEnv", () => {
    const entries = keyedSkill("env-skill", "ENV_KEY");

    withClearedEnv(["ENV_KEY"], () => {
      process.env.ENV_KEY = "host-key";
      expectOverride(
        () =>
          applySkillEnvOverrides({
            skills: entries,
            config: skillConfig("env-skill", {
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            }),
          }),
        { ENV_KEY: "host-key" },
        { ENV_KEY: "host-key" },
      );
      delete process.env.ENV_KEY;
    });
  });

  it("blocks unsafe env overrides but allows declared secrets", () => {
    const entries = envSkillEntries("unsafe-env-skill", {
      primaryEnv: "OPENAI_API_KEY",
      requires: { env: ["OPENAI_API_KEY", "NODE_OPTIONS"] },
    });

    withClearedEnv(["OPENAI_API_KEY", "NODE_OPTIONS"], () => {
      expectOverride(
        () =>
          applySkillEnvOverrides({
            skills: entries,
            config: skillConfig("unsafe-env-skill", {
              env: {
                OPENAI_API_KEY: "sk-test", // pragma: allowlist secret
                NODE_OPTIONS: "--require /tmp/evil.js",
              },
            }),
          }),
        { OPENAI_API_KEY: "sk-test", NODE_OPTIONS: undefined },
      );
    });
  });

  it.each<{ name: string; env: Record<string, string> }>([
    {
      name: "dangerous",
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
      name: "override-only",
      env: {
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        DOCKER_HOST: "tcp://docker.example.test:2376",
      },
    },
  ])("blocks $name host env overrides even when declared", ({ name, env }) => {
    const keys = Object.keys(env);
    const skillName = `${name}-env-skill`;
    const entries = envSkillEntries(skillName, { requires: { env: keys } });
    withClearedEnv(keys, () => {
      expectOverride(
        () =>
          applySkillEnvOverrides({
            skills: entries,
            config: skillConfig(skillName, { env }),
          }),
        Object.fromEntries(keys.map((key) => [key, undefined])),
      );
    });
  });
});
