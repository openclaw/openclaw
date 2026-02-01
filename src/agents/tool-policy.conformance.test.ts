import { describe, expect, test } from "vitest";
import { TOOL_POLICY_CONFORMANCE } from "./tool-policy.conformance.js";
import { TOOL_GROUPS } from "./tool-policy.js";

describe("TOOL_POLICY_CONFORMANCE", () => {
  test("matches exported TOOL_GROUPS exactly", () => {
    expect(TOOL_POLICY_CONFORMANCE.toolGroups).toEqual(TOOL_GROUPS);
  });

  test("is JSON-serializable", () => {
    expect(() => JSON.stringify(TOOL_POLICY_CONFORMANCE)).not.toThrow();
  });
});
