import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("system prompt messaging routing", () => {
  it.each(
    (["full", "minimal"] as const).flatMap((promptMode) =>
      [false, true].map((messageAvailable) => ({ promptMode, messageAvailable })),
    ),
  )(
    "keeps messaging routing in $promptMode turns without blocking external CLIs (message=$messageAvailable)",
    ({ promptMode, messageAvailable }) => {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        promptMode,
        toolNames: messageAvailable ? ["exec", "message"] : ["exec"],
        runtimeInfo: { channel: "discord" },
      });

      expect(prompt).toContain(
        "OpenClaw messaging: use available messaging tools, never shell commands, the CLI, curl, or direct RPC.",
      );
      expect(prompt).toContain("Missing messaging tools are not permission to use another route.");
      expect(prompt).toContain("Subagents return results through their accepted completion path");
      expect(prompt).toContain(
        "Other services (e.g. email): user-authorized CLI/API use is allowed",
      );
      expect(prompt).toContain("normal tool permissions and approvals still apply");
      expect(prompt).not.toContain("Provider messaging: never exec/curl");
    },
  );
});
