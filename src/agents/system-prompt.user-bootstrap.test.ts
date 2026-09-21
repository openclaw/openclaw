import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("USER prompt context", () => {
  it("adds USER guidance when a user-model file is present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [{ path: "USER.md", content: "- Prefer concise answers." }],
    });

    expect(prompt).toContain(
      "USER.md: durable user preferences and profile directives; follow unless higher-priority instructions override.",
    );
  });

  it("keeps shared preferences before the current person's overlay", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      contextFiles: [
        { path: "/workspace/USER.md", content: "Shared preferences" },
        { path: "/workspace/users/person/USER.md", content: "Personal preferences" },
      ],
    });
    expect(prompt.indexOf("Shared preferences")).toBeLessThan(
      prompt.indexOf("Personal preferences"),
    );
    expect(prompt).toContain("applies only to the current requester");
  });
});
