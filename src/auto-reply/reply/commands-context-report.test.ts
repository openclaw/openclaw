import { describe, expect, it } from "vitest";
import { buildContextReply, compareContextReports } from "./commands-context-report.js";
import type { HandleCommandsParams } from "./commands-types.js";

function makeParams(
  commandBodyNormalized: string,
  truncated: boolean,
  options?: {
    omitBootstrapLimits?: boolean;
    contextTokens?: number | null;
    totalTokens?: number | null;
    totalTokensFresh?: boolean;
    cfg?: Record<string, unknown>;
  },
): HandleCommandsParams {
  return {
    command: {
      commandBodyNormalized,
      channel: "telegram",
      senderIsOwner: true,
    },
    sessionKey: "agent:default:main",
    workspaceDir: "/tmp/workspace",
    contextTokens: options?.contextTokens ?? null,
    provider: "openai",
    model: "gpt-5",
    elevated: { allowed: false },
    resolvedThinkLevel: "off",
    resolvedReasoningLevel: "off",
    sessionEntry: {
      totalTokens: options?.totalTokens ?? 123,
      totalTokensFresh: options?.totalTokensFresh ?? true,
      inputTokens: 100,
      outputTokens: 23,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        sourceRunId: "run-ctx",
        sourceMessageId: "leaf-ctx",
        workspaceDir: "/tmp/workspace",
        bootstrapMaxChars: options?.omitBootstrapLimits ? undefined : 20_000,
        bootstrapTotalMaxChars: options?.omitBootstrapLimits ? undefined : 150_000,
        sandbox: { mode: "off", sandboxed: false },
        systemPrompt: {
          chars: 1_000,
          projectContextChars: 500,
          nonProjectContextChars: 500,
        },
        injectedWorkspaceFiles: [
          {
            name: "AGENTS.md",
            path: "/tmp/workspace/AGENTS.md",
            missing: false,
            rawChars: truncated ? 200_000 : 10_000,
            injectedChars: truncated ? 20_000 : 10_000,
            truncated,
          },
        ],
        skills: {
          promptChars: 10,
          entries: [{ name: "checks", blockChars: 10 }],
        },
        tools: {
          listChars: 10,
          schemaChars: 20,
          entries: [{ name: "read", summaryChars: 10, schemaChars: 20, propertiesCount: 1 }],
        },
      },
    },
    cfg: (options?.cfg ?? {}) as never,
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
    expect(result.text).toContain("Truncation severity: low");
    expect(result.text).toContain("Largest tracked contributors:");
    expect(result.text).toContain("⚠ Bootstrap context is over configured limits");
    expect(result.text).toContain("Causes: 1 file(s) exceeded max/file.");
  });

  it("does not show bootstrap truncation warning when there is no truncation", async () => {
    const result = await buildContextReply(makeParams("/context list", false));
    expect(result.text).not.toContain("Bootstrap context is over configured limits");
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

  it("shows tracked estimate and cached context delta in detail output", async () => {
    const result = await buildContextReply(
      makeParams("/context detail", false, {
        contextTokens: 8_192,
        totalTokens: 900,
      }),
    );
    expect(result.text).toContain("Last run snapshot: run-ctx | leaf=leaf-ctx");
    expect(result.text).toContain("Prompt hash: unknown");
    expect(result.text).toContain("Tracked prompt estimate: 1,020 chars (~255 tok)");
    expect(result.text).toContain("Actual context usage (cached): 900 tok");
    expect(result.text).toContain("Untracked provider/runtime overhead: ~645 tok");
    expect(result.text).toContain(
      "Tip: use /context deep or /context delta for current estimate-vs-last-run drift.",
    );
    expect(result.text).toContain("Session tokens (cached): 900 total / ctx=8,192");
  });

  it("shows estimate-only detail output when cached context usage is unavailable", async () => {
    const result = await buildContextReply(
      makeParams("/context detail", false, {
        contextTokens: 8_192,
        totalTokens: 900,
        totalTokensFresh: false,
      }),
    );
    expect(result.text).toContain("Tracked prompt estimate: 1,020 chars (~255 tok)");
    expect(result.text).toContain("Actual context usage (cached): unavailable");
    expect(result.text).toContain("Session tokens (cached): unknown / ctx=8,192");
    expect(result.text).not.toContain("~645 tok");
  });

  it("surfaces memory-search config and post-compaction session sync in detail output", async () => {
    const result = await buildContextReply(
      makeParams("/context detail", false, {
        cfg: {
          agents: {
            defaults: {
              memorySearch: {
                provider: "auto",
                sources: ["memory", "sessions"],
                experimental: { sessionMemory: true },
                sync: {
                  onSessionStart: true,
                  onSearch: true,
                  watch: true,
                  sessions: { postCompactionForce: true },
                },
              },
            },
          },
        },
      }),
    );
    expect(result.text).toContain(
      "Memory search: enabled | provider=auto | sources=memory, sessions | fallback=none",
    );
    expect(result.text).toContain(
      "Memory session sync: sessionMemory=on | onSessionStart=on | onSearch=on | watch=on",
    );
    expect(result.text).toContain(
      "Memory post-compaction sync: forced when session sources are enabled",
    );
    expect(result.text).toContain("Memory multimodal: off");
  });

  it("includes memory-search snapshot in json output", async () => {
    const result = await buildContextReply(
      makeParams("/context json", false, {
        cfg: {
          agents: {
            defaults: {
              memorySearch: {
                provider: "auto",
                sources: ["memory", "sessions"],
                experimental: { sessionMemory: true },
                sync: {
                  onSessionStart: true,
                  onSearch: true,
                  watch: true,
                  sessions: { postCompactionForce: true },
                },
              },
            },
          },
        },
      }),
    );
    const payload = JSON.parse(result.text);
    expect(payload.memorySearch).toMatchObject({
      enabled: true,
      provider: "auto",
      sources: ["memory", "sessions"],
      experimental: { sessionMemory: true },
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        postCompactionForce: true,
      },
    });
  });

  it("shows estimate-vs-run drift in deep output", async () => {
    const result = await buildContextReply(
      makeParams("/context deep", false, {
        contextTokens: 8_192,
        totalTokens: 900,
      }),
    );
    expect(result.text).toContain("Estimate vs last run:");
    expect(result.text).toContain("- current estimate:");
    expect(result.text).toContain("- tracked drift:");
  });

  it("compares last run and current estimate drift", () => {
    const comparison = compareContextReports(
      {
        source: "run",
        generatedAt: 1,
        promptHash: "aaaa",
        truncationSeverity: "low",
        systemPrompt: {
          chars: 1_000,
          projectContextChars: 500,
          nonProjectContextChars: 500,
        },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 10, schemaChars: 20, entries: [] },
        tracked: {
          chars: 1_020,
          estimatedTokens: 255,
          largestContributors: [
            { name: "Project Context", chars: 500, estimatedTokens: 125, sharePercent: 49 },
          ],
        },
      },
      {
        source: "estimate",
        generatedAt: 2,
        promptHash: "bbbb",
        truncationSeverity: "medium",
        systemPrompt: {
          chars: 1_240,
          projectContextChars: 620,
          nonProjectContextChars: 620,
        },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 10, schemaChars: 80, entries: [] },
        tracked: {
          chars: 1_320,
          estimatedTokens: 330,
          largestContributors: [
            { name: "Tool schemas", chars: 700, estimatedTokens: 175, sharePercent: 53 },
          ],
        },
      },
    );

    expect(comparison.trackedCharsDelta).toBe(300);
    expect(comparison.trackedTokensDelta).toBe(75);
    expect(comparison.systemPromptCharsDelta).toBe(240);
    expect(comparison.projectContextCharsDelta).toBe(120);
    expect(comparison.toolSchemaCharsDelta).toBe(60);
    expect(comparison.promptHashChanged).toBe(true);
    expect(comparison.truncationSeverityChanged).toBe(true);
    expect(comparison.runTopContributor).toBe("Project Context");
    expect(comparison.estimateTopContributor).toBe("Tool schemas");
    expect(comparison.topContributorChanged).toBe(true);
  });
});
