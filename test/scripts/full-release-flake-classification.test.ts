import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  isClassifiableFlakeJob,
  loadFlakeClassifications,
  parseFlakeGateEntries,
  recordFlakeClassification,
  validateFlakeClassification,
  type FlakeApi,
} from "../../scripts/full-release-flake-classification.mjs";

const sha = "a".repeat(40);
const targetSha = "b".repeat(40);
const jobUrl = "https://github.com/openclaw/openclaw/actions/runs/200/job/300";
const trackingUrl = "https://github.com/openclaw/openclaw/issues/400";
const workflow = ".github/workflows/full-release-flake-classification.yml";
const reason = "Independent reproduction confirms a fixture scheduling race.";

function fixture() {
  const env = {
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `openclaw/openclaw/${workflow}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_SHA: sha,
    GITHUB_TRIGGERING_ACTOR: "maintainer",
    GITHUB_RUN_ID: "500",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const run = {
    repository: { full_name: "openclaw/openclaw" },
    event: "workflow_dispatch",
    head_sha: sha,
  };
  const job = {
    id: 300,
    run_id: 200,
    run_attempt: 2,
    name: "checks-fast-core",
    html_url: jobUrl,
    status: "completed",
    conclusion: "failure",
  };
  const child = {
    ...run,
    id: 200,
    path: ".github/workflows/ci.yml",
    display_title: "CI full-release-validation-100-1-ci",
  };
  const parent = {
    ...run,
    id: 100,
    path: ".github/workflows/full-release-validation.yml",
    run_attempt: 1,
  };
  const dispatch = {
    id: 600,
    name: "Run normal full CI",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
  };
  const producer = {
    ...run,
    id: 500,
    path: workflow,
    head_branch: "main",
    run_attempt: 1,
    triggering_actor: { login: "maintainer" },
    display_title: `FRV flake classification ${jobUrl}`,
  };
  const responses: Record<string, unknown> = {
    "actions/jobs/300": job,
    "actions/runs/200": child,
    "actions/runs/100/attempts/1": parent,
    "actions/runs/100/attempts/1/jobs?per_page=100&page=1": { total_count: 1, jobs: [dispatch] },
    "actions/jobs/600/logs": `2026-09-29T10:00:00.000Z   TARGET_SHA: ${targetSha}\n2026-09-29T10:00:00.000Z Dispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/200 (attempt 1)`,
    "issues/400": { number: 400 },
    "actions/runs/500": producer,
  };
  const api: FlakeApi = vi.fn(async (path) => {
    if (!(path in responses)) {
      throw new Error(`Unexpected API route: ${path}`);
    }
    return responses[path];
  });
  return {
    env,
    job,
    child,
    parent,
    dispatch,
    producer,
    responses,
    api,
    inputs: { job_url: jobUrl, tracking_url: trackingUrl, reason },
  };
}

describe("authenticated FRV flake classification", () => {
  it("records the failed attempt and the parent's Release SHA instead of the CI tooling SHA", async () => {
    const request = fixture();
    request.inputs.reason = ` ${reason} `;
    const receipt = await recordFlakeClassification(request);
    expect(receipt).toEqual({
      schema: "openclaw.frv-flake-classification.v1",
      parentRunId: "100",
      parentRunAttempt: 1,
      child: "normalCi",
      childRunId: "200",
      childRunAttempt: 2,
      targetSha,
      jobId: "300",
      jobName: "checks-fast-core",
      jobUrl,
      conclusion: "failure",
      trackingUrl,
      reason,
      classifiedBy: "maintainer",
      receiptRunId: "500",
      receiptRunAttempt: 1,
    });
    expect(
      validateFlakeClassification(receipt, {
        child: { key: "normalCi", runId: "200", jobs: [request.job] },
        parentRunId: "100",
        parentRunAttempt: 1,
        targetSha,
      }),
    ).toEqual(receipt);
  });

  it.each([
    [
      "nonfailed job",
      (f: ReturnType<typeof fixture>) => {
        f.job.conclusion = "success";
      },
      "completed failure",
    ],
    [
      "wrong child job",
      (f: ReturnType<typeof fixture>) => {
        f.job.run_id = 201;
      },
      "completed failure",
    ],
    [
      "wrong workflow",
      (f: ReturnType<typeof fixture>) => {
        f.child.path = ".github/workflows/ci-lite.yml";
      },
      "workflow identity",
    ],
    [
      "wrong title",
      (f: ReturnType<typeof fixture>) => {
        f.child.display_title = "CI";
      },
      "dispatch title",
    ],
    [
      "wrong parent workflow",
      (f: ReturnType<typeof fixture>) => {
        f.parent.path = ".github/workflows/ci.yml";
      },
      "workflow identity",
    ],
    [
      "wrong parent attempt",
      (f: ReturnType<typeof fixture>) => {
        f.parent.run_attempt = 2;
      },
      "parent run identity",
    ],
    [
      "failed dispatch",
      (f: ReturnType<typeof fixture>) => {
        f.dispatch.conclusion = "failure";
      },
      "uniquely successful",
    ],
    [
      "wrong receipt actor",
      (f: ReturnType<typeof fixture>) => {
        f.producer.triggering_actor.login = "someone-else";
      },
      "producer identity",
    ],
    [
      "untrusted branch",
      (f: ReturnType<typeof fixture>) => {
        f.env.GITHUB_REF = "refs/heads/other";
      },
      "trusted main",
    ],
    [
      "wrong target witness",
      (f: ReturnType<typeof fixture>) => {
        f.responses["actions/jobs/600/logs"] =
          `  TARGET_SHA: ${targetSha}\nDispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/201 (attempt 1)`;
      },
      "dispatch witness",
    ],
    [
      "duplicate target witness",
      (f: ReturnType<typeof fixture>) => {
        f.responses["actions/jobs/600/logs"] =
          `${String(f.responses["actions/jobs/600/logs"])}\n  TARGET_SHA: ${sha}`;
      },
      "target SHA",
    ],
    [
      "foreign tracking URL",
      (f: ReturnType<typeof fixture>) => {
        f.inputs.tracking_url = "https://github.com/other/repo/issues/400";
      },
      "tracking URL",
    ],
    [
      "short reason",
      (f: ReturnType<typeof fixture>) => {
        f.inputs.reason = "flaky";
      },
      "20–300",
    ],
    [
      "long reason",
      (f: ReturnType<typeof fixture>) => {
        f.inputs.reason = "x".repeat(301);
      },
      "20–300",
    ],
    [
      "multiline reason",
      (f: ReturnType<typeof fixture>) => {
        f.inputs.reason = `${reason}\n`;
      },
      "single line",
    ],
  ])("rejects %s", async (_name, change, error) => {
    const request = fixture();
    change(request);
    await expect(recordFlakeClassification(request)).rejects.toThrow(error);
  });

  it.each([
    "openclaw/ci-gate",
    "Seal release",
    "ios-screenshot-evidence",
    "build-artifacts",
    "Build Artifacts",
    "npm-install-smoke",
    "install_smoke",
    "Upgrade survivor",
    "docker-seed-e2e",
    "update-first-hop-compat",
    "First-hop smoke",
    "pack-budget",
    "npm-pack",
    "Qualify release npm",
    "Package Acceptance",
    "package-integrity",
    "package_integrity",
  ])("never records protected job %s", async (name) => {
    const request = fixture();
    request.job.name = name;
    expect(isClassifiableFlakeJob(name)).toBe(false);
    await expect(recordFlakeClassification(request)).rejects.toThrow("cannot be classified");
  });

  it("requires the accepted job identity and exact parent/candidate bindings", async () => {
    const request = fixture();
    const receipt = await recordFlakeClassification(request);
    const child = { key: "normalCi", runId: "200", jobs: [request.job] };
    for (const expected of [
      { child: { ...child, key: "releaseChecks" } },
      {
        child: {
          ...child,
          jobs: [{ ...request.job, id: 301, html_url: jobUrl.replace("300", "301") }],
        },
      },
      { child, parentRunId: "101" },
      { child, parentRunAttempt: 2 },
      { child, targetSha: sha },
    ]) {
      expect(() => validateFlakeClassification(receipt, expected)).toThrow();
    }
  });

  it("rejects non-string receipt bindings instead of coercing JSON arrays", async () => {
    const receipt = await recordFlakeClassification(fixture());
    for (const field of ["targetSha", "jobUrl", "trackingUrl"] as const) {
      expect(() =>
        validateFlakeClassification({ ...receipt, [field]: [receipt[field]] }),
      ).toThrow();
    }
  });

  it("fails closed on receipt API errors and never looks up unrelated children", async () => {
    const api = vi.fn<FlakeApi>().mockRejectedValue(new Error("HTTP 503"));
    const child = { key: "normalCi", runId: "200", jobs: [fixture().job] };
    await expect(
      loadFlakeClassifications({ child, api, parentRunId: "100", parentRunAttempt: 1, targetSha }),
    ).rejects.toThrow("HTTP 503");
    api.mockClear();
    await expect(
      loadFlakeClassifications({
        child: { ...child, key: "releaseChecks" },
        api,
        parentRunId: "100",
        parentRunAttempt: 1,
        targetSha,
      }),
    ).resolves.toEqual({});
    expect(api).not.toHaveBeenCalled();
  });
});

describe("CI gate receipt log", () => {
  it("parses only emitted entries and retains skipped, cancelled, and missing outcomes for policy rejection", () => {
    const entries = parseFlakeGateEntries(
      [
        '2026-09-29T10:00:00.000Z echo "${name}: ${result} (selected=${selected:-missing})"',
        "2026-09-29T10:00:00.000Z preflight: success (selected=true)",
        "2026-09-29T10:00:00.000Z checks-fast-core: failure (selected=true)",
        "2026-09-29T10:00:00.000Z checks-ui: skipped (selected=true)",
        "2026-09-29T10:00:00.000Z checks-ui-e2e: cancelled (selected=true)",
        "2026-09-29T10:00:00.000Z checks-fast-plugin-contracts-shard: failure (selected=missing)",
        "2026-09-29T10:00:00.000Z pr-fail-fast: skipped (selected=false)",
      ].join("\n"),
    );
    expect(entries).toEqual([
      { name: "preflight", result: "success", selected: true },
      { name: "checks-fast-core", result: "failure", selected: true },
      { name: "checks-ui", result: "skipped", selected: true },
      { name: "checks-ui-e2e", result: "cancelled", selected: true },
      { name: "checks-fast-plugin-contracts-shard", result: "failure", selected: "missing" },
      { name: "pr-fail-fast", result: "skipped", selected: false },
    ]);
  });
  it.each(["", "preflight: success (selected=true)", "checks-fast-core: failure (selected=true)"])(
    "rejects incomplete log %j",
    (log) => {
      expect(() => parseFlakeGateEntries(log)).toThrow("incomplete");
    },
  );
  it.each([
    "checks-ui: unknown.result (selected=true)",
    "checks-ui: failure (selected=true",
    "checks-ui: failure (selected =true)",
    "checks-ui: failure (selected=true) unexpected",
  ])("rejects malformed gate-shaped row %j instead of omitting it", (row) => {
    const log = [
      "preflight: success (selected=true)",
      row,
      "pr-fail-fast: skipped (selected=false)",
    ].join("\n");
    expect(() => parseFlakeGateEntries(log)).toThrow("CI gate log entr");
  });
});

describe("classification workflow contract", () => {
  it("uses trusted main and script-owned input parsing without write permissions", () => {
    const parsed = parseYaml(readFileSync(new URL(`../../${workflow}`, import.meta.url), "utf8"));
    expect(parsed.on).toEqual({ workflow_dispatch: { inputs: expect.any(Object) } });
    expect(parsed.permissions).toEqual({
      contents: "read",
      actions: "read",
      issues: "read",
      "pull-requests": "read",
    });
    expect(parsed.jobs.record.if).toBe("github.ref == 'refs/heads/main'");
    const steps = parsed.jobs.record.steps;
    expect(steps[0].with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    });
    expect(steps.find((step: { run?: string }) => step.run)?.run).toBe(
      "node scripts/full-release-flake-classification.mjs record",
    );
    expect(steps.at(-1).with).toMatchObject({ "retention-days": 90, "if-no-files-found": "error" });
  });
  it("pins the CI gate's output grammar and completeness bookends", () => {
    const ci = parseYaml(
      readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    );
    const gate = ci.jobs["ci-gate"].steps.find(
      (step: { name: string }) => step.name === "Verify selected CI lanes",
    );
    expect(gate.run).toContain('echo "${name}: ${result} (selected=${selected:-missing})"');
    const rows = gate.env.JOB_RESULTS.trim().split("\n");
    expect(rows[0]).toMatch(/^preflight=/u);
    expect(rows.at(-1)).toMatch(/^pr-fail-fast=/u);
  });
});
