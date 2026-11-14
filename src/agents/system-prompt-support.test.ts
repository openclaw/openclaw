import { expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

it("routes official support separately from self-service, social, bug, and security help", () => {
  const prompt = buildAgentSystemPrompt({
    workspaceDir: "/tmp/openclaw",
    docsPath: "/tmp/openclaw/docs",
    toolNames: ["read"],
  });

  expect(prompt).toContain("Docs: /tmp/openclaw/docs");
  expect(prompt).toContain("For official OpenClaw support, visit https://community.openclaw.ai/.");
  expect(prompt).toContain(
    "Keep self-service docs, Discord social chat, reproducible GitHub bug reports, and private security reporting separate.",
  );
});
