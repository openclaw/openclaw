import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  buildReleaseStateArtifact,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import { validateParentManifest } from "../../scripts/release-ci-summary.mjs";
import {
  SHA,
  TARGET_SHA,
  SOURCE_REF,
  REPOSITORY,
  job,
  requiredChildren,
  executionPlanArtifact,
  historicalExecutionPlanArtifact,
  runFor,
  rootRun,
} from "./frv.test-support.js";
import { sourceFact } from "./full-release-validation-state.test-support.js";

describe("FRV protected gh evidence reads", () => {
  const jobLogArgs = [
    "api",
    `repos/${REPOSITORY}/actions/jobs/1/logs`,
    "-H",
    "Cache-Control: max-age=0",
  ];

  it.each([
    ["getRun", ["101"], "actions/runs/101", { run_attempt: 2 }],
    ["getRunAttempt", ["101", 2], "actions/runs/101/attempts/2", { run_attempt: 2 }],
    [
      "getAttemptJobs",
      ["101", 2],
      "actions/runs/101/attempts/2/jobs?per_page=100",
      [{ id: 1 }, { id: 2 }],
    ],
    [
      "getParentJobs",
      ["77"],
      "actions/runs/77/jobs?filter=all&per_page=100",
      [{ id: 1 }, { id: 2 }],
    ],
    ["getJobLog", [1], "actions/jobs/1/logs", "job evidence"],
    ["getParentJobs", ["77"], "actions/runs/77/jobs?filter=all&per_page=100", [], "empty"],
  ] as const)(
    "revalidates %s through the default protected route",
    (method, args, endpoint, expected, failure?: "empty") => {
      const result = runProtectedFrv(method, [...args], endpoint, failure);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expected);
      expect(result.calls).toHaveLength(1);
    },
  );

  it.each(["403", "429"] as const)(
    "retains a later-page %s throttle deadline without fast transport retries",
    (status) => {
      const result = runProtectedFrv(
        "getParentJobs",
        ["77"],
        "actions/runs/77/jobs?filter=all&per_page=100",
        status,
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toEqual({ retryAt: 130_000, classification: "transient" });
      expect(result.calls).toHaveLength(1);
    },
  );

  it.each(["getRun", "getAttemptJobs"])(
    "bounds the protected %s transport retries by the read deadline",
    (method) => {
      const args =
        method === "getRun"
          ? ["101", { operationDeadline: 15_000 }]
          : ["101", 2, { operationDeadline: 15_000 }];
      const endpoint =
        method === "getRun" ? "actions/runs/101" : "actions/runs/101/attempts/2/jobs?per_page=100";
      const result = runProtectedFrv(method, args, endpoint, "transient-deadline");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("FRV operation timed out");
      expect(result.calls).toHaveLength(1);
    },
  );

  it.each([
    ["legacy-flag", 0, ""],
    ["unrelated", 23, "unrelated log failure"],
    ["protected", 19, "protected refusal"],
  ] as const)(
    "preserves %s outcomes without an unauthorized fallback",
    (failure, status, error) => {
      const protectedRead = failure === "protected";
      const result = runProtectedFrv(
        protectedRead ? "getRun" : "getJobLog",
        protectedRead ? ["101"] : [1],
        protectedRead ? "actions/runs/101" : "actions/jobs/1/logs",
        failure,
      );
      expect(result.status, result.stderr).toBe(status);
      if (failure === "legacy-flag") {
        expect(JSON.parse(result.stdout)).toBe("job evidence");
        expect(result.calls).toEqual([[...jobLogArgs, "--allow-escape-sequences"], jobLogArgs]);
      } else {
        expect(result.stderr).toContain(error);
        expect(result.calls).toHaveLength(1);
        if (!protectedRead) {
          expect(result.calls).toEqual([[...jobLogArgs, "--allow-escape-sequences"]]);
        }
      }
    },
  );
});

