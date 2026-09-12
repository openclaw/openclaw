import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

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
    { name: "visible read", params: { toolNames: ["read"] }, included: true },
    { name: "no read tool", params: { toolNames: ["message"] }, included: false },
    {
      name: "deferred read capability",
      params: { toolNames: ["message"], capabilityToolNames: ["read"] },
      included: false,
    },
    {
      name: "Code Mode exec",
      params: { codeModeActive: true, toolNames: ["exec"] },
      included: true,
    },
    {
      name: "Code Mode without exec",
      params: { codeModeActive: true, toolNames: ["read"] },
      included: false,
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

  it("does not report a catalog removed by a prompt override", () => {
    expect(reportSkills("Use the provider's custom prompt.")).toEqual({
      promptChars: 0,
      hash: createHash("sha256").update("").digest("hex"),
      entries: [],
    });
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

  it("does not count unrelated skill examples from workspace context", () => {
    const systemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      toolNames: ["message"],
      skillsPrompt: catalog,
      contextFiles: [
        {
          path: "/workspace/AGENTS.md",
          content:
            "Example: <available_skills><skill><name>sample</name></skill></available_skills>",
        },
      ],
    });
    expect(systemPrompt).toContain("<name>sample</name>");
    expect(reportSkills(systemPrompt).entries).toEqual([]);
  });

  it.each([false, true])("ignores a workspace catalog copy with read visibility %s", (visible) => {
    const systemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      toolNames: visible ? ["read"] : ["message"],
      skillsPrompt: catalog,
      contextFiles: [{ path: "/workspace/AGENTS.md", content: `## Skills\n${catalog}` }],
    });
    expect(systemPrompt).toContain(catalog);
    expect(reportSkills(systemPrompt).promptChars).toBe(visible ? catalog.length : 0);
    expect(reportSkills(systemPrompt).entries.map(({ name }) => name)).toEqual(
      visible ? ["weather"] : [],
    );
  });

  it("does not attribute a catalog in a later section to Skills", () => {
    expect(reportSkills(`## Skills\nNo catalog here.\n\n## Notes\n${catalog}`).entries).toEqual([]);
  });

  it.each(["## Skills", "# Project Context", "## Workspace Files (injected)"])(
    "finds the rendered catalog after provider guidance headed %s",
    (heading) => {
      const systemPrompt = buildAgentSystemPrompt({
        workspaceDir: "/workspace",
        toolNames: ["read"],
        skillsPrompt: catalog,
        promptContribution: { stablePrefix: `${heading}\nProvider guidance.` },
      });
      expect(systemPrompt).toContain(catalog);
      expect(reportSkills(systemPrompt).promptChars).toBe(catalog.length);
      expect(reportSkills(systemPrompt).entries.map(({ name }) => name)).toEqual(["weather"]);
    },
  );

  it.each([
    "## Details",
    "# Project Context",
    "## Workspace Files (injected)",
    "## Workspace Files (injected)\nUser-editable; OpenClaw loads below as Project Context.",
  ])("keeps %s inside a rendered skill description", (heading) => {
    const skillsPrompt = catalog.replace(
      "Weather reports",
      `Weather reports\n${heading}\nRain or sun`,
    );
    const systemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      toolNames: ["read"],
      skillsPrompt,
    });
    const report = reportSkills(systemPrompt, skillsPrompt);
    expect(report.promptChars).toBe(skillsPrompt.length);
    expect(report.hash).toBe(createHash("sha256").update(skillsPrompt).digest("hex"));
    expect(report.entries.map(({ name }) => name)).toEqual(["weather"]);
  });
});
