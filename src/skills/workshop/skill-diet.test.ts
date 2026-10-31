import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { listWorkshopChanges, restoreWorkshopSkill, viewWorkshopSkill } from "./library.js";
import { runWorkshopSkillDiet, type SkillDietComplete } from "./skill-diet.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

let state: OpenClawTestState;
const DAY_MS = 24 * 60 * 60_000;
const NOW_MS = Date.UTC(2026, 9, 29, 12);
const FRONTMATTER = "---\nname: deploy\ndescription: Deploy staging builds\n---\n";
const filler = (label: string, bytes: number) =>
  `${label}: ${"Keep the staging lane exact before each supported release. ".repeat(Math.ceil(bytes / 60)).trimEnd()}`;
const ROLLBACK = [
  "## Rollback",
  "",
  "Use [checks](references/checks.md#verify) and the [peer skill](../peer/SKILL.md).",
  filler("rollback", 3000),
].join("\n");
const RARE = ["## Rare case", "", "```sh", "## not a heading", "```", filler("rare", 3000)].join(
  "\n",
);
const LIVE = `${FRONTMATTER}\n# Deploy\n\n## Procedure\n\n1. Build only from the exact tag.\n${filler("procedure", 7000)}\n\n${ROLLBACK}\n\n${RARE}\n`;
const SLIM = [
  "# Deploy",
  "",
  "## Procedure",
  "",
  "1. Build only from the exact tag.",
  "",
  "## Look up the case",
  "",
  "- Rolling back, rare hosts → [branches](references/branches.md)",
].join("\n");
const PLAN = JSON.stringify({
  skill: SLIM,
  references: [
    {
      file: "references/branches.md",
      title: "Deploy branches",
      readWhen: "Read when rolling back or on a rare host.",
      sections: ["Rollback", "## Rare case"],
    },
  ],
});
const clean = JSON.stringify({ findings: [] });
const finding = JSON.stringify({
  findings: [{ rule: "Build only from the exact tag", problem: "weakened", detail: "exact" }],
});

const skillPath = (...parts: string[]) => path.join(resolveWorkshopSkillsDir({}, "main"), ...parts);
const live = (filePath?: string) => viewWorkshopSkill({}, "main", "deploy", filePath);

/** Answers each diet call by role: rewrite plan, reviewer, or repair. */
function scripted(replies: { plan?: string; audits: string[]; repair?: string }) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const complete: SkillDietComplete = async ({ systemPrompt, prompt }) => {
    const role = systemPrompt.startsWith("You are a strict reviewer")
      ? "audit"
      : systemPrompt.includes("A reviewer found")
        ? "repair"
        : "plan";
    calls.push(role);
    prompts.push(prompt);
    if (role === "audit") {
      return replies.audits.shift() ?? clean;
    }
    return role === "repair"
      ? (replies.repair ?? JSON.stringify({ skill: SLIM }))
      : (replies.plan ?? PLAN);
  };
  return { complete, calls, prompts };
}

const diet = (complete: SkillDietComplete, nowMs = NOW_MS) =>
  runWorkshopSkillDiet({
    config: {},
    agentId: "main",
    nowMs,
    abortSignal: new AbortController().signal,
    complete,
  });

async function seed(content = LIVE, ageMs = 2 * DAY_MS, name = "deploy") {
  for (const [file, text] of [
    ["SKILL.md", content],
    ["references/checks.md", "# Checks\n\n## Verify\n\nVerify the tag.\n"],
  ] as const) {
    await fs.mkdir(path.dirname(skillPath(name, file)), { recursive: true });
    await fs.writeFile(skillPath(name, file), text);
    const at = new Date(NOW_MS - ageMs);
    await fs.utimes(skillPath(name, file), at, at);
  }
  await fs.mkdir(skillPath("peer"), { recursive: true });
  await fs.writeFile(skillPath("peer", "SKILL.md"), "---\nname: peer\ndescription: Peer\n---\n");
}

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  await state.cleanup();
});

