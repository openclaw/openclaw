import { expect, it } from "vitest";
import { classifyReplay } from "../../scripts/incident-replay.mts";

it("counts only completed behavioral outcomes, not setup or cleanup failures", () => {
  const observed = {
    ready: true,
    positiveControl: true,
    operationsStarted: 1,
    cleanup: true,
    verdict: "pass",
  };
  const passed = { numTotalTests: 1, numPendingTests: 0, numPassedTests: 1, numFailedTests: 0 };
  const failed = { ...passed, numPassedTests: 0, numFailedTests: 1 };
  expect(classifyReplay(0, observed, passed, true)).toBe("pass");
  const regression = { ...observed, verdict: "assertion-failed" };
  expect(classifyReplay(1, regression, failed, true)).toBe("assertion-failed");
  expect(classifyReplay(1, { ...regression, positiveControl: false }, failed, true)).toBe(
    "blocked",
  );
  expect(classifyReplay(null, regression, failed, true)).toBe("blocked");
  expect(classifyReplay(2, regression, failed, true)).toBe("blocked");
  expect(classifyReplay(1, { ...observed, verdict: "blocked" }, failed, true)).toBe("blocked");
  expect(classifyReplay(0, null, passed, true)).toBe("blocked");
  expect(classifyReplay(0, observed, null, true)).toBe("blocked");
  expect(classifyReplay(0, observed, { ...passed, numPendingTests: 1 }, true)).toBe("blocked");
  expect(classifyReplay(0, observed, { ...passed, numTotalTests: 0 }, true)).toBe("blocked");
  expect(classifyReplay(0, { ...observed, cleanup: false }, passed, true)).toBe("cleanup-failed");
  expect(classifyReplay(0, observed, passed, false)).toBe("invalid-input-changed");
});
