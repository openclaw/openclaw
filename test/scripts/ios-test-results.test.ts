import { describe, expect, it } from "vitest";
import { requireExactTestResults } from "../../scripts/lib/ios-test-results.mjs";

const SCREENSHOT_TESTS = [
  "OpenClawUITests/OpenClawSnapshotUITests/testReleaseControlScreenshot",
  "OpenClawUITests/OpenClawSnapshotUITests/testReleaseChatScreenshot",
  "OpenClawUITests/OpenClawSnapshotUITests/testReleaseAgentScreenshot",
  "OpenClawUITests/OpenClawSnapshotUITests/testReleaseSettingsScreenshot",
];
const QUALIFICATION_TEST =
  "OpenClawUITests/OpenClawSnapshotUITests/testLiveGatewayPairChatAndRelaunch";

function testCase(identifier: string, overrides: Record<string, unknown> = {}) {
  return {
    nodeType: "Test Case",
    nodeIdentifier: `${identifier.split("/").slice(1).join("/")}()`,
    result: "Passed",
    ...overrides,
  };
}

function result(cases: unknown[], bundleOverrides: Record<string, unknown> = {}) {
  return {
    testNodes: [
      {
        nodeType: "Test Plan",
        children: [
          {
            nodeType: "UI test bundle",
            name: "OpenClawUITests",
            children: [{ nodeType: "Test Suite", children: cases }],
            ...bundleOverrides,
          },
        ],
      },
    ],
  };
}

const childRuns = (nodeType: string, ...results: string[]) => ({
  children: results.map((runResult) => ({ nodeType, result: runResult })),
});

describe("exact XCTest results", () => {
  it("accepts one qualification method under its exact UI bundle", () => {
    expect(
      requireExactTestResults(
        result([testCase(QUALIFICATION_TEST, childRuns("Test Case Run", "Passed"))]),
        [QUALIFICATION_TEST],
      ),
    ).toEqual([{ testIdentifier: QUALIFICATION_TEST, testResult: "Passed" }]);
  });

  it("returns all four screenshot methods in requested order regardless of XCTest order", () => {
    const tree = result(SCREENSHOT_TESTS.toSorted().map((identifier) => testCase(identifier)));
    expect(requireExactTestResults(tree, SCREENSHOT_TESTS)).toEqual([
      { testIdentifier: SCREENSHOT_TESTS[0], testResult: "Passed" },
      { testIdentifier: SCREENSHOT_TESTS[1], testResult: "Passed" },
      { testIdentifier: SCREENSHOT_TESTS[2], testResult: "Passed" },
      { testIdentifier: SCREENSHOT_TESTS[3], testResult: "Passed" },
    ]);
  });

  it.each([
    ["basename", { nodeIdentifier: "testReleaseAgentScreenshot" }, "test-identity-or-result"],
    ["skipped", { result: "Skipped" }, "test-skipped"],
    ["failed", { result: "Failed" }, "test-identity-or-result"],
    ["expected failure", { result: "Expected Failure" }, "test-identity-or-result"],
    ["failed child", childRuns("Test Case Run", "Failed"), "failed-test-child"],
    ["retry to green", childRuns("Repetition", "Passed", "Passed"), "repeated-test"],
    ["multiple runs", childRuns("Test Case Run", "Passed", "Passed"), "repeated-test"],
    ["malformed children", { children: {} }, "invalid-test-children"],
  ])("rejects %s in an otherwise passing device capture", (_name, overrides, error) => {
    const cases = SCREENSHOT_TESTS.map((identifier) => testCase(identifier));
    cases[2] = testCase(SCREENSHOT_TESTS[2]!, overrides);
    expect(() => requireExactTestResults(result(cases), SCREENSHOT_TESTS)).toThrow(error);
  });

  it.each([
    ["wrong target", { name: "OtherUITests" }],
    ["unit bundle", { nodeType: "Unit test bundle" }],
  ])("rejects %s for a passing qualification method", (_name, overrides) => {
    expect(() =>
      requireExactTestResults(result([testCase(QUALIFICATION_TEST)], overrides), [
        QUALIFICATION_TEST,
      ]),
    ).toThrow("test-identity-or-result");
  });

  it.each([
    ["missing", SCREENSHOT_TESTS.slice(1)],
    ["extra", [...SCREENSHOT_TESTS, QUALIFICATION_TEST]],
    ["duplicate replacing a missing method", [...SCREENSHOT_TESTS.slice(1), SCREENSHOT_TESTS[1]!]],
    ["unexpected replacing a required method", [...SCREENSHOT_TESTS.slice(1), QUALIFICATION_TEST]],
  ])(
    "rejects %s tests even when the result count or aggregate result appears valid",
    (_name, tests) => {
      expect(() =>
        requireExactTestResults(
          result(tests.map((identifier) => testCase(identifier))),
          SCREENSHOT_TESTS,
        ),
      ).toThrow("test-identity-or-result");
    },
  );

  it.each([{}, { testNodes: {} }, { testNodes: [] }, { testNodes: [null] }])(
    "rejects missing or malformed test nodes: %j",
    (tree) => {
      expect(() => requireExactTestResults(tree, [QUALIFICATION_TEST])).toThrow();
    },
  );
});
