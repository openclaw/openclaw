import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";
import { skill } from "./skills-cli.test-support.js";

vi.mock("openclaw/plugin-sdk/agent-sessions", () => ({
  loadSkillsFromDir: () => ({ skills: [] }),
  formatSkillsForPrompt: () => "",
}));
function report(skills: SkillStatusEntry[]): SkillStatusReport {
  return { workspaceDir: "/workspace", managedSkillsDir: "/managed", skills };
}
const info = (skills: SkillStatusEntry[], name: string, json = false) =>
  formatSkillInfo(report(skills), name, { json });
function expectContains(output: string, ...parts: string[]) {
  for (const part of parts) {
    expect(output).toContain(part);
  }
}
const missing = { bins: ["missing-tool"], anyBins: [], env: [], config: [], os: [] };

describe("skills formatting", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("preserves the named profile on every human ClawHub hint", () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    const empty = report([]);
    for (const output of [
      formatSkillsList(empty, {}),
      formatSkillInfo(empty, "missing", {}),
      formatSkillsCheck(empty, {}),
    ]) {
      for (const action of ["search", "install", "update"]) {
        expect(output).toContain(`openclaw --profile work skills ${action}`);
      }
    }
  });

  it("renders readiness and filters agent-excluded skills out of the eligible list", () => {
    const mixed = report([
      skill("ready", { emoji: "📸" }),
      skill("agent-excluded", {
        blockedByAgentFilter: true,
        homepage: undefined,
        emoji: undefined,
      }),
      skill("disabled-skill", { disabled: true, eligible: false }),
      skill("needs-stuff", {
        eligible: false,
        missing: { ...missing, anyBins: ["rg", "grep"], env: ["API_KEY"], os: ["darwin"] },
      }),
    ]);
    const output = formatSkillsList(mixed, { verbose: true });
    expectContains(output, "1/4 ready", "📸", "✓", "excluded", "disabled", "needs setup");
    expectContains(output, "anyBins", "os:");
    const detail = formatSkillInfo(mixed, "agent-excluded", {});
    expectContains(detail, "Excluded by agent allowlist", "excludes this skill");
    const eligible = formatSkillsList(mixed, { eligible: true });
    expect(eligible).toContain("ready");
    for (const name of ["agent-excluded", "disabled-skill", "needs-stuff"]) {
      expect(eligible).not.toContain(name);
    }
  });

  it("resolves an unambiguous skill key", () => {
    const entry = skill("Excel XLSX", {
      skillKey: "Excel-XLSX",
      description: "Spreadsheet helpers",
    });
    expect(info([entry], "excel-xlsx")).toContain("Spreadsheet helpers");
  });

  it.each([
    [
      "requested-skill",
      [
        skill("another-skill", { skillKey: "requested-skill" }),
        skill("requested-skill", { skillKey: "target-key" }),
      ],
      { name: "requested-skill" },
    ],
    [
      "shared-key",
      [skill("first", { skillKey: "shared-key" }), skill("second", { skillKey: "shared-key" })],
      { ok: false, skill: "shared-key" },
    ],
  ])("resolves %s consistently in either discovery order", (query, skills, expected) => {
    for (const entries of [skills, skills.toReversed()]) {
      expect(JSON.parse(info(entries, query, true))).toMatchObject(expected);
    }
  });

  it("reports readiness, model visibility and command access independently", () => {
    const filtered = { eligible: false, blockedByAgentFilter: true, missing };
    const mixed = {
      ...report([
        skill("ready", { emoji: "🎛\uFE0E" }),
        skill("prompt-hidden", { modelVisible: false }),
        skill("slash-hidden", { userInvocable: false }),
        skill("agent-filtered", { blockedByAgentFilter: true }),
        skill("excluded-missing", filtered),
        skill("missing-bin", { eligible: false, missing, emoji: "🎙\uFE0E" }),
        skill("disabled", { ...filtered, disabled: true, blockedByAllowlist: true }),
        skill("blocked-bundled", { ...filtered, blockedByAllowlist: true }),
      ]),
      agentId: "specialist",
      agentSkillFilter: ["ready", "prompt-hidden", "slash-hidden", "missing-bin"],
    };
    const parsed = JSON.parse(formatSkillsCheck(mixed, { json: true }));
    expect(parsed).toMatchObject({
      summary: { total: 8, eligible: 4 },
      modelVisible: ["ready", "slash-hidden"],
      commandVisible: ["ready", "prompt-hidden"],
      agentFiltered: ["agent-filtered", "excluded-missing", "disabled", "blocked-bundled"],
      disabled: ["disabled"],
      blocked: ["blocked-bundled"],
      notInjected: [{ name: "prompt-hidden", reason: "disable-model-invocation" }],
    });
    expect(parsed.missingRequirements.map((entry: { name: string }) => entry.name)).toEqual([
      "excluded-missing",
      "missing-bin",
    ]);
    const human = formatSkillsCheck(mixed, {});
    expectContains(
      human,
      "specialist",
      "🎛️ ready",
      "🎙️ missing-bin",
      "excluded-missing (bins: missing-tool)",
      "prompt-hidden (skill hides its instructions from the model; commands/cron may still use it)",
    );
    for (const name of parsed.agentFiltered) {
      expect(human).toContain(`${name} (loaded, but this agent is not allowed to see/use it)`);
    }
  });

  it("explains standalone skills hidden from the model and commands", () => {
    vi.stubEnv("TERM", "dumb");
    const entry = skill("standalone", {
      modelVisible: false,
      userInvocable: false,
      emoji: undefined,
    });
    const output = formatSkillsCheck(report([entry]), {});
    expectContains(output, "\n  standalone", "is not exposed as a command");
    expect(output).not.toContain("commands/cron may still use it");
  });

  it("sanitizes ANSI and C1 controls in JSON fields", () => {
    const entry = skill("json-skill", {
      emoji: "\u001b[31m📧\u001b[0m\u009f",
      description: "desc\u0093\u001b[2J\u001b[33m colored\u001b[0m",
    });
    const output = formatSkillsList(report([entry]), { json: true });
    expect(JSON.parse(output).skills[0]).toMatchObject({
      emoji: "📧",
      description: "desc colored",
    });
    expect(output).not.toContain("\\u001b");
  });

  it.each([false, true])("sanitizes the user-supplied not-found name (json: %s)", (json) => {
    const output = formatSkillInfo(report([]), "evil\u001b[31m\u009f", { json });
    if (json) {
      expect(JSON.parse(output)).toEqual({
        ok: false,
        error: { type: "cli_error", message: 'Skill "evil" not found.' },
        skill: "evil",
      });
    } else {
      expect(output).toContain('Skill "evil" not found');
    }
    expect(output).not.toContain("\u001b");
  });
});