function runProtectedFrv(
  method: string,
  args: Array<string | number | Record<string, unknown>>,
  endpoint: string,
  failure:
    | "none"
    | "legacy-flag"
    | "protected"
    | "unrelated"
    | "transient-deadline"
    | "empty"
    | "403"
    | "429" = "none",
) {
  const root = mkdtempSync(join(tmpdir(), "frv-protected-"));
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
const fail = (message, code) => { console.error(message); process.exit(code); };
const failure = ${JSON.stringify(failure)};
if (failure === "protected") fail("protected refusal", 19);
if (failure === "transient-deadline") fail("HTTP 502: transient fixture failure", 1);
if (args[0] !== "api" || !args.includes(${JSON.stringify(`repos/${REPOSITORY}/${endpoint}`)})) fail("unexpected request", 17);
if (!args.some((arg, i) => ["-H", "--header"].includes(arg) && args[i+1] === "Cache-Control: max-age=0")) fail("missing live header", 18);
if (${endpoint.endsWith("/logs")} && failure === "legacy-flag" && args.includes("--allow-escape-sequences")) fail("unknown flag: --allow-escape-sequences", 1);
if (${endpoint.endsWith("/logs")} && failure === "unrelated") fail("unrelated log failure", 23);
if (${endpoint.endsWith("/logs")} && failure === "none" && !args.includes("--allow-escape-sequences")) fail("missing escape-sequence flag", 20);
if (!${endpoint.endsWith("/logs")}) {
  if (!args.includes("--include")) fail("missing included headers", 17);
  process.stdout.write("HTTP/2.0 200 OK\\nContent-Type: application/json\\r\\n\\r\\n");
}
if (failure === "403" || failure === "429") {
  process.stdout.write('{"id":1}\\n\\nHTTP/2.0 ' + failure + ' Rate limited\\nRetry-After: 120\\r\\n\\r\\n{"message":"API rate limit exceeded"}');
  fail("gh: API rate limit exceeded (HTTP " + failure + ")", 1);
}
if (${endpoint.includes("/jobs?")}) {
  if (!args.includes("--paginate") || !args.includes(".jobs[] | @json")) fail("missing pagination", 17);
  if (failure !== "empty") console.log('{"id":1}\\n{"id":2}');
} else console.log(${endpoint.endsWith("/logs") ? JSON.stringify("job evidence") : JSON.stringify('{"run_attempt":2}')});
`,
  );
  chmodSync(gh, 0o755);
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), "scripts/frv.mjs")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {createClient} from ${JSON.stringify(moduleUrl)};
      import {existsSync} from "node:fs";
      import {releaseGhRateLimitRetryAt, classifyReleaseGhTransportError} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/full-release-validation-policy.mjs")).href)};
      const throttled = ["403", "429"].includes(${JSON.stringify(failure)});
      if (throttled) Date.now = () => 10_000;
      if (${JSON.stringify(failure)} === "transient-deadline") {
        Date.now = () => existsSync("calls.jsonl") ? 20_000 : 10_000;
        const nativeSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (...args) => {
          if (Date.now() >= 15_000) throw new Error("transport scheduled work after its deadline");
          return nativeSetTimeout(...args);
        };
      }
      try {
        console.log(JSON.stringify(await createClient(${JSON.stringify(REPOSITORY)})[${JSON.stringify(method)}](...${JSON.stringify(args)})));
      } catch (error) {
        console.error(throttled ? JSON.stringify({ retryAt: releaseGhRateLimitRetryAt(error), classification: classifyReleaseGhTransportError(error) }) : error.message);
        process.exitCode = typeof error.code === "number" ? error.code : 1;
      }
    `,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { HOME: root, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
      },
    );
    return {
      ...result,
      calls: readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PUBLISH_SHA = "c".repeat(40);
const PUBLISH_REF = `release-publish/${PUBLISH_SHA.slice(0, 12)}-88`;
const DIAGNOSTIC_FILE = "release-postpublish-diagnostics.json";
const PUBLISH_PATH = ".github/workflows/openclaw-release-publish.yml";
const FRV_PATH = ".github/workflows/full-release-validation.yml";

function publicationFixture() {
  const executionPlan = executionPlanArtifact();
  const publisher = {
    ...rootRun(),
    id: 88,
    workflow_id: 800,
    path: `${PUBLISH_PATH}@refs/tags/${PUBLISH_REF}`,
    head_branch: PUBLISH_REF,
    head_sha: PUBLISH_SHA,
    repository: { full_name: REPOSITORY },
  };
  const root = {
    ...rootRun(2, "success"),
    id: 77,
    workflow_id: 700,
    path: `${FRV_PATH}@${SOURCE_REF}`,
    head_branch: SOURCE_REF,
    head_sha: SHA,
    repository: { full_name: REPOSITORY },
  };
  const manifest = {
    version: 3,
    workflowName: "Full Release Validation",
    runId: "77",
    runAttempt: "2",
    workflowRef: SOURCE_REF,
    workflowFullRef: `refs/heads/${SOURCE_REF}`,
    workflowRefType: "branch",
    workflowSha: SHA,
    targetSha: TARGET_SHA,
    releaseProfile: "beta",
    rerunGroup: "all",
    runReleaseSoak: "false",
    controls: { performanceReportPublication: "artifact-only" },
    validationInputs: {},
    candidateBinding: null,
    executionPlanSha256: executionPlan.sha256,
    sourceParentRunAttempt: 1,
    childRuns: {
      normalCi: "101",
      npmTelegram: "",
      pluginPrerelease: "202",
      releaseChecks: "303",
      productPerformance: { runId: "404" },
    },
  };
  const stage = (state = "unattempted", publication = "unknown") => ({
    state,
    publication,
    error: null,
    packages: [],
    packagesTruncated: false,
  });
  const diagnostic = {
    schemaVersion: 1,
    kind: "release-postpublish-diagnostics",
    invocationId: "12345678-1234-4234-8234-123456789abc",
    context: {
      repository: REPOSITORY,
      releaseVersion: "2026.9.9",
      releaseTag: "v2026.9.9",
      npmDistTag: "latest",
      requestedSourceSha: TARGET_SHA,
      toolingSha: PUBLISH_SHA,
      suppliedToolingSha: PUBLISH_SHA,
      suppliedToolingRef: `refs/tags/${PUBLISH_REF}`,
      parentRunId: "88",
      parentRunAttempt: "1",
      validationEvidence: { mode: "full-release-validation", runId: "77", runAttempt: "2" },
    },
    selection: {
      plugins: [],
      pluginsTruncated: false,
      workflowRef: PUBLISH_REF,
      clawHubWorkflowRef: PUBLISH_REF,
    },
    verification: "failure",
    currentStage: "pluginNpm",
    stages: {
      checkout: stage("success"),
      githubRelease: stage("skipped"),
      coreNpm: stage("success", "observed"),
      postpublish: stage("success"),
      pluginNpm: stage("failure"),
      clawHub: stage(),
      fullReleaseValidation: stage(),
      pluginNpmRun: stage(),
      pluginClawHubRun: stage(),
      pluginClawHubBootstrap: stage("skipped"),
      openclawNpm: stage(),
      npmTelegram: stage("skipped"),
      evidence: stage(),
      binding: stage(),
      assets: stage(),
    },
    children: Object.fromEntries(
      [
        "fullReleaseValidation",
        "openclawNpm",
        "pluginNpm",
        "pluginClawHub",
        "pluginClawHubBootstrap",
        "npmTelegram",
      ].map((name) => [
        name,
        {
          suppliedRunId: null,
          runAttempt: null,
          producerRunAttempt: null,
          status: "unknown",
          conclusion: "unknown",
          failedJobCount: null,
          readbackArtifactId: null,
          packageArtifactId: null,
        },
      ]),
    ),
    jobOutcomeBeforeArtifactUploads: "failure",
    stepOutcomes: { coreStart: "success", completion: "failure" },
  };
  const publisherJobs = [
    {
      ...job("Publish plugins, then OpenClaw", "failure"),
      id: 8801,
      run_id: 88,
      run_attempt: 1,
      steps: [
        {
          number: 1,
          name: "Upload postpublish diagnostics",
          status: "completed",
          conclusion: "success",
        },
      ],
    },
  ];
  return { executionPlan, manifest, diagnostic, publisher, root, publisherJobs };
}

async function runPublicationCli(
  fixture = publicationFixture(),
  args = ["status", "--run", "77", "--publication-run", "88", "--json"],
  amend: (
    responses: Record<string, unknown>,
    addArtifact: (
      id: number,
      run: typeof fixture.root,
      name: string,
      filename: string,
      value: unknown,
      zipChange?: (zip: JSZip) => void,
    ) => Promise<void>,
  ) => void | Promise<void> = () => {},
  explicitBinary = false,
  clockStep = 0,
  seal: "accepted" | "needs-refresh" | "unavailable" = "accepted",
  decisionState: "passed" | "blocked_diagnostics_running" = "passed",
) {
  const directory = mkdtempSync(join(tmpdir(), "frv-publication-"));
  const legacy = !args.includes("--publication-run");
  if (legacy) {
    const source = sourceFact();
    Object.assign(fixture.executionPlan, {
      sourceAdmissionContract: "1",
      sourceAdmission: sourceFact({
        workflow: { ...source.workflow, ref: `refs/heads/${SOURCE_REF}` },
        coverage: { ...source.coverage, release_profile: "beta" },
      }),
    });
    fixture.executionPlan.sha256 = releaseExecutionPlanSha256(fixture.executionPlan);
  }
  const responses: Record<string, unknown> = {};
  const endpoint = (path: string) => `repos/${REPOSITORY}/${path}`;
  const artifactLists = new Map<number, unknown[]>();
  async function artifact(
    id: number,
    run: typeof fixture.root,
    name: string,
    filename: string,
    value: unknown,
    zipChange?: (zip: JSZip) => void,
  ) {
    const zip = new JSZip();
    zip.file(filename, JSON.stringify(value), { unixPermissions: 0o100644 });
    zipChange?.(zip);
    const bytes = await zip.generateAsync({
      type: "nodebuffer",
      platform: "UNIX",
      compression: "DEFLATE",
    });
    const metadata = {
      id,
      name,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size_in_bytes: bytes.length,
      expired: false,
      expires_at: "2099-01-01T00:00:00Z",
      workflow_run: { id: run.id, head_sha: run.head_sha },
    };
    responses[endpoint(`actions/artifacts/${id}`)] = metadata;
    responses[endpoint(`actions/artifacts/${id}/zip`)] = { binary: bytes.toString("base64") };
    const artifacts = [
      ...(artifactLists.get(run.id) ?? []).filter((item) => (item as { id: number }).id !== id),
      metadata,
    ];
    artifactLists.set(run.id, artifacts);
    responses[endpoint(`actions/runs/${run.id}/artifacts?per_page=100&page=1`)] = {
      total_count: artifacts.length,
      artifacts,
    };
  }
  await artifact(
    1,
    fixture.root,
    "full-release-execution-plan-77",
    "full-release-execution-plan.json",
    fixture.executionPlan,
  );
  await artifact(
    2,
    fixture.root,
    "full-release-validation-77-2",
    "full-release-validation-manifest.json",
    fixture.manifest,
  );
  await artifact(
    3,
    fixture.publisher,
    "openclaw-release-postpublish-diagnostics-88-1",
    DIAGNOSTIC_FILE,
    fixture.diagnostic,
  );
  for (const run of [fixture.root, fixture.publisher]) {
    responses[endpoint(`actions/runs/${run.id}`)] = run;
    responses[endpoint(`actions/runs/${run.id}/attempts/${run.run_attempt}`)] = run;
    responses[endpoint(`actions/workflows/${run.workflow_id}`)] = {
      id: run.workflow_id,
      path: run.id === 77 ? FRV_PATH : PUBLISH_PATH,
    };
    const artifacts = artifactLists.get(run.id) ?? [];
    responses[endpoint(`actions/runs/${run.id}/artifacts?per_page=100&page=1`)] = {
      total_count: artifacts.length,
      artifacts,
    };
  }
  responses[endpoint("actions/runs/88/attempts/1/jobs?per_page=100&page=1")] = {
    total_count: fixture.publisherJobs.length,
    jobs: fixture.publisherJobs,
  };
  for (const entry of requiredChildren()) {
    const run = { ...runFor(entry, 1, "success"), workflow_id: Number(entry.runId) + 1000 };
    responses[endpoint(`actions/runs/${entry.runId}`)] = run;
    responses[endpoint(`actions/workflows/${run.workflow_id}`)] = {
      id: run.workflow_id,
      path: run.path,
    };
    responses[endpoint(`actions/runs/${entry.runId}/attempts/1/jobs?per_page=100&page=1`)] = {
      total_count: 1,
      jobs: [{ ...job("test"), id: Number(entry.runId) * 10, run_id: run.id, run_attempt: 1 }],
    };
  }
  responses[endpoint("actions/runs/77/jobs?filter=all&per_page=100")] = {
    jobs: [{ ...job("Diagnostic Drain"), run_attempt: fixture.root.run_attempt }],
  };
  responses[endpoint("git/ref/heads/release/2026.9.9")] = { object: { sha: TARGET_SHA } };
  await amend(responses, artifact);
  writeFileSync(join(directory, "responses.json"), JSON.stringify(responses));
  writeFileSync(join(directory, "legacy-plan.json"), JSON.stringify(fixture.executionPlan));
  const decision = buildReleaseStateArtifact({
    children: fixture.executionPlan.children.map((child) => ({
      ...child,
      jobs: [],
      errors: [],
      status: "completed",
      conclusion: "success",
    })),
    executionPlan: fixture.executionPlan,
    expected: {
      parentRunAttempt: fixture.root.run_attempt,
      parentRunId: "77",
      workflowRef: SOURCE_REF,
      workflowSha: SHA,
      targetSha: TARGET_SHA,
    },
    releaseProfile: "beta",
    rerunGroup: "all",
    mode: "decision",
    decision: {
      state: decisionState,
      blockers:
        decisionState === "passed"
          ? []
          : [
              {
                child: "normalCi",
                kind: "job_failed",
                job: "actual test blocker",
                message: "workload boundary failed",
              },
            ],
      errors: [],
    },
  });
  writeFileSync(join(directory, "legacy-decision.json"), JSON.stringify(decision));
  writeFileSync(
    join(directory, "no-network.mjs"),
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
const fsAppend = (value) => appendFileSync("verifier-calls.jsonl", value + "\\n");
globalThis.fetch = () => { throw new Error('unplanned Node fetch'); };
for (const name of ["execFileSync", "execFile", "spawn", "spawnSync"]) {
  const original = childProcess[name];
  const guarded = (method) => (command, ...args) => {
    if (command !== "gh" && command !== ${JSON.stringify(join(directory, "gh"))}) throw new Error("unplanned executable");
    return method(command, ...args);
  };
  childProcess[name] = guarded(original);
  const custom = Symbol.for("nodejs.util.promisify.custom");
  if (original[custom]) childProcess[name][custom] = (...args) => {
    if (name === "execFile" && args[0] === ${JSON.stringify(process.execPath)} && args[1]?.[0] === "scripts/release-ci-summary.mjs") {
      fsAppend(JSON.stringify(args[1]));
      if (${JSON.stringify(seal)} === "accepted") return Promise.resolve({ stdout: '{"valid":true}', stderr: "" });
      return Promise.reject(Object.assign(new Error("verification fixture"), { stdout: JSON.stringify({ valid: false, refreshable: ${seal === "needs-refresh"} }) }));
    }
    return guarded(original[custom])(...args);
  };
}
syncBuiltinESMExports();
${clockStep ? `let ticks = 0; const now = Date.now(); Date.now = () => now + ticks++ * ${clockStep};` : ""}
`,
  );
  const gh = join(directory, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
const reject = () => { console.error("unplanned or mutating request"); process.exit(23); };
const legacy = ${legacy};
if (legacy && args[0] === "run" && args[1] === "download" && args[2] === "77") {
  const name = args[args.indexOf("--name") + 1];
  if (name !== "full-release-execution-plan-77" && !name.startsWith("full-release-decision-77-")) reject();
  const decision = name.startsWith("full-release-decision-");
  fs.copyFileSync(decision ? "legacy-decision.json" : "legacy-plan.json", require("node:path").join(args[args.indexOf("--dir") + 1], decision ? "full-release-decision.json" : "full-release-execution-plan.json"));
  process.exit(0);
}
if (args[0] !== "api" || (!legacy && (!args.includes("GET") || !args.includes("github.com"))) || !args.includes("Cache-Control: max-age=0")) reject();
if (!legacy && (args.includes("--include") || args.includes("--paginate"))) reject();
let path = args.find(a => a.startsWith("repos/"));
if (legacy && path.endsWith("/jobs?per_page=100")) path += "&page=1";
const table = JSON.parse(fs.readFileSync("responses.json", "utf8"));
if (!Object.hasOwn(table, path)) reject();
let value = table[path];
if (value.sequence) {
  const reads = fs.readFileSync("calls.jsonl", "utf8").trim().split("\\n").map(JSON.parse).filter(a => a.includes(path)).length;
  value = value.sequence[Math.min(reads - 1, value.sequence.length - 1)];
}
if (value.failure) { console.error(value.failure); process.exit(1); }
if (legacy && args.includes("--include")) process.stdout.write("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n");
if (legacy && value.jobs) process.stdout.write(value.jobs.map(job => JSON.stringify(job)).join("\\n"));
else if (value.binary) process.stdout.write(Buffer.from(value.binary, "base64"));
else if (value.raw) process.stdout.write(value.raw);
else process.stdout.write(JSON.stringify(value));
`,
  );
  chmodSync(gh, 0o755);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        join(directory, "no-network.mjs"),
        join(process.cwd(), "scripts/frv.mjs"),
        ...args,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          HOME: directory,
          PATH: directory,
          ...(explicitBinary ? { OPENCLAW_GH_BIN: gh, GH_TOKEN: "synthetic-fixture-token" } : {}),
        },
      },
    );
    let calls: string[][] = [];
    try {
      calls = readFileSync(join(directory, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      // Usage rejection must happen before the first CLI read.
    }
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("publication status real CLI", () => {
  it.each([
    "failed publisher",
    "truncated packages",
    "successful verification",
    "unattempted verification",
  ])("projects %s without confusing readback and publication", async (kind) => {
    const fixture = publicationFixture();
    if (kind === "truncated packages") {
      Object.assign(fixture.diagnostic.stages.pluginNpm, {
        packages: [
          { name: "@openclaw/first", state: "success", publication: "observed", error: null },
          {
            name: "@openclaw/second",
            state: "failure",
            publication: "unknown",
            error: { class: "registry-not-visible", status: 1 },
          },
        ],
        packagesTruncated: true,
      });
    } else if (kind === "successful verification") {
      fixture.diagnostic.verification = "success";
      fixture.diagnostic.stages.binding.state = "failure";
      fixture.diagnostic.stages.assets.state = "failure";
      fixture.publisher.conclusion = "success";
      fixture.publisherJobs.push({
        ...job("Finalize GitHub release", "skipped"),
        id: 8802,
        run_id: 88,
        run_attempt: 1,
        steps: [],
      });
    } else if (kind === "unattempted verification") {
      fixture.diagnostic.verification = "unattempted";
      fixture.diagnostic.stages.coreNpm.state = "unattempted";
      fixture.diagnostic.stages.coreNpm.publication = "unknown";
    }
    validateParentManifest(fixture.manifest, {
      runId: "77",
      runAttempt: 2,
      workflowRef: SOURCE_REF,
      workflowSha: SHA,
    });
    const result = await runPublicationCli(fixture);
    const value = JSON.parse(result.stdout);
    const publication = value.publication;
    expect(result.status, result.stderr + result.stdout).toBe(
      kind === "truncated packages" ? 1 : 0,
    );
    expect(publication.relationship).toMatchObject({
      status: "verified",
      originalPlanAttempt: 1,
      validationAttempt: 2,
    });
    expect(publication.publisher).toMatchObject({
      runId: "88",
      runAttempt: 1,
      conclusion: kind === "successful verification" ? "success" : "failure",
    });
    expect(publication.surfaces.activation.operation.state).toBe("unknown");
    expect(value.children).toHaveLength(4);
    expect(result.calls.length).toBeGreaterThan(0);
    if (kind === "truncated packages") {
      expect(publication.collection.error).toBe("incomplete");
      expect(publication.surfaces.pluginNpm.packages).toHaveLength(2);
      expect(publication.surfaces.pluginNpm.packages[0].publication).toBe("observed");
      expect(publication.surfaces.pluginNpm.packages[1].error.class).toBe("registry-not-visible");
    } else if (kind === "successful verification") {
      expect(publication.verification.state).toBe("success");
      expect(publication.binding.state).toBe("failure");
      expect(publication.assets.state).toBe("failure");
      expect(publication.surfaces.activation.jobs[0].conclusion).toBe("skipped");
    } else if (kind === "unattempted verification") {
      expect(publication.surfaces.coreNpm).toMatchObject({
        selection: "unknown",
        verificationSelection: "unknown",
        operation: { state: "unknown" },
        verification: { state: "unattempted" },
      });
    } else {
      expect(publication.surfaces.coreNpm.verification.state).toBe("success");
      expect(publication.surfaces.pluginNpm.verification.state).toBe("failure");
    }
  });

  it.each([
    ["status", "--run", "77", "--publication-run"],
    ["status", "--run", "77", "--publication-run", "0"],
    ["status", "--run", "77", "--publication-run", "9007199254740992"],
    ["status", "--run", "77", "--publication-run", "88", "--publication-run", "89"],
    ["status", "--run", "77", "--run", "78", "--publication-run", "88"],
    ["status", "--run", "77", "--publication-run", "88", "--repo", "../private"],
    ["continue", "--failed", "--run", "77", "--publication-run", "88"],
    ["verify", "--run", "77", "--publication-run", "88"],
  ])("rejects invalid selectors before any read: %j", async (...args) => {
    const result = await runPublicationCli(publicationFixture(), args);
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("publication observation: usage");
  });

  it("uses the selected explicit binary without Node fetch and keeps the text section separate", async () => {
    const result = await runPublicationCli(
      publicationFixture(),
      ["status", "--run", "77", "--publication-run", "88"],
      undefined,
      true,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Publication observation (not release authorization)");
    expect(result.stdout).toContain("selected-attempt=2");
    expect(result.stdout).toContain(
      "pluginNpm: selection=unknown operation=unknown verification=failure",
    );
    expect(result.calls.every((call) => call[0] === "api" && call.includes("GET"))).toBe(true);
    expect(result.stdout + result.stderr).not.toContain("synthetic-fixture-token");
  });

  it.each([
    [
      "foreign repository",
      (fixture: ReturnType<typeof publicationFixture>) => {
        fixture.publisher.repository.full_name = "other/repository";
      },
    ],
    [
      "foreign event",
      (fixture) => {
        fixture.publisher.event = "push";
      },
    ],
    [
      "foreign path",
      (fixture) => {
        fixture.publisher.path = ".github/workflows/other.yml";
      },
    ],
    [
      "foreign path suffix",
      (fixture) => {
        fixture.publisher.path = `${PUBLISH_PATH}@main`;
      },
    ],
    [
      "wrong producer run",
      (fixture) => {
        fixture.diagnostic.context.parentRunId = "89";
      },
    ],
    [
      "wrong producer attempt",
      (fixture) => {
        fixture.diagnostic.context.parentRunAttempt = "2";
      },
    ],
    [
      "wrong tooling",
      (fixture) => {
        fixture.diagnostic.context.toolingSha = SHA;
      },
    ],
    [
      "wrong full ref",
      (fixture) => {
        fixture.diagnostic.context.suppliedToolingRef = "refs/heads/main";
      },
    ],
    [
      "wrong validation root",
      (fixture) => {
        fixture.diagnostic.context.validationEvidence.runId = "78";
      },
    ],
    [
      "future validation attempt",
      (fixture) => {
        fixture.diagnostic.context.validationEvidence.runAttempt = "3";
      },
    ],
    [
      "wrong candidate",
      (fixture) => {
        fixture.diagnostic.context.requestedSourceSha = PUBLISH_SHA;
      },
    ],
    [
      "wrong source attempt",
      (fixture) => {
        fixture.manifest.sourceParentRunAttempt = 2;
      },
    ],
    [
      "wrong plan checksum",
      (fixture) => {
        fixture.manifest.executionPlanSha256 = "0".repeat(64);
      },
    ],
    [
      "wrong manifest tooling",
      (fixture) => {
        fixture.manifest.workflowSha = PUBLISH_SHA;
      },
    ],
    [
      "unsuccessful upload",
      (fixture) => {
        fixture.publisherJobs[0]!.steps[0]!.conclusion = "failure";
      },
    ],
  ] satisfies [string, (fixture: ReturnType<typeof publicationFixture>) => void][])(
    "refuses %s",
    async (_name, mutate) => {
      const fixture = publicationFixture();
      mutate(fixture);
      const result = await runPublicationCli(fixture);
      expect(result.status, result.stdout).toBe(1);
      expect(JSON.parse(result.stdout).publication.collection.complete).toBe(false);
      expect(result.calls.every((call) => call[0] === "api" && call.includes("GET"))).toBe(true);
    },
  );

  it.each([
    "workflow-id",
    "artifact-digest",
    "artifact-size",
    "artifact-producer",
    "duplicate-name",
    "duplicate-id",
    "count-gap",
  ])("rejects independently observed %s", async (kind) => {
    const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
      const prefix = `repos/${REPOSITORY}/actions/`;
      const metadata = responses[`${prefix}artifacts/3`] as Record<string, unknown>;
      const list = responses[`${prefix}runs/88/artifacts?per_page=100&page=1`] as {
        total_count: number;
        artifacts: unknown[];
      };
      if (kind === "workflow-id") {
        Object.assign(responses[`${prefix}workflows/800`] as object, { id: 801 });
      }
      if (kind === "artifact-digest") {
        metadata.digest = `sha256:${"0".repeat(64)}`;
      }
      if (kind === "artifact-size") {
        metadata.size_in_bytes = 2 * 1024 * 1024 + 1;
      }
      if (kind === "artifact-producer") {
        metadata.workflow_run = { id: 89, head_sha: PUBLISH_SHA };
      }
      if (kind === "duplicate-name") {
        list.artifacts.push({ ...metadata, id: 33 });
        list.total_count++;
      }
      if (kind === "duplicate-id") {
        list.artifacts.push(metadata);
        list.total_count++;
      }
      if (kind === "count-gap") {
        list.total_count++;
      }
    });
    expect(result.status, result.stdout).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection.complete).toBe(false);
  });

  it.each(["missing", "expired", "legacy-only", "unsupported", "incomplete-link"])(
    "keeps authenticated historical %s unknown, not failed publication",
    async (kind) => {
      const fixture = publicationFixture();
      if (kind === "unsupported") {
        fixture.diagnostic.schemaVersion = 2;
      }
      if (kind === "incomplete-link") {
        Reflect.set(fixture.diagnostic.context.validationEvidence, "runAttempt", null);
      }
      const result = await runPublicationCli(fixture, undefined, (responses) => {
        const listPath = `repos/${REPOSITORY}/actions/runs/88/artifacts?per_page=100&page=1`;
        if (kind === "missing") {
          responses[listPath] = { total_count: 0, artifacts: [] };
        }
        if (kind === "legacy-only") {
          responses[listPath] = {
            total_count: 1,
            artifacts: [{ id: 99, name: "openclaw-release-postpublish-evidence-v2026.9.9" }],
          };
        }
        if (kind === "expired") {
          Object.assign(responses[`repos/${REPOSITORY}/actions/artifacts/3`] as object, {
            expired: true,
          });
        }
      });
      expect(result.status, result.stdout).toBe(0);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.collection.complete).toBe(true);
      expect(publication.relationship.status).toBe("unverified");
      expect(publication.surfaces.coreNpm.operation.state).toBe("unknown");
      expect(publication.diagnostics.state).toBe(kind === "incomplete-link" ? "available" : kind);
    },
  );

  it("classifies failed artifact reads as unavailable, never absence", async () => {
    const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
      responses[`repos/${REPOSITORY}/actions/runs/88/artifacts?per_page=100&page=1`] = {
        failure: "404 unavailable: /private/fixture/credential synthetic-secret",
      };
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection).toEqual({
      complete: false,
      error: "transport",
    });
    expect(result.stdout + result.stderr).not.toMatch(
      /synthetic-secret|private\/fixture|quota|404 unavailable/u,
    );
  });

  it("keeps Docker-only readback and advisory VCR API step conclusions separate from writer receipts", async () => {
    const fixture = publicationFixture();
    fixture.publisherJobs.push(
      {
        ...job("Verify already-published core npm package"),
        id: 8802,
        run_id: 88,
        run_attempt: 1,
        steps: [],
      },
      {
        ...job("Publish Docker images / publish"),
        id: 8803,
        run_id: 88,
        run_attempt: 1,
        steps: [],
      },
      {
        ...job("Mirror Docker images to Vercel Container Registry / mirror", "failure"),
        id: 8804,
        run_id: 88,
        run_attempt: 1,
        steps: [
          {
            number: 1,
            name: "Copy and verify immutable release images",
            status: "completed",
            conclusion: "success",
          },
          {
            number: 2,
            name: "Run custom-image Sandbox smoke",
            status: "completed",
            conclusion: "failure",
          },
          {
            number: 3,
            name: "Promote and verify channel aliases",
            status: "completed",
            conclusion: "skipped",
          },
        ],
      },
    );
    const result = await runPublicationCli(fixture);
    expect(result.status).toBe(0);
    const surfaces = JSON.parse(result.stdout).publication.surfaces;
    expect(surfaces.coreNpm.registryObservation.state).toBe("observed");
    expect(surfaces.coreNpm.operation.state).toBe("unknown");
    expect(surfaces.docker.children).toEqual([]);
    expect(surfaces.vcr.advisory).toBe(true);
    expect(
      surfaces.vcr.jobs[0].steps.map((step: { conclusion: string }) => step.conclusion),
    ).toEqual(["success", "failure", "skipped"]);
  });

  it.each(["openclaw-npm-release", "wrong"])(
    "observes supplied children only for %s workflow",
    async (workflow) => {
      const fixture = publicationFixture();
      Reflect.set(fixture.diagnostic.children.openclawNpm!, "suppliedRunId", "909");
      const result = await runPublicationCli(fixture, undefined, (responses) => {
        responses[`repos/${REPOSITORY}/actions/runs/909`] = {
          ...fixture.publisher,
          id: 909,
          workflow_id: 9090,
          path: `.github/workflows/${workflow}.yml`,
          ...(workflow === "wrong"
            ? {}
            : {
                run_attempt: 3,
                head_sha: SHA,
                head_branch: "older-tooling",
                conclusion: "success",
              }),
        };
        responses[`repos/${REPOSITORY}/actions/workflows/9090`] = {
          id: 9090,
          path: `.github/workflows/${workflow}.yml`,
        };
      });
      const publication = JSON.parse(result.stdout).publication;
      expect(result.status).toBe(workflow === "wrong" ? 1 : 0);
      expect(publication.relationship.status).toBe("verified");
      if (workflow === "wrong") {
        expect(publication.collection.error).toBe("identity-mismatch");
      } else {
        expect(publication.surfaces.coreNpm.children).toEqual([
          {
            runId: "909",
            workflowSha: SHA,
            workflowRef: "older-tooling",
            recordedAttempt: null,
            observedAttempt: 3,
            status: "completed",
            conclusion: "success",
            relation: "supplied",
          },
        ]);
      }
    },
  );

  it.each(["transport", "workflow", "attempt-limit"])(
    "authenticates the publisher before a validation child %s failure",
    async (kind) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const path = `repos/${REPOSITORY}/actions/runs/101`;
        if (kind === "transport") {
          responses[path] = { failure: "403" };
        } else {
          Object.assign(
            responses[path] as object,
            kind === "workflow"
              ? { path: ".github/workflows/wrong.yml" }
              : { run_attempt: 100000000 },
          );
        }
      });
      expect(result.status).toBe(1);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.collection.complete).toBe(false);
      expect(publication.relationship.status).toBe("verified");
      expect(publication.surfaces.coreNpm.registryObservation.state).toBe("observed");
    },
  );

  it.each([
    ["101", "advances", false],
    ["77", "advances", false],
    ["88", "advances", false],
    ["77", "unavailable", false],
    ["88", "unavailable", false],
    ["77", "completes", false],
    ["88", "completes", false],
    ["77", "changes SHA", false],
    ["88", "changes SHA", false],
    ["77", "advances", true],
    ["88", "advances", true],
    ["77", "unavailable", true],
    ["88", "unavailable", true],
  ] as const)(
    "rechecks run %s when it %s (child collection failure=%s)",
    async (runId, outcome, childFailure) => {
      const path = `repos/${REPOSITORY}/actions/runs/${runId}`;
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const before = responses[path] as { run_attempt: number };
        const after = {
          advances: { ...before, run_attempt: before.run_attempt + 1 },
          unavailable: { failure: "403" },
          completes: { ...before, display_title: "Updated workflow display title" },
          "changes SHA": { ...before, head_sha: "f".repeat(40) },
        }[outcome];
        responses[path] = {
          sequence: [
            outcome === "completes"
              ? { ...before, status: "in_progress", conclusion: null }
              : before,
            after,
          ],
        };
        if (childFailure) {
          responses[`repos/${REPOSITORY}/actions/runs/101`] = { failure: "403" };
        }
      });
      const complete = outcome === "completes";
      const error =
        outcome === "advances"
          ? "attempt-changed"
          : outcome === "unavailable"
            ? "transport"
            : "identity-mismatch";
      const publication = JSON.parse(result.stdout).publication;
      expect(result.status, result.stderr).toBe(complete ? 0 : 1);
      expect(publication.collection).toEqual({ complete, error: complete ? null : error });
      expect(publication.relationship.status).toBe(
        complete || runId === "101"
          ? "verified"
          : outcome === "unavailable"
            ? "unverified"
            : "invalid",
      );
      if (!complete && runId !== "101") {
        expect(publication.relationship.reason).toBe(error);
      }
      expect(publication.surfaces.coreNpm.registryObservation.state).toBe("observed");
      expect(result.calls.filter((call) => call.includes(path))).toHaveLength(2);
    },
  );

  it.each(["passive", "active"])(
    "bounds %s twenty-digit IDs before metadata reads",
    async (kind) => {
      const fixture = publicationFixture();
      Object.assign(
        fixture.diagnostic.children.pluginNpm!,
        kind === "active"
          ? {
              suppliedRunId: "12345678901234567890",
            }
          : {
              readbackArtifactId: "12345678901234567890",
              packageArtifactId: "12345678901234567",
              producerRunAttempt: "12345678901234567890",
            },
      );
      const result = await runPublicationCli(fixture);
      const publication = JSON.parse(result.stdout).publication;
      expect(result.status).toBe(kind === "active" ? 1 : 0);
      expect(publication.relationship.status).toBe("verified");
      expect(publication.surfaces.coreNpm.registryObservation.state).toBe("observed");
      if (kind === "active") {
        expect(publication.collection.error).toBe("limits");
      }
      expect(result.calls.flat().join(" ")).not.toContain("123456789012345");
    },
  );

  it.each(["main", "foreign", null])(
    "binds normal ClawHub dispatches to their recorded child ref %s",
    async (childRef) => {
      const fixture = publicationFixture();
      const parentRef = childRef === null ? PUBLISH_REF : "tideclaw/alpha/fixture";
      const fullRef = `refs/${childRef === null ? "tags" : "heads"}/${parentRef}`;
      fixture.publisher.head_branch = parentRef;
      fixture.publisher.path = `${PUBLISH_PATH}@${fullRef}`;
      fixture.diagnostic.context.suppliedToolingRef = fullRef;
      if (childRef !== null) {
        fixture.diagnostic.selection.clawHubWorkflowRef = "main";
      }
      const result = await runPublicationCli(fixture, undefined, async (responses, artifact) => {
        await artifact(4, fixture.publisher, "openclaw-release-children-88-1", "dispatch.json", {
          schemaVersion: 1,
          repository: REPOSITORY,
          parentRunId: "88",
          parentRunAttempt: "1",
          parentWorkflow: PUBLISH_PATH,
          toolingRef: parentRef,
          toolingFullRef: fullRef,
          toolingSha: PUBLISH_SHA,
          candidateSha: TARGET_SHA,
          normalClawHubRunId: childRef === null ? null : "909",
          normalClawHubRunAttempt: childRef === null ? null : "1",
        });
        if (childRef !== null) {
          responses[`repos/${REPOSITORY}/actions/runs/909`] = {
            ...fixture.publisher,
            id: 909,
            workflow_id: 9090,
            head_branch: childRef,
            path: ".github/workflows/plugin-clawhub-release.yml",
          };
          responses[`repos/${REPOSITORY}/actions/workflows/9090`] = {
            id: 9090,
            path: ".github/workflows/plugin-clawhub-release.yml",
          };
        }
      });
      expect(result.status).toBe(childRef === "foreign" ? 1 : 0);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.relationship.status).toBe("verified");
      expect(publication.dispatches[0]).toMatchObject({
        scope: "normal-clawhub",
        state: childRef === null ? "not-dispatched" : "acknowledged",
      });
      expect(publication.surfaces.pluginNpm.selection).toBe("unknown");
      if (childRef === "main") {
        expect(publication.surfaces.clawHub.children[0]).toMatchObject({
          runId: "909",
          workflowRef: "main",
          workflowSha: PUBLISH_SHA,
          recordedAttempt: 1,
        });
      }
    },
  );

  it.each(["in_progress", "failure"])(
    "observes detached Windows %s without equating acknowledgement and promotion",
    async (state) => {
      const fixture = publicationFixture();
      fixture.publisherJobs.push({
        ...job("Dispatch Windows assets after publication"),
        id: 8802,
        run_id: 88,
        run_attempt: 1,
        steps: [
          {
            number: 1,
            name: "Upload Windows dispatch evidence",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
      const native = {
        ...fixture.publisher,
        id: 909,
        workflow_id: 9090,
        path: ".github/workflows/windows-node-release.yml",
        status: state === "failure" ? "completed" : "in_progress",
        conclusion: state === "failure" ? "failure" : null,
      };
      const dispatch = {
        tag: "v2026.9.9",
        sourceTag: "windows-v1",
        installerDigests: "fixture-digests",
        state: "dispatched",
        childRunId: "909",
      };
      const result = await runPublicationCli(fixture, undefined, async (responses, artifact) => {
        await artifact(
          4,
          fixture.publisher,
          "windows-release-dispatch-88-1",
          "windows-dispatch.json",
          dispatch,
        );
        responses[`repos/${REPOSITORY}/actions/runs/909`] = native;
        responses[`repos/${REPOSITORY}/actions/workflows/9090`] = { id: 9090, path: native.path };
        responses[`repos/${REPOSITORY}/actions/runs/909/artifacts?per_page=100&page=1`] = {
          total_count: 0,
          artifacts: [],
        };
        if (state === "failure") {
          await artifact(5, native, "windows-release-promotion-909-1", "windows-promotion.json", {
            schemaVersion: 1,
            ...dispatch,
            outcome: "success",
            runUrl: `https://github.com/${REPOSITORY}/actions/runs/909`,
          });
          responses[`repos/${REPOSITORY}/actions/runs/909/attempts/1/jobs?per_page=100&page=1`] = {
            total_count: 1,
            jobs: [
              {
                ...job("Promote signed Windows installers", "failure"),
                id: 9091,
                run_id: 909,
                run_attempt: 1,
                steps: [
                  {
                    number: 1,
                    name: "Upload Windows promotion evidence",
                    status: "completed",
                    conclusion: "success",
                  },
                ],
              },
            ],
          };
        }
      });
      expect(result.status, result.stdout).toBe(0);
      const surface = JSON.parse(result.stdout).publication.surfaces.nativeWindows;
      expect(surface.children[0].recordedAttempt).toBeNull();
      expect(surface.children[0].status).toBe(native.status);
      expect(surface.children[0].conclusion).toBe(native.conclusion);
      expect(surface.operation.state).toBe("unknown");
      expect(surface.terminalMarker.state).toBe(state === "failure" ? "success" : "unknown");
      if (state === "failure") {
        expect(surface.jobs).toContainEqual({
          jobId: 9091,
          runId: "909",
          runAttempt: 1,
          status: "completed",
          conclusion: "failure",
          steps: [],
        });
      }
    },
  );

  it.each(["complete", "denied", "duplicate", "changed-total"])(
    "handles a second artifact page: %s",
    async (kind) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const prefix = `repos/${REPOSITORY}/actions/runs/88/artifacts?per_page=100&page=`;
        const first = responses[`${prefix}1`] as { artifacts: unknown[] };
        const diagnostic = first.artifacts[0];
        responses[`${prefix}1`] = {
          total_count: 101,
          artifacts: Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `other-${i}` })),
        };
        responses[`${prefix}2`] =
          kind === "denied"
            ? { failure: "403" }
            : {
                total_count: kind === "changed-total" ? 102 : 101,
                artifacts: [kind === "duplicate" ? { id: 1000, name: "duplicate" } : diagnostic],
              };
      });
      expect(result.status, result.stdout).toBe(kind === "complete" ? 0 : 1);
      expect(JSON.parse(result.stdout).publication.collection.complete).toBe(kind === "complete");
    },
  );

  it.each(["unexpected-entry", "expanded"])(
    "refuses %s archives before projecting diagnostics",
    async (kind) => {
      const fixture = publicationFixture();
      const result = await runPublicationCli(fixture, undefined, async (_responses, artifact) => {
        await artifact(
          3,
          fixture.publisher,
          "openclaw-release-postpublish-diagnostics-88-1",
          DIAGNOSTIC_FILE,
          fixture.diagnostic,
          (zip) => {
            if (kind === "unexpected-entry") {
              zip.file("extra.json", "{}");
            }
            if (kind === "expanded") {
              zip.file(DIAGNOSTIC_FILE, " ".repeat(128 * 1024 + 1));
            }
          },
        );
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).publication.verification.state).toBe("unknown");
    },
  );

  it.each(["metadata-drift", "postread-expiry", "page-limit", "json-limit"])(
    "bounds %s without fallback",
    async (kind) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const metadataPath = `repos/${REPOSITORY}/actions/artifacts/3`;
        if (kind === "metadata-drift" || kind === "postread-expiry") {
          const original = responses[metadataPath] as object;
          responses[metadataPath] = {
            sequence: [
              original,
              {
                ...original,
                ...(kind === "metadata-drift" ? { id: 4 } : { expires_at: "2000-01-01T00:00:00Z" }),
              },
            ],
          };
        }
        if (kind === "page-limit") {
          responses[`repos/${REPOSITORY}/actions/runs/88/artifacts?per_page=100&page=1`] = {
            total_count: 1001,
            artifacts: [],
          };
        }
        if (kind === "json-limit") {
          responses[`repos/${REPOSITORY}/actions/runs/88`] = {
            raw: " ".repeat(2 * 1024 * 1024 + 1),
          };
        }
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).publication.collection.complete).toBe(false);
    },
  );

  it("enforces the whole-command deadline independently of continuation settings", async () => {
    const result = await runPublicationCli(
      publicationFixture(),
      undefined,
      undefined,
      false,
      100000,
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection.error).toBe("deadline");
    expect(result.calls).toHaveLength(1);
  });

  it.each([
    [100, true],
    [100, false],
  ] as const)(
    "caps final output with %i steps (JSON=%s) without erasing observations",
    async (steps, json) => {
      const fixture = publicationFixture();
      Reflect.set(
        fixture.diagnostic.stages.pluginNpm,
        "packages",
        Array.from({ length: 256 }, (_, index) => ({
          name: `@openclaw/fixture-${index}`,
          state: "success",
          publication: "observed",
          error: null,
        })),
      );
      const args = [
        "status",
        "--run",
        "77",
        "--publication-run",
        "88",
        ...(json ? ["--json"] : []),
      ];
      const result = await runPublicationCli(fixture, args, (responses) => {
        const jobs = Array.from({ length: 999 }, (_, i) => ({
          ...job("Mirror Docker images to Vercel Container Registry / mirror"),
          id: 10000 + i,
          run_id: 88,
          run_attempt: 1,
          steps: Array.from({ length: steps }, (_step, index) => ({
            number: index + 1,
            name: "Copy and verify immutable release images",
            status: "completed",
            conclusion: "success",
          })),
        }));
        jobs.unshift(publicationFixture().publisherJobs[0]!);
        for (let page = 1; page <= 10; page++) {
          responses[
            `repos/${REPOSITORY}/actions/runs/88/attempts/1/jobs?per_page=100&page=${page}`
          ] = {
            total_count: jobs.length,
            jobs: jobs.slice((page - 1) * 100, page * 100),
          };
        }
      });
      expect(result.status).toBe(1);
      if (json) {
        const publication = JSON.parse(result.stdout).publication;
        expect(publication.collection).toEqual({
          complete: false,
          error: "limits",
          outputTruncated: true,
          validationStatusOmitted: true,
        });
        expect(publication.publisher).toMatchObject({ runId: "88", runAttempt: 1 });
        expect(publication.relationship).toMatchObject({
          status: "verified",
          originalPlanAttempt: 1,
          validationAttempt: 2,
        });
        expect(publication.diagnostics).toMatchObject({ state: "available", artifactId: 3 });
        expect(publication.surfaces.coreNpm.registryObservation.state).toBe("observed");
        expect(publication.surfaces.vcr.jobs).toHaveLength(4);
        expect(publication.surfaces.vcr.jobsOmitted).toBe(995);
        expect(publication.surfaces.vcr.jobs[0].steps).toHaveLength(steps);
        expect(publication.surfaces.vcr.jobs[0].steps[0].conclusion).toBe("success");
        expect(publication.surfaces.pluginNpm.packages).toHaveLength(4);
        expect(publication.surfaces.pluginNpm.packagesOmitted).toBe(252);
        expect(publication.surfaces.pluginNpm.packages[0]).toMatchObject({
          name: "@openclaw/fixture-0",
          state: "success",
          publication: "observed",
        });
      } else {
        expect(result.stdout).toContain("relationship: verified");
        expect(result.stdout).toContain("publisher: 88 attempt=1");
        expect(result.stdout).toContain("registry-observation=observed");
        expect(result.stdout).toContain("jobs omitted: 995");
        expect(result.stdout).toContain("packages omitted: 252");
        expect(result.stdout).toContain("validation detail omitted: output limit");
      }
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(256 * 1024);
    },
  );

  it("preserves legacy status JSON and performs no publication reads without the selector", async () => {
    const result = await runPublicationCli(publicationFixture(), [
      "status",
      "--run",
      "77",
      "--json",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.qualification).toMatchObject({ state: "passed", evidence: "accepted" });
    expect(value.children).toHaveLength(4);
    expect(value.passed).toHaveLength(4);
    expect(value.candidate).toMatchObject({ state: "current", tipSha: TARGET_SHA });
    expect(result.calls.flat().join(" ")).not.toMatch(
      /publication|runs\/88|workflows\/|artifacts\//u,
    );
  });

  it.each(["needs-refresh", "unavailable"] as const)(
    "labels green workloads with %s seal evidence separately",
    async (seal) => {
      const result = await runPublicationCli(
        publicationFixture(),
        ["status", "--run", "77", "--json"],
        undefined,
        false,
        0,
        seal,
      );
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.passed).toHaveLength(4);
      expect(value.collectionComplete).toBe(seal !== "unavailable");
      expect(value.qualification).toMatchObject({
        state: seal === "needs-refresh" ? "blocked" : "observation-unavailable",
        evidence: seal,
      });
      expect(value.nextCommand).toContain(
        seal === "needs-refresh" ? "continue --failed --dry-run" : "verify",
      );
    },
  );

  it("keeps blocked Decision and active Diagnostic Drain distinct", async () => {
    const fixture = publicationFixture();
    fixture.root.status = "in_progress";
    const result = await runPublicationCli(
      fixture,
      ["status", "--run", "77"],
      (responses) => {
        responses[`repos/${REPOSITORY}/actions/runs/77/jobs?filter=all&per_page=100`] = {
          jobs: [
            { ...job("Diagnostic Drain"), status: "in_progress", conclusion: null, run_attempt: 2 },
          ],
        };
      },
      false,
      0,
      "accepted",
      "blocked_diagnostics_running",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("qualification: blocked; evidence: pending");
    expect(result.stdout).toContain("drain: in_progress");
    expect(result.stdout).toContain("actual test blocker");
    expect(result.stdout).toContain("Diagnostic Drain is still collecting");
    expect(result.stdout).toContain("next: pnpm frv watch --run 77");
  });

  it("labels canceled children and never suggests retry while descendants remain active", async () => {
    const fixture = publicationFixture();
    fixture.root.conclusion = "failure";
    const result = await runPublicationCli(fixture, ["status", "--run", "77"], (responses) => {
      const canceled = `repos/${REPOSITORY}/actions/runs/101`;
      responses[canceled] = {
        ...(responses[canceled] as Record<string, unknown>),
        conclusion: "cancelled",
      };
      responses[`${canceled}/attempts/1/jobs?per_page=100&page=1`] = {
        jobs: [{ ...job("test"), conclusion: "cancelled" }],
      };
      const active = `repos/${REPOSITORY}/actions/runs/202`;
      responses[active] = {
        ...(responses[active] as Record<string, unknown>),
        status: "in_progress",
        conclusion: null,
      };
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("normalCi: failed (cancelled)");
    expect(result.stdout).toContain("next: pnpm frv watch --run 77");
    expect(result.calls.flat()).not.toContain("POST");
  });

  it.each(["superseded", "unavailable"] as const)(
    "labels a sealed candidate tip %s without claiming current-tip qualification",
    async (tipState) => {
      const result = await runPublicationCli(
        publicationFixture(),
        ["status", "--run", "77", "--json"],
        (responses) => {
          responses[`repos/${REPOSITORY}/git/ref/heads/release/2026.9.9`] =
            tipState === "superseded"
              ? { object: { sha: "d".repeat(40) } }
              : { failure: "HTTP 403 Resource not accessible by integration" };
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.qualification.state).toBe("passed");
      expect(value.collectionComplete).toBe(tipState !== "unavailable");
      expect(value.candidate).toMatchObject({
        sha: TARGET_SHA,
        state: tipState === "superseded" ? "superseded" : "unknown",
        tipSha: tipState === "superseded" ? "d".repeat(40) : null,
      });
      expect(result.calls.flat()).not.toContain("POST");
    },
  );

  it.each(["transport", "missing drain"] as const)(
    "retains collected child facts when parent job observation has %s",
    async (failure) => {
      const result = await runPublicationCli(
        publicationFixture(),
        ["status", "--run", "77", "--json"],
        (responses) => {
          responses[`repos/${REPOSITORY}/actions/runs/77/jobs?filter=all&per_page=100`] =
            failure === "transport"
              ? { failure: "HTTP 403 Resource not accessible by integration" }
              : { jobs: [] };
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.qualification.state).toBe(
        failure === "transport" ? "observation-unavailable" : "passed",
      );
      expect(value.collectionComplete).toBe(false);
      expect(value.passed).toHaveLength(4);
      expect(result.calls.flat()).not.toContain("POST");
    },
  );

  it.each(["rerun", "continue", "verify"])(
    "preserves legacy %s refusal before publication reads or mutation",
    async (command) => {
      const fixture = publicationFixture();
      if (command !== "rerun") {
        Object.assign(fixture.executionPlan, historicalExecutionPlanArtifact());
        for (const key of [
          "attemptEvidenceVersion",
          "candidate",
          "candidateRequest",
          "repository",
        ]) {
          Reflect.deleteProperty(fixture.executionPlan, key);
        }
      }
      const result = await runPublicationCli(fixture, [
        command,
        "--run",
        "77",
        ...(command === "rerun"
          ? ["--job", "missing:test"]
          : command === "continue"
            ? ["--failed"]
            : []),
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        command === "rerun"
          ? "job selector names an unselected child: missing"
          : "predates attempt-aware immutable plans",
      );
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]?.slice(0, 3)).toEqual(["run", "download", "77"]);
    },
  );

  it("strips arbitrary artifact extras, job names, URLs and control characters from output", async () => {
    const fixture = publicationFixture();
    const unsafe = "synthetic-secret /private/fixture/key \u001b[31m";
    Reflect.set(fixture.diagnostic, "rawError", unsafe);
    fixture.publisher.display_title = unsafe;
    fixture.publisherJobs.push({ ...job(unsafe), id: 8899, run_id: 88, run_attempt: 1, steps: [] });
    const result = await runPublicationCli(fixture);
    expect(result.status).toBe(0);
    expect(
      JSON.parse(result.stdout).children.every(
        (child: Record<string, unknown>) => !Object.hasOwn(child, "jobs"),
      ),
    ).toBe(true);
    expect(result.stdout + result.stderr).not.toMatch(/synthetic-secret|private\/fixture/u);
    expect(result.stdout + result.stderr).not.toContain("\u001b");
  });
});
