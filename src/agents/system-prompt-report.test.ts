// System prompt report tests cover prompt accounting, bootstrap injection
// matching, and hash output used to compare prompt/tool parity.
import { describe, expect, it } from "vitest";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";
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

  it("includes both bootstrap caps in the report payload", () => {
    const report = makeReport({
      bootstrapMaxChars: 11_111,
      bootstrapTotalMaxChars: 22_222,
    });

    expect(report.bootstrapMaxChars).toBe(11_111);
    expect(report.bootstrapTotalMaxChars).toBe(22_222);
  });

  it("reports zero in-band tool list chars when tool info stays structured", () => {
    const report = makeReport();

    expect(report.tools.listChars).toBe(0);
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

  it("does not count injected files as project context when the rendered prompt omits them", () => {
    const file = makeBootstrapFile({
      path: "/tmp/workspace/AGENTS.md",
      content: "raw bootstrap context",
    });
    const report = makeReport({
      systemPrompt: "custom override",
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "rendered context" }],
      }),
    });

    expect(report.systemPrompt.chars).toBe("custom override".length);
    expect(report.systemPrompt.projectContextChars).toBe(0);
    expect(report.systemPrompt.nonProjectContextChars).toBe("custom override".length);
  });

  it.each([
    ["LF markers and UTF-16 content", "lead\n# Project Context\n汉🦞\n## Silent Replies\ntail", 22],
    ["missing end marker", "\n# Project Context\nx", 20],
    [
      "end marker before context",
      "\n## Silent Replies\nlead\n# Project Context\nx\n## Silent Replies\n",
      20,
    ],
    [
      "first of repeated start markers",
      "\n# Project Context\nfirst\n# Project Context\nsecond\n## Silent Replies\n",
      49,
    ],
    ["nonmatching CRLF markers", "lead\r\n# Project Context\r\nx\r\n## Silent Replies\r\n", 0],
  ] as const)(
    "accounts for project context with %s",
    (_name, systemPrompt, projectContextChars) => {
      const report = makeReport({
        systemPrompt,
      });

      expect(report.systemPrompt).toMatchObject({
        chars: systemPrompt.length,
        projectContextChars,
        nonProjectContextChars: systemPrompt.length - projectContextChars,
      });
    },
  );

  it.each([
    { skillsPrompt: " \n<skill><name>unfinished</name>", entries: [] },
    {
      skillsPrompt: " \n<SKILL><NAME> same </NAME></SKILL><skill><name>same</name></skill>\n ",
      entries: [
        { name: "same", blockChars: "<SKILL><NAME> same </NAME></SKILL>".length },
        { name: "same", blockChars: "<skill><name>same</name></skill>".length },
      ],
    },
    {
      skillsPrompt: "<skill></skill><skill><name> </name></skill>",
      entries: [
        { name: "(unknown)", blockChars: "<skill></skill>".length },
        { name: "(unknown)", blockChars: "<skill><name> </name></skill>".length },
      ],
    },
  ])("reports complete skill blocks in order: $skillsPrompt", ({ skillsPrompt, entries }) => {
    const report = makeReport({
      skillsPrompt,
    });

    expect(report.skills.promptChars).toBe(skillsPrompt.length);
    expect(report.skills.entries).toEqual(entries);
  });

  it("emits content hashes for prompt and tool parity checks", () => {
    // Hashes catch same-length prompt/tool drift that plain character counts
    // would miss when comparing runtime payloads.
    const report = makeReport({
      skillsPrompt: "<skill><name>docs</name></skill>",
      tools: [
        {
          name: "read",
          description: "Read files",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ] as never,
    });
    const sameLengthChangedPrompt = makeReport({
      systemPrompt: "systen",
      skillsPrompt: "<skill><name>docs</name></skill>",
    });

    expect(report.systemPrompt.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.skills.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.entries[0]?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.entries[0]?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(sameLengthChangedPrompt.systemPrompt.hash).not.toBe(report.systemPrompt.hash);
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
