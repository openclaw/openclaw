import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionSystemPromptReport } from "../config/sessions/types.js";
import { buildWorkspaceHealthDashboard } from "./workspace-health-dashboard.js";

function makeReport(params: {
  workspaceDir: string;
  generatedAt: number;
  taskProfile: "coding" | "research" | "ops" | "assistant";
  promptBudget: {
    totalTrackedChars: number;
    workspaceInjectedChars: number;
    skillsPromptChars: number;
    toolListChars: number;
    otherSystemPromptChars: number;
    toolSchemaChars: number;
  };
}): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt: params.generatedAt,
    workspaceDir: params.workspaceDir,
    taskProfile: { id: params.taskProfile, source: "explicit" },
    systemPrompt: { chars: 1_000, projectContextChars: 500, nonProjectContextChars: 500 },
    promptBudget: params.promptBudget,
    injectedWorkspaceFiles: [],
    skills: { promptChars: 50, entries: [] },
    tools: { listChars: 40, schemaChars: params.promptBudget.toolSchemaChars, entries: [] },
  };
}

function makeEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: 0,
    ...overrides,
  };
}

describe("buildWorkspaceHealthDashboard", () => {
  it("aggregates profile, prompt, failure, retry, and trend signals for one workspace", () => {
    const now = Date.UTC(2026, 2, 25, 12, 0, 0);
    const workspaceDir = "/tmp/workspace";
    const recent = now - 2 * 24 * 60 * 60 * 1000;
    const previous = now - 9 * 24 * 60 * 60 * 1000;
    const dashboard = buildWorkspaceHealthDashboard({
      workspaceDir,
      now,
      sessionStore: {
        codingRecent: makeEntry({
          sessionId: "coding-recent",
          updatedAt: recent,
          status: "running",
          startedAt: recent - 60_000,
          runtimeMs: 60_000,
          totalTokens: 40_000,
          estimatedCostUsd: 0.12,
          systemPromptReport: makeReport({
            workspaceDir,
            generatedAt: recent,
            taskProfile: "coding",
            promptBudget: {
              totalTrackedChars: 40_000,
              workspaceInjectedChars: 5_000,
              skillsPromptChars: 2_000,
              toolListChars: 1_000,
              otherSystemPromptChars: 12_000,
              toolSchemaChars: 20_000,
            },
          }),
          verifyReport: {
            status: "passed",
            strategy: "command-tool",
            generatedAt: recent,
            checksRun: 1,
            checksPassed: 1,
            checksFailed: 0,
            entries: [],
          },
          failureReport: {
            status: "none",
            generatedAt: recent,
            category: "none",
            source: "none",
            code: "none",
            summary: "none",
          },
          retryReport: {
            status: "used",
            generatedAt: recent,
            maxAttempts: 8,
            attemptsUsed: 2,
            retriesUsed: 1,
            remainingRetries: 6,
            entries: [{ attempt: 1, reason: "thinking_fallback" }],
          },
        }),
        researchRecent: makeEntry({
          sessionId: "research-recent",
          updatedAt: recent + 1_000,
          runtimeMs: 30_000,
          totalTokens: 12_000,
          estimatedCostUsd: 0.02,
          systemPromptReport: makeReport({
            workspaceDir,
            generatedAt: recent + 1_000,
            taskProfile: "research",
            promptBudget: {
              totalTrackedChars: 12_000,
              workspaceInjectedChars: 3_000,
              skillsPromptChars: 1_000,
              toolListChars: 500,
              otherSystemPromptChars: 2_500,
              toolSchemaChars: 5_000,
            },
          }),
        }),
        codingPrevious: makeEntry({
          sessionId: "coding-previous",
          updatedAt: previous,
          runtimeMs: 90_000,
          totalTokens: 30_000,
          estimatedCostUsd: 0.08,
          systemPromptReport: makeReport({
            workspaceDir,
            generatedAt: previous,
            taskProfile: "coding",
            promptBudget: {
              totalTrackedChars: 36_000,
              workspaceInjectedChars: 6_000,
              skillsPromptChars: 2_000,
              toolListChars: 1_000,
              otherSystemPromptChars: 7_000,
              toolSchemaChars: 20_000,
            },
          }),
          verifyReport: {
            status: "failed",
            strategy: "command-tool",
            generatedAt: previous,
            checksRun: 1,
            checksPassed: 0,
            checksFailed: 1,
            entries: [],
          },
          failureReport: {
            status: "failed",
            generatedAt: previous,
            category: "verification",
            source: "verify-runner",
            code: "verify_failed",
            summary: "1/1 verification checks failed",
          },
          retryReport: {
            status: "exhausted",
            generatedAt: previous,
            maxAttempts: 4,
            attemptsUsed: 4,
            retriesUsed: 3,
            remainingRetries: 0,
            exhaustedReason: "retry_limit",
            entries: [{ attempt: 2, reason: "thinking_fallback" }],
          },
        }),
        otherWorkspace: makeEntry({
          sessionId: "other-workspace",
          updatedAt: recent,
          systemPromptReport: makeReport({
            workspaceDir: "/tmp/other",
            generatedAt: recent,
            taskProfile: "ops",
            promptBudget: {
              totalTrackedChars: 1_000,
              workspaceInjectedChars: 100,
              skillsPromptChars: 100,
              toolListChars: 100,
              otherSystemPromptChars: 100,
              toolSchemaChars: 600,
            },
          }),
        }),
      },
    });

    expect(dashboard.matchedSessions).toBe(3);
    expect(dashboard.activeSessions).toBe(1);
    expect(dashboard.reportsCount).toBe(3);
    expect(dashboard.overall.verifiedSessions).toBe(2);
    expect(dashboard.overall.verifyPassedSessions).toBe(1);
    expect(dashboard.overall.failedSessions).toBe(1);
    expect(dashboard.overall.retriedSessions).toBe(2);
    expect(dashboard.overall.exhaustedSessions).toBe(1);
    expect(dashboard.overall.topFailureCategory).toBe("verification");
    expect(dashboard.overall.topRetryReason).toBe("thinking_fallback");
    expect(dashboard.overall.topPromptComponent?.label).toBe("tool schemas");
    expect(dashboard.profiles).toHaveLength(2);
    expect(dashboard.profiles[0]).toMatchObject({
      id: "coding",
      sessions: 2,
      verifiedSessions: 2,
      verifyPassedSessions: 1,
      failedSessions: 1,
      retriedSessions: 2,
    });
    expect(dashboard.trends.current.sessions).toBe(2);
    expect(dashboard.trends.previous.sessions).toBe(1);
    expect(dashboard.attention).toContain("Tool schemas are still the dominant prompt cost.");
    expect(dashboard.attention).toContain("verification is the top recorded failure category.");
  });
});
