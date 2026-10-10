import { createHash } from "node:crypto";
// System prompt report tests cover prompt accounting, bootstrap injection
// matching, and hash output used to compare prompt/tool parity.
import { describe, expect, it } from "vitest";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function makeBootstrapFile(overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile {
  return {
    name: "AGENTS.md",
    path: "/tmp/workspace/AGENTS.md",
    content: "alpha",
    missing: false,
    ...overrides,
  };
}

describe("buildSystemPromptReport", () => {
  const makeReport = (overrides: Partial<Parameters<typeof buildSystemPromptReport>[0]> = {}) =>
    buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      injectedWorkspaceFiles: [],
      skillsPrompt: "",
      tools: [],
      ...overrides,
    });

  it("ignores malformed injected file paths and still matches valid entries", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [
          { path: 123 as unknown as string, content: "bad" },
          { path: "/tmp/workspace/policies/AGENTS.md", content: "trimmed" },
        ],
      }),
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("accounts for project context with LF markers and UTF-16 content", () => {
    const systemPrompt = "lead\n# Project Context\n汉🦞\n## Silent Replies\ntail";
    const report = makeReport({ systemPrompt });
    expect(report.systemPrompt).toMatchObject({
      chars: systemPrompt.length,
      projectContextChars: 22,
      nonProjectContextChars: systemPrompt.length - 22,
    });
  });

  it("reports unnamed complete skill blocks in order", () => {
    const skillsPrompt = "<skill></skill><skill><name> </name></skill>";
    const report = makeReport({
      systemPrompt: `## Skills\n${skillsPrompt.trim()}`,
      skillsPrompt,
    });
    expect(report.skills.promptChars).toBe(skillsPrompt.trim().length);
    expect(report.skills.entries).toEqual([
      { name: "(unknown)", blockChars: "<skill></skill>".length },
      { name: "(unknown)", blockChars: "<skill><name> </name></skill>".length },
    ]);
  });

  it("keeps reporting when a tool schema cannot be stringified", () => {
    const circularSchema: Record<string, unknown> = {
      type: "object",
      properties: { count: { type: "integer" } },
    };
    circularSchema.self = circularSchema;

    const report = makeReport({
      tools: [
        {
          name: "broken",
          description: "Broken schema",
          parameters: circularSchema,
        },
      ] as never,
    });

    expect(report.tools.entries[0]).toMatchObject({
      name: "broken",
      schemaChars: 0,
      propertiesCount: 1,
    });
    expect(report.tools.entries[0]?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});

const catalog = [
  "<available_skills>",
  "<skill><name>weather</name><description>Weather reports</description><location>/skills/weather/SKILL.md</location></skill>",
  "</available_skills>",
].join("\n");

function reportSkills(systemPrompt: string, skillsPrompt = catalog) {
  return buildSystemPromptReport({
    source: "run",
    generatedAt: 0,
    bootstrapMaxChars: 20_000,
    systemPrompt,
    injectedWorkspaceFiles: [],
    skillsPrompt,
    tools: [],
  }).skills;
}

describe("rendered skills diagnostics", () => {
  it.each([
    { name: "visible skills_read", params: { toolNames: ["skills_read"] }, included: true },
    {
      name: "Code Mode exec",
      params: { codeModeActive: true, toolNames: ["exec"] },
      included: true,
    },
    { name: "CLI native tools", params: { promptSurface: "cli_backend" }, included: true },
    {
      name: "minimal prompt with read",
      params: { promptMode: "minimal", toolNames: ["read"] },
      included: true,
    },
    {
      name: "no prompt sections",
      params: { promptMode: "none", toolNames: ["read"] },
      included: false,
    },
  ] satisfies Array<{
    name: string;
    params: Partial<Parameters<typeof buildAgentSystemPrompt>[0]>;
    included: boolean;
  }>)("reports the catalog actually rendered for $name", ({ params, included }) => {
    const systemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      skillsPrompt: catalog,
      ...params,
    });
    expect(systemPrompt.includes(catalog)).toBe(included);

    const report = reportSkills(systemPrompt);
    const rendered = included ? catalog : "";
    expect(report.promptChars).toBe(rendered.length);
    expect(report.hash).toBe(createHash("sha256").update(rendered).digest("hex"));
    expect(report.entries.map(({ name }) => name)).toEqual(included ? ["weather"] : []);
  });

  it("measures the trimmed catalog that the renderer includes", () => {
    const skillsPrompt = `\n  ${catalog}\n\n`;
    const systemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      toolNames: ["read"],
      skillsPrompt,
    });
    const report = reportSkills(systemPrompt, skillsPrompt);
    expect(report.promptChars).toBe(catalog.length);
    expect(report.hash).toBe(createHash("sha256").update(catalog).digest("hex"));
    expect(report.entries.map(({ name }) => name)).toEqual(["weather"]);
  });

  it("ignores a workspace catalog copy when read is unavailable", () => {
    const systemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      toolNames: ["message"],
      skillsPrompt: catalog,
      contextFiles: [{ path: "/workspace/AGENTS.md", content: `## Skills\n${catalog}` }],
    });
    expect(systemPrompt).toContain(catalog);
    expect(reportSkills(systemPrompt).promptChars).toBe(0);
    expect(reportSkills(systemPrompt).entries.map(({ name }) => name)).toEqual([]);
  });

  it("finds the rendered catalog after provider Project Context guidance", () => {
    const systemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      toolNames: ["read"],
      skillsPrompt: catalog,
      promptContribution: { stablePrefix: "# Project Context\nProvider guidance." },
    });
    expect(systemPrompt).toContain(catalog);
    expect(reportSkills(systemPrompt).promptChars).toBe(catalog.length);
    expect(reportSkills(systemPrompt).entries.map(({ name }) => name)).toEqual(["weather"]);
  });
});
