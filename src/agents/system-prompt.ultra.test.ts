import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("Ultra system prompt capability", () => {
  it("adds run-scoped Ultra orchestration only when sessions_spawn is callable", () => {
    const base = {
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn"],
      subagentDelegationMode: "prefer",
    } satisfies Parameters<typeof buildAgentSystemPrompt>[0];
    const maxPrompt = buildAgentSystemPrompt(base);
    const ultraPrompt = buildAgentSystemPrompt({
      ...base,
      proactiveSubagentOrchestration: true,
    });
    const deferredUltraPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["tool_search"],
      capabilityToolNames: ["sessions_spawn"],
      proactiveSubagentOrchestration: true,
    });
    const minimalUltraPrompt = buildAgentSystemPrompt({
      ...base,
      promptMode: "minimal",
      proactiveSubagentOrchestration: true,
    });
    const unavailablePrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["subagents"],
      proactiveSubagentOrchestration: true,
    });
    const rawPrompt = buildAgentSystemPrompt({
      ...base,
      promptMode: "none",
      proactiveSubagentOrchestration: true,
    });

    expect(maxPrompt).not.toContain("## Proactive Sub-Agent Orchestration");
    expect(ultraPrompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(ultraPrompt).toContain("Ultra active");
    expect(ultraPrompt).not.toContain("Mode: prefer");
    expect(deferredUltraPrompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(minimalUltraPrompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(unavailablePrompt).not.toContain("## Proactive Sub-Agent Orchestration");
    expect(unavailablePrompt).toContain("## Ultra Execution");
    expect(unavailablePrompt).toContain("verify the result before replying");
    expect(unavailablePrompt).not.toContain("Use `sessions_spawn` when independent work");
    expect(rawPrompt).not.toContain("## Proactive Sub-Agent Orchestration");
  });
});
