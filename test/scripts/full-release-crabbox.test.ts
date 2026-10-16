import { describe, expect, it } from "vitest";
import { planRunnerAdmissions } from "../../scripts/full-release-crabbox.mjs";

const label = "crabbox-frv-012345abcdef";
const four = "blacksmith-4vcpu-ubuntu-2404";
const sixteen = "blacksmith-16vcpu-ubuntu-2404";
const queued = (id: number, baseline = four) => ({
  id,
  status: "queued",
  labels: [`${label}-${baseline}`],
});

describe("release Crabbox runner admission", () => {
  it("shares a bounded pool across resource classes without dropping larger capacity", () => {
    const jobs = [queued(1), queued(2), queued(3), queued(4, sixteen)];
    const admissions = planRunnerAdmissions(jobs, label, [], 3);
    expect(admissions).toEqual([
      { baseline: four, type: "c7a.xlarge", arch: "amd64" },
      { baseline: sixteen, type: "c7a.4xlarge", arch: "amd64" },
      { baseline: four, type: "c7a.xlarge", arch: "amd64" },
    ]);
  });

  it("reserves provisioning and idle slots while replacing only unmet demand", () => {
    const leases = [
      { name: "starting", baseline: four },
      { name: "working", baseline: sixteen },
    ];
    const jobs = [
      queued(1),
      queued(2),
      queued(3, sixteen),
      { ...queued(4, sixteen), status: "in_progress", runner_name: "working" },
    ];
    expect(planRunnerAdmissions(jobs, label, leases, 4)).toEqual([
      { baseline: four, type: "c7a.xlarge", arch: "amd64" },
      { baseline: sixteen, type: "c7a.4xlarge", arch: "amd64" },
    ]);
    expect(planRunnerAdmissions(jobs, label, leases, 2)).toEqual([]);
    expect(planRunnerAdmissions([queued(1)], label, [leases[0]], 2)).toEqual([]);
  });

  it("ignores unrelated queues and completed or already running jobs", () => {
    expect(
      planRunnerAdmissions(
        [
          { ...queued(1), labels: [four] },
          { ...queued(2), status: "completed" },
          { ...queued(3), status: "in_progress" },
        ],
        label,
        [],
        10,
      ),
    ).toEqual([]);
  });

  it.each(["macos-latest", "windows-latest", "unknown-linux-size"])(
    "refuses campaign demand for unsupported platform or capacity %s",
    (baseline) => {
      expect(() => planRunnerAdmissions([queued(1, baseline)], label, [], 10)).toThrow(
        "Unsupported Crabbox runner labels",
      );
    },
  );

  it("refuses raw shared capacity labels even when the campaign label is present", () => {
    expect(() =>
      planRunnerAdmissions(
        [{ ...queued(1), labels: ["self-hosted", "crabbox", label, four] }],
        label,
        [],
        10,
      ),
    ).toThrow("Unsupported Crabbox runner labels");
    expect(() =>
      planRunnerAdmissions(
        [{ ...queued(1), labels: [label, `crabbox-frv-ffffffffffff-${four}`] }],
        label,
        [],
        10,
      ),
    ).toThrow("Unsupported Crabbox runner labels");
  });

  it("refuses ambiguous capacity requirements instead of choosing one", () => {
    expect(() =>
      planRunnerAdmissions(
        [{ ...queued(1), labels: [label, `${label}-${four}`, `${label}-${sixteen}`] }],
        label,
        [],
        10,
      ),
    ).toThrow("Unsupported Crabbox runner labels");
  });
});
