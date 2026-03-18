import { describe, expect, it } from "vitest";
import { buildToolCardSidebarContent, extractToolCards } from "./tool-cards.ts";

describe("tool-cards", () => {
  it("extracts tool call arguments from message content", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [{ type: "tool_call", name: "sessions_spawn", arguments: { runtime: "acp", task: "fix it" } }],
    });

    expect(cards).toEqual([
      { kind: "call", name: "sessions_spawn", args: { runtime: "acp", task: "fix it" } },
    ]);
  });

  it("includes pretty-printed request arguments in sidebar content for completed tool calls", () => {
    const content = buildToolCardSidebarContent({
      kind: "call",
      name: "sessions_spawn",
      args: { runtime: "acp", task: "fix it" },
    });

    expect(content).toContain("## Sessions Spawn");
    expect(content).toContain("**Arguments:**");
    expect(content).toContain('"runtime": "acp"');
    expect(content).toContain('"task": "fix it"');
    expect(content).toContain("No output — tool completed successfully.");
  });

  it("prefers tool output when present", () => {
    const content = buildToolCardSidebarContent({
      kind: "result",
      name: "exec",
      args: { command: "echo ok" },
      text: "ok",
    });

    expect(content).toContain("ok");
    expect(content).not.toContain("**Arguments:**");
  });
});
