import { expect, it } from "vitest";
import {
  createPluginBoundaryReport,
  isPluginCompatEligibleForRemoval,
} from "../../scripts/plugin-boundary-report.js";

type CompatRecord = {
  code: string;
  readerSample: string[];
  removeAfter?: string;
  removalGate?: string;
  eligibleForRemoval?: boolean;
};

it("emits compact CI-safe summary JSON", () => {
  const summaryResult = createPluginBoundaryReport(["--summary", "--json"]);
  const summary = JSON.parse(summaryResult.stdout) as {
    compat: { removalPending: CompatRecord[]; removalPendingCount: number };
    memoryHostSdk: { implementation: string };
  };

  expect(summaryResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(summary).toHaveProperty("compat.removalPendingDueCount", expect.any(Number));
  expect(summary.compat.removalPendingCount).toBe(summary.compat.removalPending.length);
  expect(summary.compat.removalPendingCount).toBeGreaterThan(0);
  expect(["private-core-bridge", "private-package-core-integrated"]).toContain(
    summary.memoryHostSdk.implementation,
  );
  for (const record of summary.compat.removalPending) {
    expect(record).toMatchObject({
      removeAfter: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      blocker: expect.stringMatching(/retain|replacement/iu),
      readerCount: expect.any(Number),
      dueForReview: expect.any(Boolean),
    });
    expect(record.readerSample).toEqual(record.readerSample.map(() => expect.any(String)));
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

it("renders removal-pending blockers and reader references without changing fail gates", () => {
  const result = createPluginBoundaryReport(["--summary"]);

  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  expect(result.stdout).toMatch(/removalPending=\d+/u);
  expect(result.stdout).toMatch(/blocker=.*retain the public/iu);
  expect(result.stdout).toMatch(/readerRefs=\d+ readers=/u);
});

it("reports the inbound reply dispatch undated stable-release gate as date-ineligible", () => {
  const jsonResult = createPluginBoundaryReport(["--json", "--owner", "channel"]);
  const report = JSON.parse(jsonResult.stdout) as { compat: { records: CompatRecord[] } };
  const record = report.compat.records.find(
    (candidate) => candidate.code === "plugin-sdk-inbound-reply-dispatch-subpath",
  );

  expect(jsonResult.exitCode).toBe(0);
  expect(record).toMatchObject({
    removalGate: "stable-deprecation-period",
    eligibleForRemoval: false,
  });
  expect(record?.removeAfter).toBeUndefined();

  const textResult = createPluginBoundaryReport(["--owner", "channel"]);
  expect(textResult.stdout).toContain(
    "stable-deprecation-period plugin-sdk-inbound-reply-dispatch-subpath",
  );
  expect(textResult.stdout).not.toContain("no-date plugin-sdk-inbound-reply-dispatch-subpath");
});
