import { expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

it.each([
  { toolNames: ["secrets"], capabilityToolNames: [], available: true },
  { toolNames: ["gateway", "secrets"], capabilityToolNames: [], available: true },
  { toolNames: ["exec", "wait"], capabilityToolNames: ["secrets"], available: true },
  { toolNames: ["gateway"], capabilityToolNames: [], available: false },
  { toolNames: [], capabilityToolNames: [], available: false },
])("projects credential discovery for admitted tools: %j", ({ available, ...params }) => {
  const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", ...params });
  expect(prompt.includes("use `secrets` for masked entry")).toBe(available);
  expect(prompt.includes("Discover its schema first if deferred")).toBe(available);
  expect(prompt).toContain("Use or store credentials the user supplies as requested");
  expect(prompt.includes("never ask for plaintext credentials in chat")).toBe(available);
  if (available) {
    expect(prompt).toContain("check the supported consumer, list metadata");
  }
});