it("publishes a reviewed diet as one versioned change that restore fully undoes", async () => {
  await seed();
  const { complete, calls } = scripted({ audits: [clean] });

  const change = await diet(complete);

  expect(calls).toEqual(["plan", "audit"]);
  expect(change).toMatchObject({ actor: "curator", action: "write_file", skillName: "deploy" });
  expect(await listWorkshopChanges("main", { limit: 10 })).toEqual([change]);
  expect(change?.summary).toMatch(/^diet: SKILL\.md \d+\.\d → 0\.\d KB; moved 2 section\(s\)/);
  expect((await live()).content).toBe(`${FRONTMATTER}\n${SLIM}\n`);
  // Moved sections are verbatim, with links re-pointed from the skill root to references/.
  expect((await live("references/branches.md")).content).toBe(
    [
      "# Deploy branches",
      "",
      "Read when rolling back or on a rare host.",
      "",
      ROLLBACK.replace("(references/checks.md#verify)", "(checks.md#verify)").replace(
        "(../peer/SKILL.md)",
        "(../../peer/SKILL.md)",
      ),
      "",
      RARE,
      "",
    ].join("\n"),
  );

  await restoreWorkshopSkill(
    { config: {}, agentId: "main", actor: "user" },
    { name: "deploy", versionId: change?.versionId },
  );
  expect((await live()).content).toBe(LIVE);
  expect((await live()).files).toEqual(["SKILL.md", "references/checks.md"]);
});

it("repairs once on reviewer findings and leaves the skill unchanged when they persist", async () => {
  await seed();
  const repaired = scripted({ audits: [finding, clean] });
  expect(await diet(repaired.complete)).toBeDefined();
  expect(repaired.calls).toEqual(["plan", "audit", "repair", "audit"]);

  await fs.rm(skillPath("deploy"), { recursive: true });
  await seed();
  const stubborn = scripted({ audits: [finding, finding] });
  expect(await diet(stubborn.complete)).toBeUndefined();
  expect(stubborn.calls).toEqual(["plan", "audit", "repair", "audit"]);
  expect((await live()).content).toBe(LIVE);
});

it.each([
  ["an unknown section", PLAN.replace('"## Rare case"', '"Missing"')],
  [
    "an invented link",
    PLAN.replace("references/branches.md)", "references/branches.md) [x](../nowhere.md)"),
  ],
  ["an invented anchor", PLAN.replace("(references/branches.md)", "(references/branches.md#nope)")],
  [
    "an anchor missing from an existing reference",
    PLAN.replace(
      "(references/branches.md)",
      "(references/branches.md) [v](references/checks.md#nope)",
    ),
  ],
  [
    "an in-page link to a moved heading",
    PLAN.replace("from the exact tag.", "from the exact tag; see [rollback](#rollback)."),
  ],
  ["too small a cut", JSON.stringify({ skill: LIVE.slice(FRONTMATTER.length), references: [] })],
  ["a non-JSON reply", "I could not do it."],
])("refuses %s before review and leaves the skill unchanged", async (_label, plan) => {
  await seed();
  const { complete, calls } = scripted({ plan, audits: [] });
  expect(await diet(complete)).toBeUndefined();
  expect(calls).toEqual(["plan"]);
  expect((await live()).content).toBe(LIVE);
  expect(await listWorkshopChanges("main", { limit: 10 })).toEqual([]);
});

it("refuses a move that breaks an existing reference's link into SKILL.md", async () => {
  await seed();
  await fs.writeFile(
    skillPath("deploy", "references/checks.md"),
    "See [rollback](../SKILL.md#rollback).\n",
  );
  const at = new Date(NOW_MS - 2 * DAY_MS);
  await fs.utimes(skillPath("deploy", "references/checks.md"), at, at);
  const { complete, calls } = scripted({ audits: [] });
  expect(await diet(complete)).toBeUndefined();
  expect(calls).toEqual(["plan"]);
  expect((await live()).content).toBe(LIVE);
});

it("refuses to move a section with in-page links", async () => {
  await seed(LIVE.replace("## Rollback\n", "## Rollback\n\nSee [the steps](#procedure).\n"));
  const { complete, calls } = scripted({ audits: [] });
  expect(await diet(complete)).toBeUndefined();
  expect(calls).toEqual(["plan"]);
});

