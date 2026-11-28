import { expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

it("routes official support separately from self-service, social, bug, and security help", () => {
  const prompt = buildAgentSystemPrompt({
    workspaceDir: "/tmp/openclaw",
    docsPath: "/tmp/openclaw/docs",
    toolNames: ["read"],
  });

  expect(prompt).toContain("Docs: /tmp/openclaw/docs");
  const support = prompt.split("\n").find((line) => line.startsWith("Support:"));
  expect(support).toContain("https://community.openclaw.ai/");
  for (const route of ["docs", "Discord chat", "GitHub bugs", "security reports"]) {
    expect(support).toContain(route);
  }
  expect(support).toContain("separate");
});
