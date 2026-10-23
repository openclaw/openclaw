import { expect, it } from "vitest";
import {
  createPluginBoundaryReport,
  isPluginCompatEligibleForRemoval,
} from "../../scripts/plugin-boundary-report.js";

const originalPendingCodes = new Set([
  "sdk-untrusted-context-identifier-aliases",
  "plugin-sdk-media-understanding-public-demotion",
  "plugin-sdk-memory-host-core-public-demotion",
  "plugin-sdk-plugin-config-runtime-public-demotion",
]);
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
    compat: { removalPending: CompatRecord[] };
    memoryHostSdk: { implementation: string };
  };

  expect(summaryResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(summary).toMatchObject({
    compat: { removalPendingCount: 15, removalPendingDueCount: expect.any(Number) },
  });
  expect(["private-core-bridge", "private-package-core-integrated"]).toContain(
    summary.memoryHostSdk.implementation,
  );
  expect(summary.compat.removalPending.map((record) => record.code)).toEqual(
    (
      "sdk-untrusted-context-identifier-aliases plugin-sdk-media-understanding-public-demotion " +
      "plugin-sdk-memory-host-core-public-demotion agent-harness-terminal-result-aliases " +
      "message-presentation-legacy-bridges official-plugin-export-aliases " +
      "plugin-sdk-channel-setup-input-fields plugin-runtime-api-compat-aliases " +
      "plugin-provider-manifest-compat-aliases plugin-sdk-provider-owned-helper-shims " +
      "media-legacy-projection memory-host-compatibility-aliases plugin-sdk-broad-runtime-barrels " +
      "plugin-sdk-focused-compat-aliases plugin-sdk-plugin-config-runtime-public-demotion"
    ).split(" "),
  );
  expect(summary.compat.removalPending[0]).toMatchObject({
    removeAfter: "2026-09-08",
    blocker: expect.stringContaining(
      "migration of published plugin readers is verified and explicit breaking-release approval is granted",
    ),
  });
  for (const record of summary.compat.removalPending) {
    expect(record).toMatchObject({
      removeAfter: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      blocker: expect.stringMatching(/retain|replacement/iu),
      readerCount: expect.any(Number),
      dueForReview: expect.any(Boolean),
    });
    if (originalPendingCodes.has(record.code)) {
      expect(record.readerSample).toEqual(expect.arrayContaining([expect.any(String)]));
    } else {
      expect(record.removeAfter).toBe("2026-10-01");
      expect(record.readerSample).toEqual(record.readerSample.map(() => expect.any(String)));
    }
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
  expect(result.stdout).toContain("removalPending=15");
  expect(result.stdout).not.toContain("agent-harness-sdk-alias");
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