it.each([
  ["a repeated heading", "[second](#verify-1)", true],
  ["a heading inside fenced code", "[fake](#fake)", false],
])("resolves anchors as they render: a link to %s", async (_label, link, publishes) => {
  await seed();
  const skill = [
    SLIM,
    "",
    "### Verify",
    "",
    "One.",
    "",
    "### Verify",
    "",
    `Two; see ${link}.`,
    "",
    "```sh",
    "### Fake",
    "```",
  ].join("\n");
  const { complete, calls } = scripted({
    plan: PLAN.replace(JSON.stringify(SLIM), JSON.stringify(skill)),
    audits: [],
  });
  expect((await diet(complete)) !== undefined).toBe(publishes);
  expect(calls).toEqual(publishes ? ["plan", "audit"] : ["plan"]);
});

it("refuses to move sections of a skill with titled links", async () => {
  const titled = LIVE.replace(
    "(references/checks.md#verify)",
    '(references/checks.md#verify "Checks")',
  );
  await seed(titled);
  const { complete, calls } = scripted({ audits: [] });
  expect(await diet(complete)).toBeUndefined();
  expect(calls).toEqual(["plan"]);
  expect((await live()).content).toBe(titled);
});

it.each([
  ["its SKILL.md changed", "SKILL.md", `${LIVE}\nA new lesson.\n`],
  ["a new reference path was created", "references/branches.md", "# Saved by hand\n"],
  [
    "a support file gained a link into a moved section",
    "references/checks.md",
    "See [rollback](../SKILL.md#rollback).\n",
  ],
])("refuses to publish when %s during the diet", async (_label, file, content) => {
  await seed();
  const { complete, calls } = scripted({ audits: [] });
  const changing: SkillDietComplete = async (request) => {
    const reply = await complete(request);
    if (request.systemPrompt.startsWith("You are a strict reviewer")) {
      await fs.writeFile(skillPath("deploy", file), content);
    }
    return reply;
  };
  expect(await diet(changing)).toBeUndefined();
  expect(calls).toEqual(["plan", "audit"]);
  expect(await listWorkshopChanges("main", { limit: 10 })).toEqual([]);
  expect((await live(file)).content).toBe(content);
});

it("makes no further model call once learning leaves auto mode mid-diet", async () => {
  await seed();
  const { complete, calls } = scripted({ audits: [clean] });
  const revoking: SkillDietComplete = async (request) => {
    const reply = await complete(request);
    setRuntimeConfigSnapshot({ skills: { workshop: { autonomous: { mode: "off" } } } });
    return reply;
  };
  expect(await diet(revoking)).toBeUndefined();
  expect(calls).toEqual(["plan"]);
  expect((await live()).content).toBe(LIVE);
  expect(await listWorkshopChanges("main", { limit: 10 })).toEqual([]);
});

it("diets only oversized, settled skills and rotates rejected candidates by day", async () => {
  const small = `${FRONTMATTER}\n# Deploy\n\nBuild only from the exact tag.\n`;
  const { complete, calls, prompts } = scripted({ plan: "I could not do it.", audits: [] });
  for (const [content, ageMs] of [
    [small, 2 * DAY_MS],
    [LIVE, DAY_MS / 2],
  ] as const) {
    await seed(content, ageMs);
    expect(await diet(complete)).toBeUndefined();
    expect(calls).toEqual([]);
    expect(await live()).toMatchObject({ content, files: ["SKILL.md", "references/checks.md"] });
    expect(await listWorkshopChanges("main", { limit: 10 })).toEqual([]);
  }

  // Rejected diets keep both candidates eligible, so the selected names must really rotate.
  const other = LIVE.replace("name: deploy", "name: other");
  await seed();
  await seed(other, 2 * DAY_MS, "other");
  for (const at of [NOW_MS, NOW_MS + DAY_MS]) {
    expect(await diet(complete, at)).toBeUndefined();
  }
  expect(calls).toEqual(["plan", "plan"]);
  const selected = prompts.map((prompt) => /^Skill "([^"]+)"/.exec(prompt)?.[1]);
  expect(new Set(selected)).toEqual(new Set(["deploy", "other"]));
  for (const [name, content] of [
    ["deploy", LIVE],
    ["other", other],
  ] as const) {
    const unchanged = await viewWorkshopSkill({}, "main", name);
    expect(unchanged).toMatchObject({ content, files: ["SKILL.md", "references/checks.md"] });
  }
  expect(await listWorkshopChanges("main", { limit: 10 })).toEqual([]);
});
