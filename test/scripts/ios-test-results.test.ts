import { describe, expect, it } from "vitest";
import { requireExactTestResults } from "../../scripts/lib/ios-test-results.mjs";

const ids = ["OpenClawUITests/Suite/first", "OpenClawUITests/Suite/second"];

function testCase(identifier: string, overrides: Record<string, unknown> = {}) {
  return {
    nodeType: "Test Case",
    nodeIdentifier: `${identifier.split("/").slice(1).join("/")}()`,
    result: "Passed",
    ...overrides,
  };
}

function check(cases: unknown[], bundleOverrides: Record<string, unknown> = {}) {
  return requireExactTestResults(
    {
      testNodes: [
        {
          nodeType: "UI test bundle",
          name: "OpenClawUITests",
          children: cases,
          ...bundleOverrides,
        },
      ],
    },
    ids,
  );
}
const passed = (expectedIds: string[]) =>
  expectedIds.map((testIdentifier) => ({ testIdentifier, testResult: "Passed" }));

const childRuns = (nodeType: string, ...results: string[]) => ({
  children: results.map((runResult) => ({ nodeType, result: runResult })),
});

describe("exact XCTest results", () => {
  it("returns exact methods in requested order, including passing child runs", () => {
    const cases = [testCase(ids[1]!, childRuns("Test Case Run", "Passed")), testCase(ids[0]!)];
    expect(check(cases)).toEqual(passed(ids));
  });

  it.each([
    ["basename", { nodeIdentifier: "testReleaseAgentScreenshot" }, "test-identity-or-result"],
    ["skipped", { result: "Skipped" }, "test-skipped"],
    ["failed", { result: "Failed" }, "test-identity-or-result"],
    ["failed child", childRuns("Test Case Run", "Failed"), "failed-test-child"],
    ["retry to green", childRuns("Repetition", "Passed", "Passed"), "repeated-test"],
    ["multiple runs", childRuns("Test Case Run", "Passed", "Passed"), "repeated-test"],
    ["malformed children", { children: {} }, "invalid-test-children"],
  ])("rejects %s in an otherwise passing device capture", (_name, overrides, error) => {
    const cases = [testCase(ids[0]!, overrides), testCase(ids[1]!)];
    expect(() => check(cases)).toThrow(error);
  });

  it.each([
    ["wrong target", { name: "OtherUITests" }],
    ["unit bundle", { nodeType: "Unit test bundle" }],
  ])("rejects %s for a passing qualification method", (_name, overrides) => {
    const cases = ids.map((id) => testCase(id));
    expect(() => check(cases, overrides)).toThrow("test-identity-or-result");
  });

  it.each([
    ["missing", ids.slice(1)],
    ["duplicate replacing a missing method", [ids[0]!, ids[0]!]],
  ])(
    "rejects %s tests even when the result count or aggregate result appears valid",
    (_name, tests) => {
      const cases = tests.map((id) => testCase(id));
      expect(() => check(cases)).toThrow("test-identity-or-result");
    },
  );

  it.each([{}, { testNodes: [] }, { testNodes: [null] }])(
    "rejects missing or malformed test nodes: %j",
    (tree) => {
      expect(() => requireExactTestResults(tree, ids)).toThrow();
    },
  );
});
