import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { validateParentManifest } from "../../scripts/release-ci-summary.mjs";
import {
  SHA,
  TARGET_SHA,
  SOURCE_REF,
  REPOSITORY,
  job,
  requiredChildren,
  executionPlanArtifact,
  runFor,
  rootRun,
} from "./frv.test-support.js";

describe("FRV protected gh evidence reads", () => {
  const jobLogArgs = [
    "api",
    `repos/${REPOSITORY}/actions/jobs/1/logs`,
    "-H",
    "Cache-Control: max-age=0",
  ];

  it.each([
    [
      "getAttemptJobs",
      ["101", 2],
      "actions/runs/101/attempts/2/jobs?per_page=100",
      [{ id: 1 }, { id: 2 }],
    ],
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

  it("reads the mutable release tip freshly even when watcher reads are cached", () => {
    const result = runProtectedFrv(
      "getRef",
      ["refs/heads/release/candidate"],
      "git/ref/heads/release/candidate",
      "none",
      true,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toHaveLength(1);
  });

  it.each(["403"] as const)(
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

  it("preserves unrelated outcomes without an unauthorized fallback", () => {
    const result = runProtectedFrv("getJobLog", [1], "actions/jobs/1/logs", "unrelated");
    expect(result.status, result.stderr).toBe(23);
    expect(result.stderr).toContain("unrelated log failure");
    expect(result.calls).toHaveLength(1);
    expect(result.calls).toEqual([[...jobLogArgs, "--allow-escape-sequences"]]);
  });
});

function runProtectedFrv(
  method: string,
  args: Array<string | number | Record<string, unknown>>,
  endpoint: string,
  failure: "none" | "unrelated" | "empty" | "403" = "none",
  cachedReads = false,
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
if (args[0] !== "api" || !args.includes(${JSON.stringify(`repos/${REPOSITORY}/${endpoint}`)})) fail("unexpected request", 17);
if (!args.some((arg, i) => ["-H", "--header"].includes(arg) && args[i+1] === "Cache-Control: max-age=0")) fail("missing live header", 18);
if (${endpoint.endsWith("/logs")} && failure === "unrelated") fail("unrelated log failure", 23);
if (${endpoint.endsWith("/logs")} && failure === "none" && !args.includes("--allow-escape-sequences")) fail("missing escape-sequence flag", 20);
if (!${endpoint.endsWith("/logs")}) {
  if (!args.includes("--include")) fail("missing included headers", 17);
  process.stdout.write("HTTP/2.0 200 OK\\nContent-Type: application/json\\r\\n\\r\\n");
}
if (failure === "403") {
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
      import {releaseGhRateLimitRetryAt, classifyReleaseGhTransportError} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/full-release-validation-policy.mjs")).href)};
      const throttled = ${JSON.stringify(failure)} === "403";
      if (throttled) Date.now = () => 10_000;
      try {
        console.log(JSON.stringify(await createClient(${JSON.stringify(REPOSITORY)}, { cachedReads: ${cachedReads} })[${JSON.stringify(method)}](...${JSON.stringify(args)})));
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
) {
  const directory = mkdtempSync(join(tmpdir(), "frv-publication-"));
  const legacy = !args.includes("--publication-run");
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
  await amend(responses, artifact);
  const responseDirectory = join(directory, "responses");
  mkdirSync(responseDirectory);
  for (const [requestPath, value] of Object.entries(responses)) {
    const key = createHash("sha256").update(requestPath).digest("hex");
    writeFileSync(join(responseDirectory, `${key}.json`), JSON.stringify(value));
  }
  writeFileSync(join(directory, "legacy-plan.json"), JSON.stringify(fixture.executionPlan));
  writeFileSync(
    join(directory, "no-network.mjs"),
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
globalThis.fetch = () => { throw new Error('unplanned Node fetch'); };
for (const name of ["execFileSync", "execFile", "spawn", "spawnSync"]) {
  const original = childProcess[name];
  const guarded = (method) => (command, ...args) => {
    if (command !== "gh" && command !== ${JSON.stringify(join(directory, "gh"))}) throw new Error("unplanned executable");
    return method(command, ...args);
  };
  childProcess[name] = guarded(original);
  const custom = Symbol.for("nodejs.util.promisify.custom");
  if (original[custom]) childProcess[name][custom] = guarded(original[custom]);
}
syncBuiltinESMExports();
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
  if (name !== "full-release-execution-plan-77") reject();
  fs.copyFileSync("legacy-plan.json", require("node:path").join(args[args.indexOf("--dir") + 1], "full-release-execution-plan.json"));
  process.exit(0);
}
if (args[0] !== "api" || (!legacy && (!args.includes("GET") || !args.includes("github.com"))) || !args.includes("Cache-Control: max-age=0")) reject();
if (!legacy && (args.includes("--include") || args.includes("--paginate"))) reject();
let path = args.find(a => a.startsWith("repos/"));
if (legacy && path.endsWith("/jobs?per_page=100")) path += "&page=1";
const key = require("node:crypto").createHash("sha256").update(path).digest("hex");
const response = require("node:path").join("responses", key + ".json");
if (!fs.existsSync(response)) reject();
let value = JSON.parse(fs.readFileSync(response, "utf8"));
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
  it("projects unattempted verification without confusing readback and publication", async () => {
    const fixture = publicationFixture();
    fixture.diagnostic.verification = "unattempted";
    fixture.diagnostic.stages.coreNpm.state = "unattempted";
    fixture.diagnostic.stages.coreNpm.publication = "unknown";
    validateParentManifest(fixture.manifest, {
      runId: "77",
      runAttempt: 2,
      workflowRef: SOURCE_REF,
      workflowSha: SHA,
    });
    const result = await runPublicationCli(fixture);
    const value = JSON.parse(result.stdout);
    const publication = value.publication;
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(publication.relationship).toMatchObject({
      status: "verified",
      originalPlanAttempt: 1,
      validationAttempt: 2,
    });
    expect(publication.publisher).toMatchObject({
      runId: "88",
      runAttempt: 1,
      conclusion: "failure",
    });
    expect(publication.surfaces.activation.operation.state).toBe("unknown");
    expect(value.children).toHaveLength(4);
    expect(result.calls.length).toBeGreaterThan(0);
    expect(publication.surfaces.coreNpm).toMatchObject({
      selection: "unknown",
      verificationSelection: "unknown",
      operation: { state: "unknown" },
      verification: { state: "unattempted" },
    });
  });

  it.each([
    ["status", "--run", "77", "--publication-run", "88", "--repo", "../private"],
    ["continue", "--failed", "--run", "77", "--publication-run", "88"],
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

  it.each(["artifact-digest", "artifact-size", "duplicate-name"])(
    "rejects independently observed %s",
    async (kind) => {
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const prefix = `repos/${REPOSITORY}/actions/`;
        const metadata = responses[`${prefix}artifacts/3`] as Record<string, unknown>;
        const list = responses[`${prefix}runs/88/artifacts?per_page=100&page=1`] as {
          total_count: number;
          artifacts: unknown[];
        };
        if (kind === "artifact-digest") {
          metadata.digest = `sha256:${"0".repeat(64)}`;
        }
        if (kind === "artifact-size") {
          metadata.size_in_bytes = 2 * 1024 * 1024 + 1;
        }
        if (kind === "duplicate-name") {
          list.artifacts.push({ ...metadata, id: 33 });
          list.total_count++;
        }
      });
      expect(result.status, result.stdout).toBe(1);
      expect(JSON.parse(result.stdout).publication.collection.complete).toBe(false);
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

  it.each(["wrong"])("observes supplied children only for %s workflow", async (workflow) => {
    const fixture = publicationFixture();
    Reflect.set(fixture.diagnostic.children.openclawNpm!, "suppliedRunId", "909");
    const result = await runPublicationCli(fixture, undefined, (responses) => {
      responses[`repos/${REPOSITORY}/actions/runs/909`] = {
        ...fixture.publisher,
        id: 909,
        workflow_id: 9090,
        path: `.github/workflows/${workflow}.yml`,
      };
      responses[`repos/${REPOSITORY}/actions/workflows/9090`] = {
        id: 9090,
        path: `.github/workflows/${workflow}.yml`,
      };
    });
    const publication = JSON.parse(result.stdout).publication;
    expect(result.status).toBe(1);
    expect(publication.relationship.status).toBe("verified");
    expect(publication.collection.error).toBe("identity-mismatch");
  });

  it.each([
    ["101", "advances", false],
    ["88", "advances", false],
    ["88", "changes SHA", false],
    ["88", "advances", true],
  ] as const)(
    "rechecks run %s when it %s (child collection failure=%s)",
    async (runId, outcome, childFailure) => {
      const path = `repos/${REPOSITORY}/actions/runs/${runId}`;
      const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
        const before = responses[path] as { run_attempt: number };
        const after = {
          advances: { ...before, run_attempt: before.run_attempt + 1 },
          "changes SHA": { ...before, head_sha: "f".repeat(40) },
        }[outcome];
        responses[path] = {
          sequence: [before, after],
        };
        if (childFailure) {
          responses[`repos/${REPOSITORY}/actions/runs/101`] = { failure: "403" };
        }
      });
      const error = outcome === "advances" ? "attempt-changed" : "identity-mismatch";
      const publication = JSON.parse(result.stdout).publication;
      expect(result.status, result.stderr).toBe(1);
      expect(publication.collection).toEqual({ complete: false, error });
      expect(publication.relationship.status).toBe(runId === "101" ? "verified" : "invalid");
      if (runId !== "101") {
        expect(publication.relationship.reason).toBe(error);
      }
      expect(publication.surfaces.coreNpm.registryObservation.state).toBe("observed");
      expect(result.calls.filter((call) => call.includes(path))).toHaveLength(2);
    },
  );

  it.each(["foreign"])(
    "binds normal ClawHub dispatches to their recorded child ref %s",
    async (childRef) => {
      const fixture = publicationFixture();
      const parentRef = "tideclaw/alpha/fixture";
      const fullRef = `refs/heads/${parentRef}`;
      fixture.publisher.head_branch = parentRef;
      fixture.publisher.path = `${PUBLISH_PATH}@${fullRef}`;
      fixture.diagnostic.context.suppliedToolingRef = fullRef;
      fixture.diagnostic.selection.clawHubWorkflowRef = "main";
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
          normalClawHubRunId: "909",
          normalClawHubRunAttempt: "1",
        });
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
      });
      expect(result.status).toBe(1);
      const publication = JSON.parse(result.stdout).publication;
      expect(publication.relationship.status).toBe("verified");
      expect(publication.dispatches[0]).toMatchObject({
        scope: "normal-clawhub",
        state: "acknowledged",
      });
      expect(publication.surfaces.pluginNpm.selection).toBe("unknown");
    },
  );

  it.each(["duplicate", "changed-total"])("handles a second artifact page: %s", async (kind) => {
    const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
      const prefix = `repos/${REPOSITORY}/actions/runs/88/artifacts?per_page=100&page=`;
      const first = responses[`${prefix}1`] as { artifacts: unknown[] };
      const diagnostic = first.artifacts[0];
      responses[`${prefix}1`] = {
        total_count: 101,
        artifacts: Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `other-${i}` })),
      };
      responses[`${prefix}2`] = {
        total_count: kind === "changed-total" ? 102 : 101,
        artifacts: [kind === "duplicate" ? { id: 1000, name: "duplicate" } : diagnostic],
      };
    });
    expect(result.status, result.stdout).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection.complete).toBe(false);
  });

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

  it("bounds metadata-drift without fallback", async () => {
    const result = await runPublicationCli(publicationFixture(), undefined, (responses) => {
      const metadataPath = `repos/${REPOSITORY}/actions/artifacts/3`;
      const original = responses[metadataPath] as object;
      responses[metadataPath] = { sequence: [original, { ...original, id: 4 }] };
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).publication.collection.complete).toBe(false);
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
        const jobs = Array.from({ length: 64 }, (_, i) => ({
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
        const stepEvidence = jobs.flatMap((entry) =>
          entry.steps.map(({ number, status, conclusion }) => ({ number, status, conclusion })),
        );
        expect(Buffer.byteLength(JSON.stringify(stepEvidence))).toBeGreaterThan(256 * 1024);
        jobs.unshift(publicationFixture().publisherJobs[0]!);
        for (let page = 1; page <= Math.ceil(jobs.length / 100); page++) {
          responses[
            `repos/${REPOSITORY}/actions/runs/88/attempts/1/jobs?per_page=100&page=${page}`
          ] = {
            total_count: jobs.length,
            jobs: jobs.slice((page - 1) * 100, page * 100),
          };
        }
      });
      expect(
        result.status,
        JSON.stringify({ error: result.error?.message, reads: result.calls.length }),
      ).toBe(1);
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
        expect(publication.surfaces.vcr.jobsOmitted).toBe(60);
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
        expect(result.stdout).toContain("jobs omitted: 60");
        expect(result.stdout).toContain("packages omitted: 252");
        expect(result.stdout).toContain("validation detail omitted: output limit");
      }
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(256 * 1024);
    },
  );

  it("preserves legacy rerun refusal before publication reads or mutation", async () => {
    const result = await runPublicationCli(publicationFixture(), [
      "rerun",
      "--run",
      "77",
      "--job",
      "missing:test",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("job selector names an unselected child: missing");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.slice(0, 3)).toEqual(["run", "download", "77"]);
  });

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
