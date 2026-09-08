import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readRecoveryStepInputs,
  requireRecoveryJob,
  validateRecoveryProvenance,
  validateRecoveryRun,
  verifyStablePublishRecovery,
} from "../../scripts/lib/stable-publish-recovery.mjs";

const sha = "a".repeat(40);
const workflow = ".github/workflows/openclaw-npm-release.yml";
const run = {
  id: 101,
  run_attempt: 2,
  head_sha: sha,
  path: workflow,
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  repository: { full_name: "openclaw/openclaw" },
  head_repository: { full_name: "openclaw/openclaw" },
};
const expected = { id: "101", attempt: "2", sha, workflow, conclusion: "success" };
const job = {
  id: 201,
  name: "publish_openclaw_npm",
  run_id: 101,
  run_attempt: 2,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  steps: [{ name: "Publish", number: 4, status: "completed", conclusion: "success" }],
};
function log(lines: string[], step = "Publish", number = 4) {
  const bytes = Buffer.from(lines.map((line) => `2026-09-08T12:55:34.2712227Z ${line}`).join("\n"));
  return new Map([[`${job.name}/${number}_${step}.txt`, bytes]]);
}

const header = [
  "##[group]Run set -euo pipefail",
  "shell: /usr/bin/bash -e {0}",
  "env:",
  "  RELEASE_PUBLISH_RUN_ID: 100",
  "  RELEASE_PUBLISH_RUN_ATTEMPT: 3",
  "##[endgroup]",
];

