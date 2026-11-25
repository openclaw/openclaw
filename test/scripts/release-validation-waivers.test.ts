import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  composeReleaseAttemptJobs,
  terminalPolicyPass,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  decodeReleaseValidationSource,
  evaluateReleaseChildPolicy,
  parseReleaseValidationWaivers,
  readReleaseValidationWaivers,
  readReleaseValidationWaiversAsync,
  releaseQualificationExemptions,
} from "../../scripts/lib/release-validation-waivers.mjs";

it("authenticates the exact Q policy blob and rejects changed content or schema", () => {
  const bytes = Buffer.from(
    JSON.stringify({ schema: "openclaw.release-validation-waivers/v1", waivers: [] }),
  );
  const payload = {
    path: "scripts/lib/release-validation-waivers.json",
    type: "file",
    encoding: "base64",
    content: bytes.toString("base64"),
    size: bytes.length,
    sha: createHash("sha1")
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex"),
  };
  expect(
    parseReleaseValidationWaivers(decodeReleaseValidationSource(payload, payload.path)),
  ).toEqual([]);
  expect(() =>
    decodeReleaseValidationSource(
      {
        ...payload,
        content: Buffer.alloc(bytes.length).toString("base64"),
      },
      payload.path,
    ),
  ).toThrow("blob mismatch");
  expect(() => parseReleaseValidationWaivers('{"schema":"unknown","waivers":[]}')).toThrow(
    "Invalid release waiver policy",
  );
});

const targetVersion = "2099.1.1";
const targetSha = "a".repeat(40);
const leaf = { name: "synthetic test", status: "completed", conclusion: "cancelled" };
const child = { key: "normalCi", status: "completed", conclusion: "cancelled", jobs: [leaf] };
const grant = { targetVersion, targetSha, childRole: child.key, reason: "Synthetic approval" };
it("keeps main empty and never falls back from a missing or invalid Q ledger", async () => {
  expect(evaluateReleaseChildPolicy({ child, targetVersion }).waivers).toEqual([]);
  expect(terminalPolicyPass(child, targetVersion)).toBe(false);
  expect(releaseQualificationExemptions(targetVersion, "stable")).toEqual([]);
  for (const message of ["HTTP 404", "HTTP 403"]) {
    const paths: string[] = [];
    const missing = (path: string): string => {
      paths.push(path);
      throw new Error(message);
    };
    expect(() => readReleaseValidationWaivers(missing)).toThrow(message);
    await expect(readReleaseValidationWaiversAsync(missing)).rejects.toThrow(message);
    expect(paths).toEqual(Array(2).fill("scripts/lib/release-validation-waivers.json"));
  }
  expect(() => readReleaseValidationWaivers(() => "corrupt JSON")).toThrow();
  const source = JSON.stringify({
    schema: "openclaw.release-validation-waivers/v1",
    waivers: [grant],
  });
  expect(readReleaseValidationWaivers(() => source)).toEqual([grant]);
  await expect(readReleaseValidationWaiversAsync(async () => source)).resolves.toEqual([grant]);
});

it("does not promote frozen outcome- or aggregate-specific approvals to broad grants", () => {
  const failure = { ...leaf, conclusion: "failure" };
  const plain = { ...grant, jobName: leaf.name };
  const frozen = parseReleaseValidationWaivers(
    JSON.stringify({
      schema: "openclaw.release-validation-waivers/v1",
      waivers: [
        { ...plain, aggregates: [] },
        { ...plain, aggregates: [], cancelledStep: "Run workload" },
        { ...plain, aggregates: [], evidence: { runId: "1", runAttempt: 1 } },
        { ...plain, aggregates: [{ jobName: "gate", stepName: "Verify", causes: [leaf.name] }] },
      ],
    }),
  );
  expect(terminalPolicyPass(child, targetVersion, targetSha, frozen, [leaf.name])).toBe(false);
  const failed = { ...child, conclusion: "failure", jobs: [failure] };
  expect(terminalPolicyPass(failed, targetVersion, targetSha, frozen.slice(1), [leaf.name])).toBe(
    false,
  );
  expect(
    evaluateReleaseChildPolicy({ child: failed, targetVersion, targetSha, waiverPolicy: frozen })
      .waivers,
  ).toEqual([plain]);
});

it("waives a whole child and its cancelled and never-run descendants without rewriting evidence", () => {
  const requiredJobs = [leaf.name, "never ran"];
  expect(terminalPolicyPass(child, targetVersion, targetSha, [grant], requiredJobs)).toBe(true);
  expect(terminalPolicyPass(child, targetVersion, "b".repeat(40), [grant], requiredJobs)).toBe(
    false,
  );
  expect(
    terminalPolicyPass(
      child,
      targetVersion,
      targetSha,
      [{ ...grant, jobName: leaf.name }],
      requiredJobs,
    ),
  ).toBe(false);
  expect(child.jobs).toEqual([leaf]);
  expect(child.conclusion).toBe("cancelled");
});

it("waives a named job only if its authenticated first incomplete step matches the optional selector", () => {
  const policy = [{ ...grant, jobName: leaf.name, step: "Run workload" }];
  for (const conclusion of ["cancelled", "failure"]) {
    const steps = [
      { name: "Setup", conclusion: "success" },
      { name: "Run workload", conclusion },
      { name: "Cleanup", conclusion: "failure" },
    ];
    const { jobs } = composeReleaseAttemptJobs(
      [{ runAttempt: 1, jobs: [{ ...leaf, conclusion, steps }] }],
      { plannedRunAttempt: 1, effectiveRunAttempt: 1 },
    );
    const observed = { ...child, conclusion, jobs };
    expect(terminalPolicyPass(observed, targetVersion, targetSha, policy, [leaf.name])).toBe(true);
    expect(
      terminalPolicyPass(
        observed,
        targetVersion,
        targetSha,
        [{ ...policy[0]!, step: "Cleanup" }],
        [leaf.name],
      ),
    ).toBe(false);
    expect(
      terminalPolicyPass({ ...observed, jobs: [] }, targetVersion, targetSha, policy, [leaf.name]),
    ).toBe(false);
  }
});
