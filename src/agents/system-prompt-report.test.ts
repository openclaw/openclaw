import { createHash } from "node:crypto";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";
import type { AnyAgentTool } from "./tools/common.js";

function makeTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({ value: Type.String() }),
    execute: async () => ({ content: [], details: {} }),
  };
}

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

function catalogEntry(
  tool: AnyAgentTool,
  overrides: Partial<ToolSearchCatalogEntry>,
): ToolSearchCatalogEntry {
  return {
    id: tool.name,
    name: tool.name,
    description: "",
    parameters: tool.parameters,
    source: "mcp",
    tool,
    ...overrides,
  };
}

const catalog = [
  "<available_skills>",
  "<skill><name>weather</name><description>Weather reports</description><location>/skills/weather/SKILL.md</location></skill>",
  "</available_skills>",
].join("\n");

function expectSkills(systemPrompt: string, rendered: string, skillsPrompt = catalog) {
  const report = makeReport({ systemPrompt, skillsPrompt }).skills;
  expect(report).toMatchObject({
    promptChars: rendered.length,
    hash: createHash("sha256").update(rendered).digest("hex"),
  });
  expect(report.entries.map(({ name }) => name)).toEqual(rendered ? ["weather"] : []);
}

describe("buildSystemPromptReport", () => {
  it("separates catalog availability from consumed schemas using owner provenance", () => {
    const visible = makeTool("visible");
    const deferred = makeTool("deferred");
    const remote = makeTool("remote");
    const mcp = {
      serverName: "Docs Server",
      safeServerName: "docs",
      toolName: "visible",
      operation: "tool",
    } as const;
    setPluginToolMeta(visible, { pluginId: "bundle-mcp", optional: true, mcp });
    const remoteSchema = publishRuntimeToolInputSchema(remote.parameters).schema;
    const deferredChars = JSON.stringify(deferred.parameters).length;
    const remoteChars = JSON.stringify(remoteSchema).length;
    const catalogEntries: ToolSearchCatalogEntry[] = [
      catalogEntry(visible, { sourceName: "docs", directVisible: true, mcp }),
      catalogEntry(deferred, { source: "openclaw", sourceName: "core" }),
      catalogEntry(remote, { sourceName: "docs", parameters: remoteSchema }),
      catalogEntry(remote, {
        id: "client",
        name: "client",
        source: "client",
        parameters: new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("must not inspect unpublished client schema");
            },
          },
        ),
      }),
    ];
    const tools = makeReport({ tools: [visible], catalogEntries }).tools;
    expect(tools).toMatchObject({
      entries: [{ source: "mcp", sourceName: "docs", serverName: "Docs Server" }],
      schemaChars: JSON.stringify(visible.parameters).length,
    });
    expect(tools.deferred).toEqual({
      schemaChars: deferredChars + remoteChars,
      entries: [
        { name: "deferred", source: "openclaw", sourceName: "core", schemaChars: deferredChars },
        { name: "remote", source: "mcp", sourceName: "docs", schemaChars: remoteChars },
        { name: "client", source: "client", sourceName: undefined, schemaChars: null },
      ],
    });
    expect(makeReport({ tools: [visible] }).tools.entries[0]).toMatchObject({
      source: "mcp",
      serverName: "Docs Server",
    });
    expect(makeReport({ tools: [visible], catalogEntries: [] }).tools.deferred?.entries).toEqual(
      [],
    );
  });

  it("ignores malformed injected file paths and still matches valid entries", () => {
    const path = "/tmp/workspace/policies/AGENTS.md";
    const report = makeReport({
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [{ name: "AGENTS.md", path, content: "alpha", missing: false }],
        injectedFiles: [
          { path: 123 as unknown as string, content: "bad" },
          { path, content: "trimmed" },
        ],
      }),
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("accounts for project context with LF markers and UTF-16 content", () => {
    const systemPrompt = `lead\n# Project Context\n汉🦞${SYSTEM_PROMPT_CACHE_BOUNDARY}\n## Skills\nRun-scoped catalog\n## Silent Replies\ntail`;
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

  it.each(["long-synthetic-skill-name", "技能🦞-long-skill-name", "lone-\ud800-surrogate-name"])(
    "preserves the UTF-16 skill name %j while trimming whitespace",
    (name) => {
      const skillsPrompt = `<skill><name>  ${name}\n</name></skill>`;
      const report = makeReport({ systemPrompt: `## Skills\n${skillsPrompt}`, skillsPrompt });
      expect(report.skills.entries).toEqual([{ name, blockChars: skillsPrompt.length }]);
    },
  );

  it("uses the first complete plain-text name, including mixed-case tags", () => {
    const skillsPrompt =
      "<skill><name><invalid/></name><NAME> valid-skill-name-after-markup </NAME><name>later</name></skill>";
    const report = makeReport({ systemPrompt: `## Skills\n${skillsPrompt}`, skillsPrompt });
    expect(report.skills.entries).toEqual([
      { name: "valid-skill-name-after-markup", blockChars: skillsPrompt.length },
    ]);
  });

  it("keeps reporting when a tool schema cannot be stringified", () => {
    const circularSchema: Record<string, unknown> = {
      type: "object",
      properties: { count: { type: "integer" } },
    };
    circularSchema.self = circularSchema;

    const report = makeReport({
      tools: [{ name: "broken", description: "Broken schema", parameters: circularSchema }],
    });

    expect(report.tools.entries[0]).toMatchObject({
      name: "broken",
      schemaChars: 0,
      propertiesCount: 1,
    });
    expect(report.tools.entries[0]?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("rendered skills diagnostics", () => {
  it.each<[Partial<Parameters<typeof buildAgentSystemPrompt>[0]>, boolean, boolean?]>([
    [{ toolNames: ["skills_read"] }, true],
    [{ codeModeActive: true, toolNames: ["exec"] }, true],
    [{ promptSurface: "cli_backend" }, true],
    [{ promptMode: "minimal", toolNames: ["read"] }, true],
    [{ promptMode: "none", toolNames: ["read"] }, false],
    [{ toolNames: ["read"], skillsPrompt: `\n  ${catalog}\n\n` }, true],
    [
      {
        toolNames: ["message"],
        contextFiles: [{ path: "/workspace/AGENTS.md", content: `## Skills\n${catalog}` }],
      },
      false,
      true,
    ],
    [
      {
        toolNames: ["read"],
        promptContribution: { stablePrefix: "# Project Context\nProvider guidance." },
      },
      true,
    ],
  ])("reports the catalog actually rendered for %j", (params, included, workspaceCopy = false) => {
    const skillsPrompt = params.skillsPrompt ?? catalog;
    const systemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      skillsPrompt,
      ...params,
    });
    expect(systemPrompt.includes(catalog)).toBe(included || workspaceCopy);
    expectSkills(systemPrompt, included ? catalog : "", skillsPrompt);
  });
});