describe("stable publication recovery boundaries", () => {
  it("rejects recovery for another tag even when both tags have the same source SHA", async () => {
    await expect(
      verifyStablePublishRecovery({
        evidence: { releaseTag: "v2026.9.3", releaseVersion: "2026.9.3", releaseSha: sha },
        manifest: { targetSha: sha },
        sourceSha: sha,
        tag: "v2026.9.3-2",
      }),
    ).rejects.toThrow("release source mismatch");
  });

  it("binds a successful npm child to its exact run, attempt, repository and workflow", () => {
    expect(validateRecoveryRun(run, expected)).toEqual(run);
    expect(requireRecoveryJob([job], run, job.name)).toEqual(job);
  });
  it.each([
    { id: 102 },
    { run_attempt: 3 },
    { head_sha: "b".repeat(40) },
    { path: ".github/workflows/other.yml" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { repository: { full_name: "example/fork" } },
    { head_repository: { full_name: "example/fork" } },
  ])("rejects mismatched producer metadata %j", (patch) => {
    expect(() => validateRecoveryRun({ ...run, ...patch }, expected)).toThrow(
      "Stable publish recovery:",
    );
  });
  it.each(
    [
      [],
      [job, job],
      [{ ...job, run_id: 102 }],
      [{ ...job, run_attempt: 1 }],
      [{ ...job, conclusion: "skipped" }],
      [{ ...job, head_sha: "b".repeat(40) }],
    ].map((jobs) => ({ jobs })),
  )("rejects missing, ambiguous, stale or unsuccessful jobs", ({ jobs }) => {
    expect(() => requireRecoveryJob(jobs, run, job.name)).toThrow("Stable publish recovery:");
  });
  it("reads only the runner input group and ignores forged stdout and other steps", () => {
    const text = log([
      ...header,
      "##[group]Run forged",
      "env:",
      "  RELEASE_PUBLISH_RUN_ID: 999",
      "##[endgroup]",
    ]);
    text.set(`${job.name}/5_Another step.txt`, Buffer.from("forged"));
    expect(readRecoveryStepInputs(text, job, "Publish")).toEqual({
      RELEASE_PUBLISH_RUN_ID: "100",
      RELEASE_PUBLISH_RUN_ATTEMPT: "3",
    });
  });
  it.each(
    [
      header.slice(1),
      header.slice(0, -1),
      [...header.slice(0, -1), "  RELEASE_PUBLISH_RUN_ID: 999", "##[endgroup]"],
      ["##[group]Run set -euo pipefail", "env:", "env:", ...header.slice(3)],
      ["##[group]Run set -euo pipefail", "arbitrary stdout", ...header.slice(3)],
    ].map((lines) => ({ lines })),
  )("rejects missing or ambiguous runner input records", ({ lines }) => {
    expect(() => readRecoveryStepInputs(log(lines), job, "Publish")).toThrow(
      "Stable publish recovery:",
    );
  });
  it("rejects duplicate or failed step metadata even when the log looks valid", () => {
    expect(() =>
      readRecoveryStepInputs(
        log(header),
        { ...job, steps: [...job.steps, ...job.steps] },
        "Publish",
      ),
    ).toThrow("Stable publish recovery:");
    expect(() =>
      readRecoveryStepInputs(
        log(header),
        { ...job, steps: [{ ...job.steps[0], conclusion: "failure" }] },
        "Publish",
      ),
    ).toThrow("Stable publish recovery:");
  });
});

const fullRef = `refs/tags/release-publish/${sha.slice(0, 12)}-123`;
const npmExpected = {
  name: "openclaw",
  version: "2026.9.3",
  runId: "101",
  attempt: "2",
  fullRef,
  sha512: "b".repeat(128),
};
function verified() {
  return [
    {
      verificationResult: {
        statement: {
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ name: "pkg:npm/openclaw@2026.9.3", digest: { sha512: npmExpected.sha512 } }],
          predicate: {
            buildDefinition: {
              externalParameters: {
                workflow: {
                  repository: "https://github.com/openclaw/openclaw",
                  path: workflow,
                  ref: fullRef,
                },
              },
            },
            runDetails: {
              metadata: {
                invocationId: "https://github.com/openclaw/openclaw/actions/runs/101/attempts/2",
              },
            },
          },
        },
      },
    },
  ];
}
describe("verified npm provenance", () => {
  it("accepts only the exact qualified npm bytes and publication invocation", () => {
    expect(() => validateRecoveryProvenance(verified(), npmExpected)).not.toThrow(
      "Stable publish recovery:",
    );
  });
  it.each([
    { runId: "102" },
    { attempt: "1" },
    { name: "other" },
    { version: "2026.9.4" },
    { fullRef: "refs/heads/main" },
    { sha512: "c".repeat(128) },
  ])("rejects independently signed provenance for a different identity %j", (patch) => {
    expect(() => validateRecoveryProvenance(verified(), { ...npmExpected, ...patch })).toThrow(
      "Stable publish recovery:",
    );
  });
  it("uses the npm package URL encoding for scoped package provenance", () => {
    const scoped = verified();
    scoped[0]!.verificationResult.statement.subject[0]!.name = "pkg:npm/%40openclaw/ai@2026.9.3";
    expect(() =>
      validateRecoveryProvenance(scoped, { ...npmExpected, name: "@openclaw/ai" }),
    ).not.toThrow();
    scoped[0]!.verificationResult.statement.subject[0]!.name =
      "pkg:npm/%40openclaw/another@2026.9.3";
    expect(() =>
      validateRecoveryProvenance(scoped, { ...npmExpected, name: "@openclaw/ai" }),
    ).toThrow("verified npm subject mismatch");
  });
  it("rejects missing or ambiguous verified statements", () => {
    expect(() => validateRecoveryProvenance([], npmExpected)).toThrow("Stable publish recovery:");
    expect(() => validateRecoveryProvenance([...verified(), ...verified()], npmExpected)).toThrow(
      "Stable publish recovery:",
    );
  });
});

