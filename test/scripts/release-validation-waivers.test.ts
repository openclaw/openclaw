import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  terminalPolicyPass,
  validateReleaseManifestAdvisoryJobs,
} from "../../scripts/full-release-validation-policy.mjs";
import type { ReleaseValidationWaiver } from "../../scripts/lib/release-validation-waivers.mjs";
import {
  decodeReleaseValidationSource,
  evaluateReleaseChildPolicy,
  parseReleaseValidationWaivers,
  releaseQualificationExemptions,
  readReleaseValidationWaivers,
  readReleaseValidationWaiversAsync,
  validateReleaseWaiverAggregates,
} from "../../scripts/lib/release-validation-waivers.mjs";

describe("immutable Q waiver policy", () => {
  const entry = (jobName: string, cause: string) => ({
    targetVersion: "2099.1.1",
    childRole: "normalCi",
    jobName,
    reason: "Synthetic approval",
    aggregates: [{ jobName: "gate", stepName: "check", causes: [cause], exactCauses: true }],
  });
  it("unions only current failures without mutating policy for subsequent evaluations", () => {
    const source = JSON.stringify({
      schema: "openclaw.release-validation-waivers/v1",
      waivers: [entry("first", "first failed"), entry("second", "second failed")],
    });
    const policy = parseReleaseValidationWaivers(source);
    const evaluate = (names: string[]) =>
      evaluateReleaseChildPolicy({
        targetVersion: "2099.1.1",
        waiverPolicy: policy,
        child: {
          key: "normalCi",
          jobs: names.map((name) => ({ name, status: "completed", conclusion: "failure" })),
        },
      });
    expect(evaluate(["first", "second"]).aggregates[0]?.causes).toEqual([
      "first failed",
      "second failed",
    ]);
    expect(evaluate(["first"]).aggregates[0]?.causes).toEqual(["first failed"]);
    expect(
      JSON.stringify({ schema: "openclaw.release-validation-waivers/v1", waivers: policy }),
    ).toBe(source);
  });
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
});

const targetVersion = "2099.1.1";
const targetSha = "a".repeat(40);
const leaf = { id: 1, name: "synthetic test", status: "completed", conclusion: "failure" };
const gate = {
  ...leaf,
  id: 2,
  name: "synthetic gate",
  steps: [{ name: "Verify results", conclusion: "failure" }],
};
const child = { key: "normalCi", runId: "42", runAttempt: 2, jobs: [leaf, gate] };
const aggregate = {
  jobName: gate.name,
  stepName: "Verify results",
  causes: ["test failed"],
  exactCauses: true,
};
const grant = {
  targetVersion,
  childRole: child.key,
  jobName: leaf.name,
  reason: "Synthetic operator approval",
  aggregates: [aggregate],
};

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

it("matches release-wide grants and explicit candidate or execution restrictions without rewriting failures", () => {
  const evaluate = (
    waiverPolicy: ReleaseValidationWaiver[] = [grant],
    current = child,
    version = targetVersion,
    sha = targetSha,
  ) =>
    evaluateReleaseChildPolicy({
      child: current,
      targetVersion: version,
      targetSha: sha,
      waiverPolicy,
    });
  expect(evaluate().blockingJobs).toEqual([]);
  expect(
    evaluate([grant], { ...child, runId: "99", runAttempt: 5 }, targetVersion, "b".repeat(40))
      .blockingJobs,
  ).toEqual([]);
  expect(evaluate([grant], child, "2099.1.2").waivers).toEqual([]);
  expect(evaluate([grant], { ...child, key: "other" }).waivers).toEqual([]);
  for (const restriction of [
    { targetSha: "b".repeat(40) },
    { evidence: { runId: "42", runAttempt: 1 } },
    { evidence: { runId: "99", runAttempt: 2 } },
  ]) {
    expect(evaluate([{ ...grant, ...restriction }]).waivers).toEqual([]);
  }
  expect(
    evaluate([{ ...grant, targetSha, evidence: { runId: "42", runAttempt: 2 } }]).waivers,
  ).toHaveLength(1);
  for (const conclusion of ["cancelled", "timed_out", "skipped"]) {
    expect(evaluate([grant], { ...child, jobs: [{ ...leaf, conclusion }] }).waivers).toEqual([]);
  }
  expect(
    evaluate([grant], { ...child, jobs: [...child.jobs, { ...leaf, name: "unwaived" }] })
      .blockingJobs,
  ).toMatchObject([{ name: "unwaived" }]);
  expect(() =>
    validateReleaseManifestAdvisoryJobs(
      {
        targetSha,
        validationInputs: { targetVersion },
        childEvidence: { normalCi: { ...child, effectiveRunAttempt: 2 } },
      },
      { waiverPolicy: [{ ...grant, evidence: { runId: "42", runAttempt: 2 } }] },
    ),
  ).not.toThrow();
  expect(child.jobs.every((job) => job.conclusion === "failure")).toBe(true);
});

