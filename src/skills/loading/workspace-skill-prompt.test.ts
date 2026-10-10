// Workspace skill prompt tests cover catalog budgets, ordering, and compact paths.
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import {
  formatSkillsCompactForPrompt as formatSkillsCompact,
  formatSkillsForPromptCore,
  type Skill,
} from "./skill-contract.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const buildWorkspaceSkillsPrompt = async (
  workspaceDir: string,
  opts?: Parameters<typeof buildSkillSnapshot>[1],
): Promise<string> => (await buildSkillSnapshot(workspaceDir, opts)).prompt;

function makeSkill(name: string, desc = "A skill", filePath = `/skills/${name}/SKILL.md`): Skill {
  return createCanonicalFixtureSkill({
    name,
    description: desc,
    filePath,
    baseDir: `/skills/${name}`,
    source: "workspace",
  });
}

function makeEntry(skill: Skill): SkillEntry {
  return {
    skill,
    frontmatter: {},
    exposure: {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: true,
      userInvocable: true,
    },
  };
}

async function buildPrompt(
  skills: Skill[],
  limits: { maxChars?: number; maxCount?: number } = {},
): Promise<string> {
  return await buildWorkspaceSkillsPrompt("/fake", {
    entries: skills.map(makeEntry),
    config: {
      skills: {
        limits: {
          ...(limits.maxChars !== undefined && { maxSkillsPromptChars: limits.maxChars }),
          ...(limits.maxCount !== undefined && { maxSkillsInPrompt: limits.maxCount }),
        },
      },
    } satisfies OpenClawConfig,
  });
}

const COMPACT_SHORTENED_NOTICE =
  "⚠️ Skills catalog using compact format (descriptions shortened). Run `openclaw skills check` to audit.";

describe("applySkillsPromptLimits (via buildWorkspaceSkillsPrompt)", () => {
  let envSnapshot: SkillsHomeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = setMockSkillsHomeEnv("/Users/openclaw-test-user");
  });

  afterEach(() => restoreMockSkillsHomeEnv(envSnapshot));

  it("keeps eligible discovery independent from the prompt budget and hidden skills", async () => {
    const visible = makeSkill("alpha");
    const omitted = makeSkill("zulu");
    const hidden = makeEntry(makeSkill("hidden"));
    hidden.exposure = {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: false,
      userInvocable: true,
    };
    const snapshot = await buildSkillSnapshot("/fake", {
      entries: [makeEntry(visible), makeEntry(omitted), hidden],
      config: { skills: { limits: { maxSkillsInPrompt: 1 } } },
    });

    expect(snapshot.resolvedSkills).toEqual([visible]);
    expect(snapshot.discoverySkills).toEqual([visible, omitted]);
    expect(snapshot.prompt).toContain("<name>alpha</name>");
    expect(snapshot.prompt).not.toContain("<name>zulu</name>");
    expect(snapshot.prompt).not.toContain("<name>hidden</name>");
    expect(snapshot.skills.map((skill) => skill.name)).toContain("hidden");
  });

  it("count truncation + compact: shows included X of Y with compact note", async () => {
    // 30 skills but maxCount=10, and full format of 10 exceeds budget
    const skills = Array.from({ length: 30 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const tenSkills = skills.slice(0, 10);
    const fullLen = formatSkillsForPromptCore(tenSkills).length;
    const truncatedNotice =
      "⚠️ Skills truncated: included 10 of 30 (compact format, descriptions shortened). Run `openclaw skills check` to audit.";
    const budget = `${truncatedNotice}\n${formatSkillsCompact(tenSkills)}`.length;
    // Verify precondition: full format of 10 skills exceeds budget
    expect(fullLen).toBeGreaterThan(budget);
    const prompt = await buildPrompt(skills, { maxChars: budget, maxCount: 10 });
    // Count-truncated (30→10) AND compact (full format of 10 exceeds budget)
    expect(prompt).toContain("included 10 of 30");
    expect(prompt).toContain("compact format, descriptions shortened");
    expect(prompt).toContain("<description>");
  });

  it.each([64])("never exceeds a tiny configured prompt budget of %i", async (maxChars) => {
    const prompt = await buildPrompt([makeSkill("only-one", "desc")], { maxChars });

    expect(prompt.length).toBeLessThanOrEqual(maxChars);
    expect(prompt).toBe("");
  });

  it.each(["compact", "empty"])(
    "preserves exact %s catalog bytes at the optional remote-note boundary",
    async (format) => {
      const skill = makeSkill(
        "weather",
        format === "compact" ? "A".repeat(800) : "Get weather data",
      );
      const skills = format === "empty" ? [] : [skill];
      const remoteNote = "Remote node skills are available.";
      const notice = format === "compact" ? COMPACT_SHORTENED_NOTICE : "";
      const catalog =
        format === "compact" ? formatSkillsCompact(skills) : formatSkillsForPromptCore(skills);
      const withoutNote = [notice, catalog].filter(Boolean).join("\n");
      const withNote = [remoteNote, withoutNote].filter(Boolean).join("\n");
      const entries = skills.map(makeEntry);

      for (const delta of [-1, 0, 1]) {
        const prompt = await buildWorkspaceSkillsPrompt("/fake", {
          entries,
          config: {
            skills: {
              limits: { maxSkillsInPrompt: 1, maxSkillsPromptChars: withNote.length + delta },
            },
          } satisfies OpenClawConfig,
          eligibility: {
            remote: {
              platforms: ["linux"],
              hasBin: () => false,
              hasAnyBin: () => false,
              note: remoteNote,
            },
          },
        });

        expect(prompt).toBe(delta < 0 ? withoutNote : withNote);
        expect(prompt.length).toBeLessThanOrEqual(withNote.length + delta);
      }
    },
  );
});

describe("compactSkillPaths", () => {
  async function buildPromptForFixtureSkill(params: {
    workspaceRoot: string;
    skillDir: string;
    name: string;
    description: string;
  }) {
    return await buildWorkspaceSkillsPrompt(params.workspaceRoot, {
      entries: [
        {
          skill: createCanonicalFixtureSkill({
            name: params.name,
            description: params.description,
            filePath: path.join(params.skillDir, "SKILL.md"),
            baseDir: params.skillDir,
            source: "test",
          }),
          frontmatter: {},
          metadata: undefined,
          invocation: { disableModelInvocation: false, userInvocable: true },
          exposure: {
            includeInRuntimeRegistry: true,
            includeInAvailableSkillsPrompt: true,
            userInvocable: true,
          },
        },
      ],
    });
  }

  it("does not compact explicit state-root managed skill paths to OS-home tilde paths", async () => {
    const root = path.parse(os.homedir()).root;
    const osHome = path.join(root, "data");
    const stateDir = path.join(osHome, ".openclaw");
    const skillDir = path.join(stateDir, "skills", "world-cup-soccer-openclaw-skill");
    const skillFile = path.join(skillDir, "SKILL.md");

    const prompt = await withEnvAsync(
      {
        HOME: osHome,
        OPENCLAW_HOME: osHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () =>
        await buildPromptForFixtureSkill({
          workspaceRoot: path.join(root, "workspace"),
          skillDir,
          name: "world-cup-soccer-openclaw-skill",
          description: "World Cup standings lookup",
        }),
    );

    expect(prompt).toContain(`<location>${skillFile}</location>`);
    expect(prompt).not.toContain("~/.openclaw/skills/world-cup-soccer-openclaw-skill/SKILL.md");
  });
});