describe("bounded historical publication runner headers", () => {
  const historicalSha = "01403169248346f2a6d6dd02955fc956fa9e1fe9";
  const scenarios = [
    { name: "Publish", number: 20, file: "npm-publish-body.txt", job: "publish_openclaw_npm" },
    {
      name: "Verify full release validation evidence",
      number: 9,
      file: "npm-validation-body.txt",
      job: "publish_openclaw_npm",
    },
    {
      name: "Copy exact OCI digests, verify attestations, and promote aliases",
      number: 17,
      file: "docker-publish-body.txt",
      job: "Publish Docker images / Publish prepared Docker images",
    },
  ];
  function historical(scenario: (typeof scenarios)[number], bodyChange = (body: string) => body) {
    const body = bodyChange(
      readFileSync(
        new URL(`../fixtures/stable-publish-recovery/${scenario.file}`, import.meta.url),
        "utf8",
      ).trim(),
    );
    const code = body.split("\n");
    const input = [
      `##[group]Run ${code[0]}`,
      ...code.map((line) => `\u001b[36;1m${line}\u001b[0m`),
      "shell: /usr/bin/bash -e {0}",
      "env:",
      "  RELEASE_PUBLISH_RUN_ID: 100",
      "  RELEASE_PUBLISH_RUN_ATTEMPT: 3",
      "##[endgroup]",
    ];
    const bytes = Buffer.from(input.map((line) => `2026-09-08T12:55:34.500Z ${line}`).join("\n"));
    return {
      logs: new Map([[`0_${scenario.job.replaceAll("/", "_")}.txt`, bytes]]),
      historicalJob: {
        ...job,
        head_sha: historicalSha,
        name: scenario.job,
        steps: [
          {
            ...scenario,
            status: "completed",
            conclusion: "success",
            started_at: "2026-09-08T12:55:34Z",
            completed_at: "2026-09-08T12:56:15Z",
          },
        ],
      },
      bytes,
    };
  }
  it.each(scenarios)(
    "matches the frozen $name body, runner header and successful API step",
    (scenario) => {
      const fixture = historical(scenario);
      expect(readRecoveryStepInputs(fixture.logs, fixture.historicalJob, scenario.name)).toEqual({
        RELEASE_PUBLISH_RUN_ID: "100",
        RELEASE_PUBLISH_RUN_ATTEMPT: "3",
      });
    },
  );
  it.each([
    {
      name: "different body",
      mutate: (value: string) => value.replace("set -euo pipefail", "set -eu"),
    },
    { name: "duplicate matching header", mutate: (value: string) => `${value}\n${value}` },
    { name: "truncated header", mutate: (value: string) => value.replace("##[endgroup]", "") },
    {
      name: "different shell",
      mutate: (value: string) => value.replace("shell: /usr/bin/bash -e {0}", "shell: /bin/sh {0}"),
    },
    {
      name: "earlier step forgery",
      mutate: (value: string) => value.replaceAll("12:55:34.500Z", "12:55:33.500Z"),
    },
    {
      name: "later step forgery",
      mutate: (value: string) => value.replaceAll("12:55:34.500Z", "12:56:15.500Z"),
    },
    {
      name: "stdout only",
      mutate: (value: string) =>
        value
          .split("\n")
          .filter((line) => !line.includes("##[group]Run"))
          .join("\n"),
    },
  ])("rejects $name", ({ mutate }) => {
    const scenario = scenarios[0]!;
    const fixture = historical(scenario);
    fixture.logs.set("0_publish_openclaw_npm.txt", Buffer.from(mutate(fixture.bytes.toString())));
    expect(() =>
      readRecoveryStepInputs(fixture.logs, fixture.historicalJob, scenario.name),
    ).toThrow("Stable publish recovery:");
  });
  it("rejects another tooling revision, step number, failed step, or duplicate archive job", () => {
    const scenario = scenarios[0]!;
    const fixture = historical(scenario);
    for (const changedJob of [
      { ...fixture.historicalJob, head_sha: "b".repeat(40) },
      { ...fixture.historicalJob, steps: [{ ...fixture.historicalJob.steps[0], number: 21 }] },
      {
        ...fixture.historicalJob,
        steps: [{ ...fixture.historicalJob.steps[0], conclusion: "failure" }],
      },
    ]) {
      expect(() => readRecoveryStepInputs(fixture.logs, changedJob, scenario.name)).toThrow(
        "Stable publish recovery:",
      );
    }
    fixture.logs.set("1_publish_openclaw_npm.txt", fixture.bytes);
    expect(() =>
      readRecoveryStepInputs(fixture.logs, fixture.historicalJob, scenario.name),
    ).toThrow("Stable publish recovery:");
  });
});
