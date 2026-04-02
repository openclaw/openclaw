import { describe, expect, it } from "vitest";
import { buildContextReply } from "./commands-context-report.js";
import type { HandleCommandsParams } from "./commands-types.js";

function makeParams(
  commandBodyNormalized: string,
  truncated: boolean,
  options?: {
    omitBootstrapLimits?: boolean;
    includeLegacyMemoryFile?: boolean;
    includeMemoryTools?: boolean;
  },
): HandleCommandsParams {
  const injectedWorkspaceFiles = [
    {
      name: "AGENTS.md",
      path: "/tmp/workspace/AGENTS.md",
      missing: false,
      rawChars: truncated ? 200_000 : 10_000,
      injectedChars: truncated ? 20_000 : 10_000,
      truncated,
    },
  ];
  if (options?.includeLegacyMemoryFile) {
    injectedWorkspaceFiles.push({
      name: "MEMORY.md",
      path: "/tmp/workspace/MEMORY.md",
      missing: false,
      rawChars: 500,
      injectedChars: 0,
      truncated: true,
    });
  }
  const toolEntries = [{ name: "read", summaryChars: 10, schemaChars: 20, propertiesCount: 1 }];
  if (options?.includeMemoryTools) {
    toolEntries.push(
      { name: "memory_search", summaryChars: 10, schemaChars: 20, propertiesCount: 1 },
      { name: "memory_get", summaryChars: 10, schemaChars: 20, propertiesCount: 1 },
      { name: "lcm_expand_query", summaryChars: 10, schemaChars: 20, propertiesCount: 1 },
    );
  }
  return {
    command: {
      commandBodyNormalized,
      channel: "telegram",
      senderIsOwner: true,
    },
    sessionKey: "agent:default:main",
    workspaceDir: "/tmp/workspace",
    contextTokens: null,
    provider: "openai",
    model: "gpt-5",
    elevated: { allowed: false },
    resolvedThinkLevel: "off",
    resolvedReasoningLevel: "off",
    sessionEntry: {
      totalTokens: 123,
      inputTokens: 100,
      outputTokens: 23,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        workspaceDir: "/tmp/workspace",
        bootstrapMaxChars: options?.omitBootstrapLimits ? undefined : 20_000,
        bootstrapTotalMaxChars: options?.omitBootstrapLimits ? undefined : 150_000,
        sandbox: { mode: "off", sandboxed: false },
        systemPrompt: {
          chars: 1_000,
          projectContextChars: 500,
          nonProjectContextChars: 500,
        },
        memory: {
          startup: { files: [] },
          working: { enabled: false, files: [] },
          searchable: { available: false, toolNames: [], noteRoots: ["memory/"] },
          recall: { available: false, toolNames: [] },
        },
        injectedWorkspaceFiles,
        skills: {
          promptChars: 10,
          entries: [{ name: "checks", blockChars: 10 }],
        },
        tools: {
          listChars: 10,
          schemaChars: 20,
          entries: toolEntries,
        },
      },
    },
    cfg: {},
    ctx: {},
    commandBody: "",
    commandArgs: [],
    resolvedElevatedLevel: "off",
  } as unknown as HandleCommandsParams;
}

