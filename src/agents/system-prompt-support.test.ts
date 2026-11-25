import { expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

it("routes official support separately from self-service, social, bug, and security help", () => {
  const prompt = buildAgentSystemPrompt({
    workspaceDir: "/tmp/openclaw",
    docsPath: "/tmp/openclaw/docs",
    toolNames: ["read"],
  });

  expect(prompt).toContain("Docs: /tmp/openclaw/docs");
  expect(prompt).toContain(
    "Support: https://community.openclaw.ai/ (keep docs, Discord chat, GitHub bugs, and security reports separate).",
  );
});
