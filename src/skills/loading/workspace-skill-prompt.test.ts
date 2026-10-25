import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { createCanonicalFixtureSkill, makeSkill } from "../test-support/test-helpers.js";
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
  return buildWorkspaceSkillsPrompt("/fake", {
    entries: skills.map(makeEntry),
    config: {
      skills: {
        limits: {
          maxSkillsPromptChars: limits.maxChars,
          maxSkillsInPrompt: limits.maxCount,
        },
      },
    },
  });
}

function requireIncludedCounts(prompt: string): [included: number, total: number] {
  const match = prompt.match(/included (\d+) of (\d+)/);
  if (!match) {
    throw new Error(`expected included count in prompt: ${prompt}`);
  }
  return [Number(match[1]), Number(match[2])];
}

const COMPACT_OMITTED_NOTICE =
  "⚠️ Skills catalog using compact format (descriptions omitted). Run `openclaw skills check` to audit.";
const COMPACT_SHORTENED_NOTICE =
  "⚠️ Skills catalog using compact format (descriptions shortened). Run `openclaw skills check` to audit.";
const manySkills = (count: number) =>
  Array.from({ length: count }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));

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
    hidden.exposure!.includeInAvailableSkillsPrompt = false;
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

  it.each(["compact", "identities", "partial", "count"] as const)(
    "fits the %s catalog without sacrificing admitted identities",
    async (mode) => {
      const size = { compact: 20, identities: 50, partial: 8, count: 30 }[mode];
      const admitted = mode === "count" ? 10 : size;
      const skills = manySkills(size);
      const shortened = mode !== "identities";
      const notice =
        mode === "count"
          ? "⚠️ Skills truncated: included 10 of 30 (compact format, descriptions shortened). Run `openclaw skills check` to audit."
          : shortened
            ? COMPACT_SHORTENED_NOTICE
            : COMPACT_OMITTED_NOTICE;
      const budget =
        mode === "partial"
          ? `${COMPACT_OMITTED_NOTICE}\n${formatSkillsCompact(skills, { descriptionMaxChars: 0 })}`
              .length + 500
          : `${notice}\n${formatSkillsCompact(
              skills.slice(0, admitted),
              shortened ? undefined : { descriptionMaxChars: 0 },
            )}`.length;
      const prompt = await buildPrompt(skills, { maxChars: budget, maxCount: admitted });
      expect(prompt.length).toBeLessThanOrEqual(budget);
      expect(prompt).toContain(notice);
      expect(prompt.includes("<description>")).toBe(shortened);
      expect(prompt.includes("included")).toBe(mode === "count");
      expect(prompt.match(/<skill>/g)).toHaveLength(admitted);
    },
  );

  it("tier 3: compact + binary search when compact also exceeds budget", async () => {
    const skills = Array.from({ length: 100 }, (_, i) => makeSkill(`skill-${i}`, "description"));
    const prompt = await buildPrompt(skills, { maxChars: 2000 });
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(prompt).toContain("compact format");
    expect(prompt).toContain("skill-0");
    const [included, total] = requireIncludedCounts(prompt);
    expect(included).toBeLessThan(total);
    expect(total).toBe(skills.length);
    expect(prompt.match(/<skill>/g)?.length ?? 0).toBe(included);
  });

  it.each([0, 1, 10, 64])(
    "never exceeds a tiny configured prompt budget of %i",
    async (maxChars) => {
      const prompt = await buildPrompt([makeSkill("only-one", "desc")], { maxChars });

      expect(prompt.length).toBeLessThanOrEqual(maxChars);
      expect(prompt).toBe("");
    },
  );

  it.each(["full", "compact", "count-limited", "empty"])(
    "preserves exact %s catalog bytes at the optional remote-note boundary",
    async (format) => {
      const skill = makeSkill(
        "weather",
        format === "compact" ? "A".repeat(800) : "Get weather data",
      );
      const skills = format === "empty" ? [] : [skill];
      const remoteNote = "Remote node skills are available.";
      const notice =
        format === "compact"
          ? COMPACT_SHORTENED_NOTICE
          : format === "count-limited"
            ? "⚠️ Skills truncated: included 1 of 2. Run `openclaw skills check` to audit."
            : "";
      const catalog =
        format === "compact" ? formatSkillsCompact(skills) : formatSkillsForPromptCore(skills);
      const withoutNote = [notice, catalog].filter(Boolean).join("\n");
      const withNote = [remoteNote, withoutNote].filter(Boolean).join("\n");
      const entries = (format === "count-limited" ? [...skills, makeSkill("zoo")] : skills).map(
        makeEntry,
      );

      for (const delta of [-1, 0, 1]) {
        const prompt = await buildWorkspaceSkillsPrompt("/fake", {
          entries,
          config: {
            skills: {
              limits: { maxSkillsInPrompt: 1, maxSkillsPromptChars: withNote.length + delta },
            },
          },
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

  it("budget check uses compacted home-dir paths, not canonical paths", async () => {
    const home = os.homedir();
    const skills = Array.from({ length: 30 }, (_, i) =>
      makeSkill(
        `skill-${i}`,
        "A".repeat(800),
        `${home}/.openclaw/workspace/skills/skill-${i}/SKILL.md`,
      ),
    );
    const compactedSkills = skills.map((s) => ({
      ...s,
      filePath: s.filePath.replace(home, "~"),
    }));
    const compactedCompactLen = formatSkillsCompact(compactedSkills, {
      descriptionMaxChars: 0,
    }).length;
    const canonicalCompactLen = formatSkillsCompact(skills, { descriptionMaxChars: 0 }).length;
    expect(canonicalCompactLen).toBeGreaterThan(compactedCompactLen);
    const budget =
      Math.floor((compactedCompactLen + canonicalCompactLen) / 2) +
      COMPACT_OMITTED_NOTICE.length +
      1;
    const prompt = await buildPrompt(skills, { maxChars: budget });
    expect(prompt).toContain("skill-0");
    expect(prompt).toContain("skill-29");
    expect(prompt).not.toContain("included");
    expect(prompt).toContain("compact format");
    expect(prompt).toContain("~/");
    expect(prompt).not.toContain(home);
  });

  it("skills are sorted alphabetically regardless of entry insertion order", async () => {
    // Regression: #64167.
    const entries = ["zoo", "apple", "mango", "banana"].map((n) =>
      makeEntry(makeSkill(n, `${n} skill`)),
    );
    const prompt = await buildWorkspaceSkillsPrompt("/fake", {
      entries,
      config: { skills: { limits: { maxSkillsPromptChars: 50_000 } } },
    });
    const nameMatches = [...prompt.matchAll(/<name>(\w+)<\/name>/g)].map((m) => m[1]);
    expect(nameMatches).toEqual(["apple", "banana", "mango", "zoo"]);
  });

  it("resolvedSkills in snapshot keeps canonical paths, not compacted", async () => {
    const home = os.homedir();
    const skills = Array.from({ length: 5 }, (_, i) =>
      makeSkill(`skill-${i}`, "A skill", `${home}/.openclaw/workspace/skills/skill-${i}/SKILL.md`),
    );
    const snapshot = await buildSkillSnapshot("/fake", {
      entries: skills.map(makeEntry),
    });
    expect(snapshot.prompt).toContain("~/");
    expect(snapshot.resolvedSkills).toHaveLength(5);
    for (const skill of snapshot.resolvedSkills ?? []) {
      expect(skill.filePath).toContain(home);
      expect(skill.filePath).not.toMatch(/^~\//);
    }
  });
});

describe("compactSkillPaths", () => {
  const promptAt = (
    workspace: string,
    dir: string,
    name = "test-skill",
    description = "A test skill",
  ) =>
    buildWorkspaceSkillsPrompt(workspace, {
      entries: [
        makeEntry(
          createCanonicalFixtureSkill({
            name,
            description,
            filePath: path.join(dir, "SKILL.md"),
            baseDir: dir,
            source: "test",
          }),
        ),
      ],
    });

  it("refreshes home prefixes for each prompt catalog", async () => {
    for (const name of ["first-home", "second-home"]) {
      const home = path.join(path.parse(os.homedir()).root, "openclaw-compact-test", name);
      const prompt = await withEnvAsync({ HOME: home, OPENCLAW_HOME: undefined }, () =>
        promptAt(home, path.join(home, "skills", "dynamic-home"), "dynamic-home"),
      );
      expect(prompt).toContain("<location>~/skills/dynamic-home/SKILL.md</location>");
      expect(prompt).not.toContain(home);
    }
  });

  it.each(["skills", "plugin-skills"])(
    "does not compact explicit state-root %s paths to OS-home tilde paths",
    async (folder) => {
      const root = path.parse(os.homedir()).root;
      const home = path.join(root, "data");
      const state = path.join(home, ".openclaw");
      const dir = path.join(state, folder, "test-skill");
      const prompt = await withEnvAsync(
        {
          HOME: home,
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
        },
        () => promptAt(path.join(root, "workspace"), dir),
      );
      expect(prompt).toContain(`<location>${path.join(dir, "SKILL.md")}</location>`);
      expect(prompt).not.toContain(`~/.openclaw/${folder}/test-skill/SKILL.md`);
    },
  );

  it("compacts managed skill paths when OS-home tilde reaches the same path", async () => {
    const home = os.homedir();
    const state = path.join(home, ".openclaw");
    const dir = path.join(state, "skills", "test-skill");
    const prompt = await withEnvAsync(
      {
        HOME: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_HOME: undefined,
      },
      () => promptAt(path.join(home, "workspace"), dir),
    );
    expect(prompt).toContain("<location>~/.openclaw/skills/test-skill/SKILL.md</location>");
    expect(prompt).not.toContain(`<location>${path.join(dir, "SKILL.md")}</location>`);
  });

  it("preserves POSIX literal backslashes after home compaction", async () => {
    const home = os.homedir();
    const prompt = await promptAt(home, path.join(home, ".openclaw-test-skills\\literal-skill"));
    const location = prompt.match(/<location>([^<]+)<\/location>/)?.[1];
    expect(location).toContain("~/");
    expect(location).toContain("\\literal-skill");
  });
});
