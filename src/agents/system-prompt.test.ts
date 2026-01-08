import { describe, expect, it } from "vitest";
import { buildAgentSystemPromptAppend } from "./system-prompt.js";

describe("buildAgentSystemPromptAppend", () => {
  it("includes owner numbers when provided", () => {
    const prompt = buildAgentSystemPromptAppend({
      workspaceDir: "/tmp/clawd",
      ownerNumbers: ["+123", " +456 ", ""],
    });

    expect(prompt).toContain("## User Identity");
    expect(prompt).toContain(
      "Owner numbers: +123, +456. Treat messages from these numbers as the user.",
    );
  });

  it("omits owner section when numbers are missing", () => {
    const prompt = buildAgentSystemPromptAppend({
      workspaceDir: "/tmp/clawd",
    });

    expect(prompt).not.toContain("## User Identity");
    expect(prompt).not.toContain("Owner numbers:");
  });

  it("adds reasoning tag hint when enabled", () => {
    const prompt = buildAgentSystemPromptAppend({
      workspaceDir: "/tmp/clawd",
      reasoningTagHint: true,
    });

    expect(prompt).toContain("## Reasoning Format");
    expect(prompt).toContain("<think>...</think>");
    expect(prompt).toContain("<final>...</final>");
  });

  it("lists available tools when provided", () => {
    const prompt = buildAgentSystemPromptAppend({
      workspaceDir: "/tmp/clawd",
      toolNames: ["bash", "sessions_list", "sessions_history", "sessions_send"],
    });

    expect(prompt).toContain("Tool availability (filtered by policy):");
    expect(prompt).toContain("sessions_list");
    expect(prompt).toContain("sessions_history");
    expect(prompt).toContain("sessions_send");
  });

  it("includes user time when provided", () => {
    const prompt = buildAgentSystemPromptAppend({
      workspaceDir: "/tmp/clawd",
      userTimezone: "America/Chicago",
      userTime: "Monday 2026-01-05 15:26",
    });

    expect(prompt).toContain("## Time");
    expect(prompt).toContain("User timezone: America/Chicago");
    expect(prompt).toContain("Current user time: Monday 2026-01-05 15:26");
  });

  it("includes model alias guidance when aliases are provided", () => {
    const prompt = buildAgentSystemPromptAppend({
      workspaceDir: "/tmp/clawd",
      modelAliasLines: [
        "- Opus: anthropic/claude-opus-4-5",
        "- Sonnet: anthropic/claude-sonnet-4-5",
      ],
    });

    expect(prompt).toContain("## Model Aliases");
    expect(prompt).toContain("Prefer aliases when specifying model overrides");
    expect(prompt).toContain("- Opus: anthropic/claude-opus-4-5");
  });

  it("adds gateway self-update guidance when gateway tool is available", () => {
    const prompt = buildAgentSystemPromptAppend({
      workspaceDir: "/tmp/clawd",
      toolNames: ["gateway", "bash"],
    });

    expect(prompt).toContain("## Gateway Self-Update");
    expect(prompt).toContain("config.apply");
    expect(prompt).toContain("update.run");
  });
});
