import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { jsonResult } from "./tools/common.js";
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
  const makeReport = (params: {
    file: WorkspaceBootstrapFile;
    injectedPath: string;
    injectedContent: string;
    bootstrapMaxChars?: number;
    bootstrapTotalMaxChars?: number;
  }) =>
    buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: params.bootstrapMaxChars ?? 20_000,
      bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
      systemPrompt: "system",
      bootstrapFiles: [params.file],
      injectedFiles: [{ path: params.injectedPath, content: params.injectedContent }],
      skillsPrompt: "",
      tools: [],
    });

  it("counts injected chars when injected file paths are absolute", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("keeps legacy basename matching for injected files", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("marks workspace files truncated when injected chars are smaller than raw chars", () => {
    const file = makeBootstrapFile({
      path: "/tmp/workspace/policies/AGENTS.md",
      content: "abcdefghijklmnopqrstuvwxyz",
    });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("includes both bootstrap caps in the report payload", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
      bootstrapMaxChars: 11_111,
      bootstrapTotalMaxChars: 22_222,
    });

    expect(report.bootstrapMaxChars).toBe(11_111);
    expect(report.bootstrapTotalMaxChars).toBe(22_222);
  });

  it("reports zero in-band tool list chars when tool info stays structured", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.tools.listChars).toBe(0);
  });

  it("reports injectedChars=0 when injected file does not match by path or basename", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/OTHER.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe(0);
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("ignores malformed injected file paths and still matches valid entries", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [file],
      injectedFiles: [
        { path: 123 as unknown as string, content: "bad" },
        { path: "/tmp/workspace/policies/AGENTS.md", content: "trimmed" },
      ],
      skillsPrompt: "",
      tools: [],
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("reports zero tool-list chars for explicit empty-tool sessions", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: [],
      explicitEmptyToolListMeansNoTools: true,
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [],
    });

    expect(report.tools.entries).toEqual([]);
    expect(report.tools.listChars).toBe(0);
  });

  it("includes prompt-visible client tools in the structured report", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [],
      clientTools: [
        {
          type: "function",
          function: {
            name: "get_time",
            description: "Return the current time.",
            parameters: {
              type: "object",
              properties: {
                timezone: { type: "string" },
              },
            },
          },
        },
      ],
    });

    expect(report.tools.entries).toEqual([
      {
        name: "get_time",
        summaryChars: "Return the current time.".length,
        schemaChars: JSON.stringify({
          type: "object",
          properties: {
            timezone: { type: "string" },
          },
        }).length,
        propertiesCount: 1,
      },
    ]);
    expect(report.tools.listChars).toBe(0);
  });

  it("keeps built-in and hosted tool entries separate", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [
        {
          name: "exec",
          label: "Exec",
          description: "Run shell commands",
          parameters: Type.Object({
            cmd: Type.String(),
          }),
          execute: async () => jsonResult({ ok: true }),
        },
      ],
      clientTools: [
        {
          type: "function",
          function: {
            name: "FetchTime",
            description: "Fetch the current exchange rate.",
            parameters: {
              type: "object",
              properties: {
                base: { type: "string" },
              },
            },
          },
        },
      ],
    });

    expect(report.tools.entries).toEqual([
      {
        name: "exec",
        summaryChars: "Run shell commands".length,
        schemaChars: JSON.stringify(
          Type.Object({
            cmd: Type.String(),
          }),
        ).length,
        propertiesCount: 1,
      },
      {
        name: "FetchTime",
        summaryChars: "Fetch the current exchange rate.".length,
        schemaChars: JSON.stringify({
          type: "object",
          properties: {
            base: { type: "string" },
          },
        }).length,
        propertiesCount: 1,
      },
    ]);
    expect(report.tools.schemaChars).toBe(
      JSON.stringify(
        Type.Object({
          cmd: Type.String(),
        }),
      ).length +
        JSON.stringify({
          type: "object",
          properties: {
            base: { type: "string" },
          },
        }).length,
    );
  });

  it("preserves hosted tool casing in report entries", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [],
      clientTools: [
        {
          type: "function",
          function: {
            name: "Foo",
            description: "Return the uppercase tool result.",
          },
        },
      ],
    });

    expect(report.tools.entries).toEqual([
      {
        name: "Foo",
        summaryChars: "Return the uppercase tool result.".length,
        schemaChars: 0,
        propertiesCount: null,
      },
    ]);
  });
});