it("requires complete aggregate evidence with only granted causes and the approved failing step", async () => {
  const policy = evaluateReleaseChildPolicy({ child, targetVersion, waiverPolicy: [grant] });
  const validate = (log = "##[error]test failed", jobs = child.jobs) =>
    validateReleaseWaiverAggregates({ policy, jobs, getJobLog: () => log });
  await expect(validate()).resolves.toBeUndefined();
  for (const log of [
    "",
    "##[error]test failed\n##[error]integrity failed",
    "##[error]test failed\n##[error]test failed",
  ]) {
    await expect(validate(log)).rejects.toThrow("unwaived failure");
  }
  for (const jobs of [
    [leaf],
    [leaf, { ...gate, status: "in_progress" }],
    [leaf, { ...gate, steps: [{ name: "Checkout", conclusion: "failure" }] }],
  ]) {
    await expect(validate(undefined, jobs)).rejects.toThrow();
  }
  const log = "reviewed aggregate bytes";
  const hashed = evaluateReleaseChildPolicy({
    child,
    targetVersion,
    waiverPolicy: [
      {
        ...grant,
        aggregates: [{ ...aggregate, logSha256: createHash("sha256").update(log).digest("hex") }],
      },
    ],
  });
  await expect(
    validateReleaseWaiverAggregates({ policy: hashed, jobs: child.jobs, getJobLog: () => log }),
  ).resolves.toBeUndefined();
  await expect(
    validateReleaseWaiverAggregates({
      policy: hashed,
      jobs: child.jobs,
      getJobLog: () => log + "changed",
    }),
  ).rejects.toThrow("differs from reviewed evidence");
});

it("matches explicit test signatures only with a complete report and approved failing step", async () => {
  const testLeaf = { ...leaf, steps: [{ name: "Run tests", conclusion: "failure" }] };
  const log = [
    "[shard:unit] [test] inner parallelism 1",
    "[shard:unit] [test] starting test/vitest/vitest.unit.config.ts",
    "[shard:unit] FAIL unit test/synthetic.test.ts > synthetic failure",
    "[shard:unit] AssertionError: synthetic mismatch",
    "[shard:unit] Test Files 1 failed (1)",
    "[shard:unit] Tests 1 failed (1)",
    "[shard:unit] [test] failed 1 Vitest shard in 1s",
    "[shard:unit] [test] FAILED (exit 1)",
    '[shard:completion] {"version":1,"planned":1,"completed":1,"invocations":1,"failedInvocations":1}',
  ].join("\n");
  const policy = evaluateReleaseChildPolicy({
    child: { ...child, jobs: [testLeaf] },
    targetVersion,
    waiverPolicy: [
      {
        ...grant,
        aggregates: [],
        testFailures: {
          stepName: "Run tests",
          signatures: [
            {
              kind: "vitest",
              file: "test/synthetic.test.ts",
              test: "synthetic failure :: AssertionError: synthetic mismatch",
            },
          ],
        },
      },
    ],
  });
  const validate = (text = log, job = testLeaf) =>
    validateReleaseWaiverAggregates({ policy, jobs: [job], getJobLog: () => text });
  await expect(validate()).resolves.toBeUndefined();
  const timestampedLog = log
    .split("\n")
    .map((line) => `\uFEFF2026-11-22T04:00:00.0000000Z ${line}`)
    .join("\n");
  await expect(validate(timestampedLog)).resolves.toBeUndefined();
  for (const changed of [
    log.replace("synthetic failure", "different failure"),
    log.replace('"completed":1', '"completed":0'),
    timestampedLog.replace('"completed":1', '"completed":0'),
  ]) {
    await expect(validate(changed)).rejects.toThrow();
  }
  await expect(
    validate(log, { ...testLeaf, steps: [{ name: "Setup", conclusion: "failure" }] }),
  ).rejects.toThrow("non-policy failure");
});
