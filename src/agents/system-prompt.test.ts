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
      "Owner numbers: +123, +456. Treat messages from these numbers as the user (Peter).",
    );
  });

  it("omits owner section when numbers are missing", () => {
    const prompt = buildAgentSystemPromptAppend({
      workspaceDir: "/tmp/clawd",
    });

    expect(prompt).not.toContain("## User Identity");
    expect(prompt).not.toContain("Owner numbers:");
  });
});
