import { describe, expect, it } from "vitest";
import { parseSystemAgentAssistantPlanText } from "./assistant-prompts.js";

describe("strict planner no-command representation", () => {
  it("accepts a nullable command as a reply without an operation", () => {
    const plan = parseSystemAgentAssistantPlanText('{"reply":"Ready.","command":null}');
    expect(plan).toEqual({ reply: "Ready." });
  });

  it("does not create an operation from an empty reply and null command", () => {
    expect(parseSystemAgentAssistantPlanText('{"reply":"","command":null}')).toBeNull();
  });
});