describe("buildContextReply", () => {
  it("shows bootstrap truncation warning in list output when context exceeds configured limits", async () => {
    const result = await buildContextReply(makeParams("/context list", true));
    expect(result.text).toContain("Bootstrap max/total: 150,000 chars");
    expect(result.text).toContain("⚠ Injected startup/working context is over configured limits");
    expect(result.text).toContain("Causes: 1 file(s) exceeded max/file.");
  });

  it("does not show bootstrap truncation warning when there is no truncation", async () => {
    const result = await buildContextReply(makeParams("/context list", false));
    expect(result.text).not.toContain("Injected startup/working context is over configured limits");
  });

  it("falls back to config defaults when legacy reports are missing bootstrap limits", async () => {
    const result = await buildContextReply(
      makeParams("/context list", false, {
        omitBootstrapLimits: true,
      }),
    );
    expect(result.text).toContain("Bootstrap max/file: 20,000 chars");
    expect(result.text).toContain("Bootstrap max/total: 150,000 chars");
    expect(result.text).not.toContain("Bootstrap max/file: ? chars");
  });

  it("synthesizes memory-layer output for legacy cached reports", async () => {
    const params = makeParams("/context list", false, {
      includeLegacyMemoryFile: true,
      includeMemoryTools: true,
    });
    delete params.sessionEntry!.systemPromptReport!.memory;

    const result = await buildContextReply(params);
    expect(result.text).toContain("Startup memory: MEMORY.md (present, not startup-injected)");
    expect(result.text).toContain(
      "Searchable memory: on-demand via memory_search, memory_get (note roots: memory/)",
    );
    expect(result.text).toContain(
      "Conversation recall: separate from durable memory via lcm_expand_query",
    );
  });

  it("shows scoped working-memory files when present", async () => {
    const params = makeParams("/context list", false);
    params.sessionEntry!.systemPromptReport!.memory = {
      startup: { files: [] },
      working: {
        enabled: true,
        files: [
          {
            path: ".openclaw/working-memory/cron/nightly.md",
            status: "loaded",
            rawChars: 42,
            injectedChars: 42,
          },
        ],
      },
      searchable: { available: false, toolNames: [], noteRoots: ["memory/"] },
      recall: { available: false, toolNames: [] },
    };

    const result = await buildContextReply(params);
    expect(result.text).toContain(
      "Working memory: .openclaw/working-memory/cron/nightly.md (loaded; raw 42 chars (~11 tok) | injected 42 chars (~11 tok))",
    );
  });

  it("deep-backfills partially migrated cached memory reports", async () => {
    const params = makeParams("/context list", false);
    params.sessionEntry!.systemPromptReport!.memory = {
      startup: {
        files: [
          {
            name: "MEMORY.md",
            path: "/tmp/workspace/MEMORY.md",
            status: "present-not-injected",
            rawChars: 500,
            injectedChars: 0,
          },
        ],
      },
      searchable: {
        available: true,
        toolNames: ["memory_search", "memory_get"],
        noteRoots: ["memory/", "notes/"],
      },
      recall: {
        available: true,
        toolNames: ["lcm_expand_query"],
      },
    } as NonNullable<
      NonNullable<HandleCommandsParams["sessionEntry"]>["systemPromptReport"]
    >["memory"];
    delete (params.sessionEntry!.systemPromptReport!.memory as { working?: unknown }).working;

    const result = await buildContextReply(params);
    expect(result.text).toContain("Startup memory: MEMORY.md (present, not startup-injected)");
    expect(result.text).toContain("Working memory: none configured for this run");
    expect(result.text).toContain(
      "Searchable memory: on-demand via memory_search, memory_get (note roots: memory/, notes/)",
    );
    expect(result.text).toContain(
      "Conversation recall: separate from durable memory via lcm_expand_query",
    );
  });

  it("counts scoped working memory in truncation warnings", async () => {
    const params = makeParams("/context list", false);
    params.sessionEntry!.systemPromptReport!.memory = {
      startup: { files: [] },
      working: {
        enabled: true,
        files: [
          {
            path: ".openclaw/working-memory/cron/nightly.md",
            status: "loaded",
            rawChars: 200_000,
            injectedChars: 10_000,
          },
        ],
      },
      searchable: { available: false, toolNames: [], noteRoots: ["memory/"] },
      recall: { available: false, toolNames: [] },
    };

    const result = await buildContextReply(params);
    expect(result.text).toContain("⚠ Injected startup/working context is over configured limits");
    expect(result.text).toContain("nightly.md");
    expect(result.text).toContain(
      "Scoped working memory note: this lane has its own max/file cap of 10,000 chars",
    );
    expect(result.text).toContain("Raising bootstrap limits alone will not remove that truncation");
  });
});
