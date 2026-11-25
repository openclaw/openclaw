import { expect, it } from "vitest";
import {
  createPluginBoundaryReport,
  isPluginCompatEligibleForRemoval,
} from "../../scripts/plugin-boundary-report.js";

type CompatRecord = {
  readerSample: string[];
};

it("emits compact CI-safe summary JSON", () => {
  const summaryResult = createPluginBoundaryReport(["--summary", "--json"]);
  const summary = JSON.parse(summaryResult.stdout) as {
    compat: { removalPending: CompatRecord[]; removalPendingCount: number };
  };

  expect(summaryResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(summary.compat.removalPendingCount).toBe(summary.compat.removalPending.length);
  for (const record of summary.compat.removalPending) {
    expect(record.readerSample.length).toBeLessThanOrEqual(5);
  }
});

it.each([
  ["2026-08-12", "2026-08-12T23:59:59.999Z", false],
  ["2026-08-12", "2026-08-13T00:00:00.000Z", true],
  [undefined, "2026-08-13T00:00:00.000Z", false],
])("treats %s at %s as eligible=%s", (removeAfter, now, eligible) => {
  expect(isPluginCompatEligibleForRemoval(removeAfter, new Date(now))).toBe(eligible);
});

it("reports the inbound reply dispatch undated stable-release gate as date-ineligible", () => {
  const json = createPluginBoundaryReport(["--json", "--owner", "channel"]);
  expect(JSON.parse(json.stdout)).toMatchObject({
    compat: {
      records: expect.arrayContaining([
        expect.objectContaining({
          code: "plugin-sdk-inbound-reply-dispatch-subpath",
          removalGate: "stable-deprecation-period",
          eligibleForRemoval: false,
        }),
      ]),
    },
  });
  const textResult = createPluginBoundaryReport(["--owner", "channel"]);
  expect(textResult.stdout).toContain(
    "stable-deprecation-period plugin-sdk-inbound-reply-dispatch-subpath",
  );
  expect(textResult.stdout).not.toContain("no-date plugin-sdk-inbound-reply-dispatch-subpath");
});
