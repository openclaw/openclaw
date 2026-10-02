// Plugin Boundary Report tests cover plugin boundary report script behavior.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPluginBoundaryReport,
  isPluginCompatEligibleForRemoval,
  type PluginBoundaryReportResult,
} from "../../scripts/plugin-boundary-report.js";

describe("plugin-boundary-report", () => {
  let summaryResult: PluginBoundaryReportResult;

  beforeAll(() => {
    summaryResult = createPluginBoundaryReport(["--summary", "--json"]);
  });
  afterEach(() => vi.useRealTimers());

  it("emits compact CI-safe summary JSON", () => {
    const summary = JSON.parse(summaryResult.stdout) as {
      compat?: {
        removalPendingCount?: unknown;
        removalPendingDueCount?: unknown;
        removalPending?: Array<{
          code?: unknown;
          removeAfter?: unknown;
          blocker?: unknown;
          readerCount?: unknown;
          readerSample?: unknown;
          dueForReview?: unknown;
        }>;
      };
      memoryHostSdk?: {
        implementation?: unknown;
      };
    };

    expect(summaryResult.exitCode).toBe(0);
    expect(summaryResult.stderr).toBe("");
    expect(summary.compat?.removalPendingCount).toEqual(expect.any(Number));
    expect(summary.compat?.removalPendingDueCount).toEqual(expect.any(Number));
    expect(summary.compat?.removalPending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "media-legacy-projection", removeAfter: "2026-10-01" }),
        expect.objectContaining({
          code: "plugin-sdk-channel-setup-input-fields",
          removeAfter: "2026-10-01",
        }),
      ]),
    );
    for (const record of summary.compat?.removalPending ?? []) {
      expect(record.removeAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(record.blocker).toEqual(expect.stringMatching(/\S/u));
      expect(record.readerCount).toEqual(expect.any(Number));
      expect(record.readerSample).toEqual(expect.any(Array));
      if (record.readerCount !== 0) {
        expect(record.readerSample).toEqual(expect.arrayContaining([expect.any(String)]));
      }
      expect((record.readerSample as unknown[]).length).toBeLessThanOrEqual(5);
      expect(record.dueForReview).toEqual(expect.any(Boolean));
    }
    expect(["private-core-bridge", "private-package-core-integrated"]).toContain(
      summary.memoryHostSdk?.implementation,
    );
  });

  it("treats removeAfter as the final compatibility day", () => {
    expect(
      isPluginCompatEligibleForRemoval("2026-08-12", new Date("2026-08-12T23:59:59.999Z")),
    ).toBe(false);
    expect(
      isPluginCompatEligibleForRemoval("2026-08-12", new Date("2026-08-13T00:00:00.000Z")),
    ).toBe(true);
    expect(isPluginCompatEligibleForRemoval(undefined, new Date("2026-08-13T00:00:00.000Z"))).toBe(
      false,
    );
  });

  it.each([
    { day: "2026-10-02", exitCode: 0 },
    { day: "2026-12-01", exitCode: 1 },
  ])("preserves pending blockers and dated failure gates on $day", ({ day, exitCode }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${day}T00:00:00Z`));
    const result = createPluginBoundaryReport(["--summary", "--fail-on-eligible-compat"]);

    expect(result.exitCode).toBe(exitCode);
    if (exitCode === 0) {
      expect(result.stderr).toBe("");
    } else {
      expect(result.stderr).toContain("compatibility record(s) are due for removal");
    }
    expect(result.stdout).toMatch(/removalPending=\d+ removalPendingDue=\d+/u);
    expect(result.stdout).toContain("removal-pending 2026-10-01 media-legacy-projection due=true");
    expect(result.stdout).not.toContain("agent-harness-sdk-alias");
    expect(result.stdout).toMatch(/blocker=\S/u);
    expect(result.stdout).toMatch(/readerRefs=\d+ readers=/u);
  });

  it("reports the inbound reply dispatch major-version gate as date-ineligible", () => {
    const jsonResult = createPluginBoundaryReport(["--json", "--owner", "channel"]);
    const report = JSON.parse(jsonResult.stdout) as {
      compat?: {
        records?: Array<{
          code?: unknown;
          removeAfter?: unknown;
          removalGate?: unknown;
          eligibleForRemoval?: unknown;
        }>;
      };
    };
    const record = report.compat?.records?.find(
      (candidate) => candidate.code === "plugin-sdk-inbound-reply-dispatch-subpath",
    );

    expect(jsonResult.exitCode).toBe(0);
    expect(record).toMatchObject({
      removalGate: "next-plugin-sdk-major",
      eligibleForRemoval: false,
    });
    expect(record?.removeAfter).toBeUndefined();

    const textResult = createPluginBoundaryReport(["--owner", "channel"]);
    expect(textResult.stdout).toContain(
      "next-plugin-sdk-major plugin-sdk-inbound-reply-dispatch-subpath",
    );
    expect(textResult.stdout).not.toContain("no-date plugin-sdk-inbound-reply-dispatch-subpath");
  });
});
