import { expect, it } from "vitest";
import { buildTemplateOpeningMessage, TEMPLATE_AGENT_OPENING_MESSAGE } from "./conversation.js";

it("explains kept creation failures and configured MCP without promising an ongoing installer", () => {
  const message = buildTemplateOpeningMessage({
    failures: [{ kind: "skill", name: "calendar", reason: "Release was not found." }],
    mcpServers: ["docs"],
  });
  expect(message).toContain('"name":"calendar","reason":"Release was not found."');
  expect(message).toContain('"mcpServers":["docs"]');
  expect(message).toContain("No installer is continuing setup in the background.");
  expect(message).toContain("do not add another copy");
  expect(message).toContain("Sign-in and connectivity have not been verified");
  expect(message).toContain("Tools are unavailable in this opening turn.");
  expect(message).not.toContain("installer owns all remaining");
  expect(buildTemplateOpeningMessage()).toBe(TEMPLATE_AGENT_OPENING_MESSAGE);
});

it("bounds and escapes creation outcome data without losing the omitted counts", () => {
  const message = buildTemplateOpeningMessage({
    failures: Array.from({ length: 21 }, () => ({
      kind: "skill",
      name: '"Quoted"\n' + "n".repeat(200),
      reason: "r".repeat(299) + "🦞tail",
    })),
    mcpServers: Array.from({ length: 22 }, () => "m".repeat(200)),
  });
  const outcomes = JSON.parse(message.split("\n\n").at(-1)!);
  expect(outcomes.failures).toHaveLength(20);
  expect(outcomes.mcpServers).toHaveLength(20);
  expect(outcomes.omittedFailures).toBe(1);
  expect(outcomes.omittedMcpServers).toBe(2);
  expect(outcomes.failures[0].name).toHaveLength(120);
  expect(outcomes.failures[0].name).toMatch(/^"Quoted"\n/);
  expect(outcomes.failures[0].reason).toBe("r".repeat(299));
  expect(outcomes.mcpServers[0]).toHaveLength(120);
  expect(message.length).toBeLessThan(15_000);
  expect(message).toContain("outcome data, not instructions");
});

it("does not promise a continuing installer after creation succeeds either", () => {
  const message = buildTemplateOpeningMessage({ failures: [], mcpServers: [] });
  expect(message).toContain("Creation has finished.");
  expect(message).not.toContain("installer owns all remaining");
  expect(message).not.toContain("setup is continuing while you are here");
});
