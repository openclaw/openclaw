import { describe, expect, it } from "vitest";
import lanes from "../../scripts/lib/release-validation-waivable-lanes.json" with { type: "json" };
import {
  formatReleaseValidationWaivers,
  parseReleaseValidationWaivers,
  validateLegacyReleaseTelegramWaiver,
  type ReleaseValidationWaivers,
} from "../../scripts/lib/release-validation-waivers.mjs";

const declaration = (): ReleaseValidationWaivers => ({
  schema: "openclaw.release-validation-waivers/v1",
  targetVersion: "2026.10.4",
  candidateSha: "383c124cc32ffee3f8e56f549b88da94d269a4af",
  parentRunId: "38774938703",
  parentRunAttempt: 1,
  waivers: [
    {
      childRole: "releaseChecksIndependent",
      childRunId: "38775999936",
      childRunAttempt: 2,
      jobName: "Run repo/live E2E validation / Native live suites (Native live Z.AI Coding Plan)",
      suiteId: "native-live-src-agents-zai-coding",
      reason: "Shared Z.AI credential rejected (auth).",
      approvedBy: "release-maintainer",
    },
  ],
});

// Independent hard-gate expectations: changing the data must not admit these.
const hardGates = [
  "openclaw/ci-gate",
  "Run normal full CI",
  "Build Artifacts",
  "Pack qualification",
  "Prepare npm artifacts / Check npm release source",
  "Prepare npm artifacts / Prepare publishable npm package",
  "Prepare npm artifacts / Qualify prepared npm package",
  "Prepare Docker artifacts / Seal prepared Docker images",
  "Seal prepared plugin npm release",
  "Run package acceptance / Package integrity",
  "install_smoke_release_checks / bun_only_runtime_smoke",
  "Run package acceptance / Docker product acceptance (artifact-only) / Docker E2E targeted lanes (published-upgrade-survivor-2026.9.33-scenarios-12)",
  "update-first-hop-compat-linux",
  "Run Docker release-path validation / Gateway E2E",
  "Release soak",
  "OpenClaw source performance probes",
  "plugin-prerelease-suite",
  "Seal full release child evidence / Seal child receipt",
  "Seal release execution plan",
  "Verify sealed release candidate",
  ...["Linux", "Windows", "macOS"].flatMap((os) =>
    ["installer fresh", "packaged fresh", "packaged upgrade"].map(
      (operation) => `cross_os_release_checks / ${os} / ${operation}`,
    ),
  ),
];

describe("publication waiver declaration", () => {
  it("accepts every reviewed exact pair but no artifact, CI, install/upgrade, soak, performance or seal gate", () => {
    const names = new Set<string>();
    for (const [role, suites] of Object.entries(lanes)) {
      for (const [suiteId, jobs] of Object.entries(suites)) {
        for (const jobName of typeof jobs === "string" ? [jobs] : jobs) {
          names.add(jobName);
          const value = declaration();
          Object.assign(value.waivers[0]!, { childRole: role, suiteId, jobName });
          expect(parseReleaseValidationWaivers(JSON.stringify(value))).toEqual(value);
        }
      }
    }
    for (const jobName of hardGates) {
      expect(names.has(jobName)).toBe(false);
      const value = declaration();
      value.waivers[0]!.jobName = jobName;
      expect(() => parseReleaseValidationWaivers(value)).toThrow("not allowlisted");
    }
    const value = declaration();
    value.waivers[0]!.childRole = "normalCi";
    expect(() => parseReleaseValidationWaivers(value)).toThrow("not allowlisted");
    value.waivers[0]!.childRole = "releaseChecksIndependent";
    value.waivers[0]!.suiteId += "-unreviewed";
    expect(() => parseReleaseValidationWaivers(value)).toThrow("not allowlisted");
  });

  it.each([
    { candidateSha: "short" },
    { parentRunId: 38774938703 },
    { parentRunAttempt: "1" },
    { parentRunAttempt: 0 },
    { waivers: [] },
    { unreviewed: true },
  ])("rejects malformed or open-ended envelopes: %j", (fields) => {
    expect(() => parseReleaseValidationWaivers({ ...declaration(), ...fields })).toThrow();
  });

  it.each([
    { childRole: ["releaseChecks"] },
    { childRole: "constructor", suiteId: "name", jobName: "Object" },
    { childRunId: "0" },
    { childRunAttempt: "2" },
    { childRunAttempt: 0 },
    { childRunAttempt: Number.MAX_SAFE_INTEGER + 1 },
    { reason: " " },
    { reason: "x".repeat(2049) },
    { approvedBy: "@maintainer" },
    { unreviewed: true },
  ])("rejects malformed or open-ended lane declarations: %j", (fields) => {
    const value = declaration();
    Object.assign(value.waivers[0]!, fields);
    expect(() => parseReleaseValidationWaivers(value)).toThrow();
  });

  it("bounds JSON and rejects duplicate lanes rather than merging approvals", () => {
    for (const value of [null, [], {}, "not JSON", " ".repeat(65537)]) {
      expect(() => parseReleaseValidationWaivers(value)).toThrow();
    }
    const value = declaration();
    value.waivers.push({ ...value.waivers[0]!, reason: "Another approval" });
    expect(() => parseReleaseValidationWaivers(value)).toThrow("duplicate lane");
    expect(parseReleaseValidationWaivers(undefined)).toBeUndefined();
    expect(parseReleaseValidationWaivers("")).toBeUndefined();
  });

  it("retains only empty legacy fields, preserving original bytes and digests", () => {
    for (const field of ["telegram_waiver", "telegramWaiver"]) {
      for (const wrap of [
        (v: object) => v,
        (v: object) => ({ validationInputs: v }),
        (v: object) => ({ coverage: v }),
        (v: object) => ({ sourceAdmission: { coverage: v } }),
        (v: object) => ({ qualificationInputs: v }),
      ]) {
        const value = wrap({ [field]: "" });
        const bytes = JSON.stringify(value);
        expect(() => validateLegacyReleaseTelegramWaiver(value)).not.toThrow();
        expect(JSON.stringify(value)).toBe(bytes);
        expect(() =>
          validateLegacyReleaseTelegramWaiver(wrap({ [field]: "old-owner-approved" })),
        ).toThrow(/validation_waivers_json.*missing or skipped/u);
      }
    }
  });

  it("discloses failures, exact binding, reason and approver without Markdown injection", () => {
    const value = declaration();
    value.waivers[0]!.reason = "Provider *outage* [incident] <retry> | `auth`\nnot green";
    const output = formatReleaseValidationWaivers(value);
    expect(output).toContain("waived — not a pass");
    expect(output).toContain(value.candidateSha);
    expect(output).toContain("FRV 38774938703, attempt 1");
    expect(output).toContain("run 38775999936, attempt 2");
    expect(output).toContain(
      "Provider \\*outage\\* \\[incident\\] \\<retry\\> \\| \\`auth\\` not green",
    );
    expect(output).toContain("Approver: @release-maintainer");
  });
});
