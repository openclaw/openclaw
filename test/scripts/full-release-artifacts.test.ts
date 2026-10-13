import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";

const SCRIPT = resolve("scripts/full-release-artifacts.mjs");
const REPOSITORY = "openclaw/openclaw";
const WORKFLOW = ".github/workflows/full-release-artifacts.yml";
const SOURCE_SHA = "a".repeat(40);
const TOOLING_SHA = "b".repeat(40);
const DISPATCH_ID = "full-release-validation-51-1-artifacts-npm";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function artifactRequest() {
  return {
    stage: "npm",
    dispatchId: DISPATCH_ID,
    repository: REPOSITORY,
    sourceSha: SOURCE_SHA,
    toolingSha: TOOLING_SHA,
    workflowRef: "main",
    releaseTag: "v2026.8.1",
    preflightPhase: "all",
  };
}

function workflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 81,
    run_attempt: 1,
    event: "workflow_dispatch",
    path: `${WORKFLOW}@refs/heads/main`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    head_sha: TOOLING_SHA,
    head_branch: "main",
    display_title: `Full Release Artifacts ${DISPATCH_ID}`,
    status: "in_progress",
    conclusion: null as string | null,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/81`,
    ...overrides,
  };
}

function npmBundles() {
  const producer = {
    repository: REPOSITORY,
    workflowRef: `${REPOSITORY}/${WORKFLOW}@refs/heads/main`,
    workflowSha: TOOLING_SHA,
    runId: "81",
    runAttempt: "1",
    jobId: "901",
    jobName: "Prepare npm artifacts / Prepare publishable npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const raw = {
    schema: "openclaw.prepared-npm-bundle/v1",
    source: { sha: SOURCE_SHA },
    producer,
    artifact: {
      id: "401",
      name: "openclaw-npm-package-81-1",
      digest: "c".repeat(64),
      runId: "81",
      runAttempt: "1",
    },
    package: {
      name: "openclaw",
      version: "2026.8.1",
      fileName: "openclaw-2026.8.1.tgz",
      sha256: "d".repeat(64),
      sourceSha: SOURCE_SHA,
    },
    corePackages: [],
    manifestSha256: "e".repeat(64),
  };
  const qualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: raw.source,
    producer: {
      ...producer,
      jobId: "902",
      jobName: "Prepare npm artifacts / Qualify prepared npm package",
    },
    artifact: { ...raw.artifact, id: "402", name: `openclaw-npm-preflight-${SOURCE_SHA}` },
    preparedBundle: raw,
    manifestSha256: "f".repeat(64),
  };
  const outputs = {
    prepared_bundle_json: JSON.stringify(raw),
    qualified_preflight_bundle_json: JSON.stringify(qualified),
  };
  const jobs = [raw, qualified].map(({ producer: owner }) => ({
    id: Number(owner.jobId),
    name: owner.jobName,
    run_id: 81,
    run_attempt: 1,
    head_sha: TOOLING_SHA,
    status: "completed",
    conclusion: "success" as string | null,
  }));
  return { raw, qualified, outputs, jobs };
}

function fixture() {
  const root = tempDirs.make("full-release-artifacts-");
  const bin = join(root, "bin");
  const responsesPath = join(root, "responses.json");
  const preloadPath = join(root, "fetch-preload.mjs");
  const responses: Record<string, unknown> = {};
  const downloads: Record<string, string> = {};
  let invocation = 0;
  let artifactId = 500;
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(["gh", ...args]) + "\\n");
if (args[0] !== "api" || args.includes("POST")) throw new Error("Unexpected GitHub mutation");
const { responses } = JSON.parse(readFileSync(process.env.FIXTURE_RESPONSES, "utf8"));
if (!Object.hasOwn(responses, args[1])) throw new Error("Unexpected GitHub endpoint: " + args[1]);
const response = responses[args[1]];
if (response.fixtureError) { process.stderr.write(response.fixtureError); process.exit(1); }
process.stdout.write(JSON.stringify(response));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    preloadPath,
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const { responses, downloads } = JSON.parse(readFileSync(process.env.FIXTURE_RESPONSES, "utf8"));
if (process.env.FIXTURE_STOP_ON_WAIT === "true") {
  globalThis.setTimeout = () => { throw new Error("Fixture reached another artifact poll"); };
}
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.github.com") throw new Error("Unexpected fetch origin");
  const endpoint = url.pathname.slice(1) + url.search;
  appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(["fetch", endpoint]) + "\\n");
  if (Object.hasOwn(downloads, endpoint)) {
    if (process.env.FIXTURE_RERUN_DURING_DOWNLOAD === "true") {
      const current = JSON.parse(readFileSync(process.env.FIXTURE_RESPONSES, "utf8"));
      const runEndpoint = "repos/" + process.env.GITHUB_REPOSITORY + "/actions/runs/" + process.env.ARTIFACT_RUN_ID;
      current.responses[runEndpoint].run_attempt = 2;
      writeFileSync(process.env.FIXTURE_RESPONSES, JSON.stringify(current));
    }
    return new Response(readFileSync(downloads[endpoint]));
  }
  if (Object.hasOwn(responses, endpoint)) return Response.json(responses[endpoint]);
  throw new Error("Unexpected fetch endpoint: " + endpoint);
};
`,
  );
  const api = (path: string, value: unknown) => {
    responses[`repos/${REPOSITORY}/${path}`] = value;
  };
  const run = (command: string, env: NodeJS.ProcessEnv = {}) => {
    const directory = join(root, `invocation-${++invocation}`);
    mkdirSync(directory);
    const outputPath = join(directory, "github-output");
    const callsPath = join(directory, "calls.jsonl");
    writeFileSync(responsesPath, JSON.stringify({ responses, downloads }));
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preloadPath).href, SCRIPT, command],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          ARTIFACT_STAGE: "npm",
          ARTIFACT_DISPATCH_ID: DISPATCH_ID,
          TARGET_SHA: SOURCE_SHA,
          PARENT_WORKFLOW_SHA: TOOLING_SHA,
          CHILD_WORKFLOW_REF: "main",
          RELEASE_TAG: "v2026.8.1",
          PREFLIGHT_PHASE: "all",
          GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_SHA: TOOLING_SHA,
          GITHUB_REF_NAME: "main",
          GITHUB_RUN_ID: "51",
          GITHUB_RUN_ATTEMPT: "1",
          ARTIFACT_RUN_ID: "81",
          ARTIFACT_RUN_ATTEMPT: "1",
          GH_TOKEN: "test-token",
          GITHUB_TOKEN: "",
          NODE_OPTIONS: "",
          PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
          ...env,
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: outputPath,
          FIXTURE_RESPONSES: responsesPath,
          FIXTURE_CALLS: callsPath,
        },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    const outputLines = existsSync(outputPath)
      ? readFileSync(outputPath, "utf8").trim().split("\n")
      : [];
    const outputs = Object.fromEntries(
      outputLines.map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    const calls = existsSync(callsPath)
      ? readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
    return { ...result, outputs, calls };
  };
  const artifact = (
    name: string,
    fileName: string,
    value: unknown,
    repositoryListing = false,
    runId = 81,
  ) => {
    const bytes = makeStoredZip({ [fileName]: JSON.stringify(value) });
    const id = ++artifactId;
    const archivePath = join(root, `artifact-${id}.zip`);
    writeFileSync(archivePath, bytes);
    const metadata = {
      id,
      name,
      digest: `sha256:${sha256(bytes)}`,
      size_in_bytes: bytes.length,
      expired: false,
      expires_at: "2030-01-01T00:00:00Z",
      workflow_run: { id: runId, head_sha: TOOLING_SHA },
    };
    api(
      `${repositoryListing ? "actions" : `actions/runs/${runId}`}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
      {
        total_count: 1,
        artifacts: [metadata],
      },
    );
    api(`actions/artifacts/${id}`, metadata);
    downloads[`repos/${REPOSITORY}/actions/artifacts/${id}/zip`] = archivePath;
    return { bytes, archivePath, metadata };
  };
  const npm = npmBundles();
  api(
    "actions/runs/51",
    workflowRun({ id: 51, path: ".github/workflows/full-release-validation.yml" }),
  );
  api("actions/runs/81", workflowRun());
  api("actions/runs/81/attempts/1", workflowRun());
  api("actions/runs/81/attempts/1/jobs?per_page=100&page=1", {
    total_count: npm.jobs.length,
    jobs: npm.jobs,
  });
  for (const job of npm.jobs) {
    api(`actions/jobs/${job.id}`, job);
  }
  return { root, api, run, artifact, ...npm };
}

function publicationReuseFixture(changedReceipt = false) {
  const test = fixture();
  const workflowRef = `release-ci/${TOOLING_SHA.slice(0, 12)}-123`;
  const currentRef = `release-ci/${TOOLING_SHA.slice(0, 12)}-456`;
  const fullRef = `refs/heads/${workflowRef}`;
  test.raw.source.sha = TOOLING_SHA;
  test.raw.package.sourceSha = TOOLING_SHA;
  test.raw.producer.workflowRef = `${REPOSITORY}/${WORKFLOW}@${fullRef}`;
  test.qualified.producer.workflowRef = test.raw.producer.workflowRef;
  test.qualified.artifact.name = `openclaw-npm-preflight-${TOOLING_SHA}`;
  const npmRun = workflowRun({
    status: "completed",
    conclusion: "success",
    head_branch: workflowRef,
    path: `${WORKFLOW}@${fullRef}`,
  });
  test.api("actions/runs/81", npmRun);
  test.api("actions/runs/81/attempts/1", npmRun);
  for (const descriptor of [test.raw, test.qualified]) {
    test.api(`actions/artifacts/${descriptor.artifact.id}`, {
      id: Number(descriptor.artifact.id),
      name: descriptor.artifact.name,
      digest: `sha256:${descriptor.artifact.digest}`,
      size_in_bytes: 256,
      expired: false,
      workflow_run: { id: 81, head_sha: TOOLING_SHA },
    });
  }
  const receipt = (stage: string, runId: string, outputs: Record<string, string>) => ({
    schema: "openclaw.full-release-artifact-receipt/v1",
    ...artifactRequest(),
    sourceSha: TOOLING_SHA,
    workflowRef,
    stage,
    dispatchId: `full-release-validation-51-1-artifacts-${stage}`,
    runId,
    runAttempt: "1",
    outputs,
  });
  const qualifiedReceipt = structuredClone(test.qualified);
  if (changedReceipt) {
    qualifiedReceipt.manifestSha256 = "0".repeat(64);
  }
  test.artifact(
    "full-release-artifact-receipt-81-1",
    "artifact-receipt.json",
    receipt("npm", "81", {
      prepared_bundle_json: JSON.stringify(test.raw),
      qualified_preflight_bundle_json: JSON.stringify(qualifiedReceipt),
    }),
  );
  const artifactName = `docker-release-${TOOLING_SHA}-1`;
  const dockerManifest = {
    schemaVersion: 1,
    repository: REPOSITORY,
    sourceSha: TOOLING_SHA,
    toolingSha: TOOLING_SHA,
    tag: "v2026.8.1",
    version: "2026.8.1",
    imageTagSuffix: "",
    artifactName,
    includeBrowser: false,
    builtAt: "2026-08-01T00:00:00Z",
    producer: {
      runId: "91",
      runAttempt: "1",
      workflowSha: TOOLING_SHA,
      workflowRef: `${REPOSITORY}/${WORKFLOW}@${fullRef}`,
      preparationWorkflowRef: `${REPOSITORY}/.github/workflows/docker-release-prepare.yml@${fullRef}`,
      jobId: "903",
      jobName: "Prepare Docker artifacts / Seal prepared Docker images",
    },
    architectures: ["amd64", "arm64"].map((architecture, index) => ({
      architecture,
      artifact: {
        id: String(601 + index),
        name: `${artifactName}-${architecture}`,
        digest: `sha256:${"d".repeat(64)}`,
      },
      images: [
        {
          variant: "default",
          smoke: "success",
          attestations: "success",
          manifests: [],
          indexDigest: `sha256:${"a".repeat(64)}`,
          imageDigest: `sha256:${"b".repeat(64)}`,
          configDigest: `sha256:${"c".repeat(64)}`,
        },
      ],
    })),
  };
  const docker = {
    preparedRunId: "91",
    preparedRunAttempt: "1",
    preparedArtifactName: artifactName,
    preparedManifestSha256: sha256(Buffer.from(JSON.stringify(dockerManifest))),
  };
  const dockerRun = workflowRun({
    id: 91,
    status: "completed",
    conclusion: "success",
    head_branch: workflowRef,
    path: `${WORKFLOW}@${fullRef}`,
    display_title: "Full Release Artifacts full-release-validation-51-1-artifacts-docker",
    referenced_workflows: [
      {
        path: `${REPOSITORY}/.github/workflows/docker-release-prepare.yml@${TOOLING_SHA}`,
        sha: TOOLING_SHA,
        ref: fullRef,
      },
    ],
  });
  test.api("actions/runs/91", dockerRun);
  test.api("actions/runs/91/attempts/1", dockerRun);
  test.api("actions/jobs/903", {
    id: 903,
    name: dockerManifest.producer.jobName,
    run_id: 91,
    run_attempt: 1,
    head_sha: TOOLING_SHA,
    status: "completed",
    conclusion: "success",
  });
  const payloads = dockerManifest.architectures.map(({ artifact }) => {
    const metadata = {
      id: Number(artifact.id),
      name: artifact.name,
      digest: artifact.digest,
      size_in_bytes: 256,
      expired: false,
      workflow_run: { id: 91, head_sha: TOOLING_SHA },
    };
    test.api(`actions/artifacts/${artifact.id}`, metadata);
    return metadata;
  });
  test.artifact(
    "full-release-artifact-receipt-91-1",
    "artifact-receipt.json",
    receipt("docker", "91", {
      prepared_run_id: docker.preparedRunId,
      prepared_run_attempt: docker.preparedRunAttempt,
      prepared_artifact_name: artifactName,
      prepared_manifest_sha256: docker.preparedManifestSha256,
    }),
    false,
    91,
  );
  test.artifact(artifactName, "manifest.json", dockerManifest, false, 91);
  const sdk = test.artifact(
    "plugin-sdk-api-release-diff-81-1",
    "plugin-sdk-api-release-evidence.json",
    {},
  ).metadata;
  const evidence = {
    schema: "openclaw.release-validation-evidence/v4",
    valid: true,
    directRoot: true,
    conclusions: { allRequiredSucceeded: true },
    root: { runId: "51", targetSha: TOOLING_SHA },
    manifest: {
      workflowName: "Full Release Validation",
      runId: "51",
      runAttempt: "1",
      sourceParentRunAttempt: 1,
      workflowSha: TOOLING_SHA,
      targetSha: TOOLING_SHA,
      workflowRef,
      workflowFullRef: fullRef,
      publicationArtifacts: { npmPreflight: test.qualified, docker, pluginNpm: null },
    },
  };
  const validator = join(test.root, "validate-evidence.mjs");
  writeFileSync(
    validator,
    `
import assert from "node:assert/strict";
const value = (key) => process.argv[process.argv.indexOf(key) + 1];
const qualification = JSON.parse(value("--qualification-reuse-json"));
assert.equal(qualification.candidateSha, "${TOOLING_SHA}");
assert.equal(qualification.workflowRef, "${currentRef}");
assert.equal(value("--verifier-source-sha"), "${"f".repeat(40)}");
process.stdout.write(${JSON.stringify(JSON.stringify(evidence))});
`,
  );
  return {
    ...test,
    docker,
    sdk,
    payloads,
    env: {
      EVIDENCE_REUSE: "true",
      EVIDENCE_POLICY: "exact-target-full-validation-v1",
      EVIDENCE_SHA: TOOLING_SHA,
      EVIDENCE_ROOT_RUN_ID: "51",
      TARGET_SHA: TOOLING_SHA,
      GITHUB_REF_NAME: currentRef,
      GITHUB_RUN_ID: "52",
      QUALIFICATION_INPUTS_JSON: "{}",
      OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: validator,
      SOURCE_ADMISSION_JSON: JSON.stringify({
        qualificationAdmission: {
          workflowHeadBranch: "main",
          workflowFullRef: "refs/heads/main",
          workflowSha: "f".repeat(40),
        },
      }),
    },
  };
}

function expectRejected(result: ReturnType<ReturnType<typeof fixture>["run"]>, message: string) {
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(result.outputs).toEqual({});
}

describe.skipIf(process.platform === "win32")("immutable release artifact CLI", () => {
  it.each([
    "retained",
    "expired payload",
    "deleted archive",
    "expired SDK archive",
    "missing SDK archive",
    "wrong SDK attempt",
    "changed receipt",
    "changed digest",
  ])("resolves original publication artifacts for %s without dispatching producers", (scenario) => {
    const test = publicationReuseFixture(scenario === "changed receipt");
    const payload = test.payloads[0];
    assert(payload, "expected Docker payload fixture");
    if (scenario === "expired payload") {
      payload.expired = true;
    }
    if (scenario === "changed digest") {
      payload.digest = `sha256:${"0".repeat(64)}`;
    }
    if (scenario === "deleted archive") {
      test.api("actions/artifacts/402", { fixtureError: "gh: Not Found (HTTP 404)" });
    }
    if (scenario === "expired SDK archive") {
      test.sdk.expired = true;
    }
    if (scenario === "missing SDK archive") {
      test.api("actions/runs/81/artifacts?name=plugin-sdk-api-release-diff-81-1&per_page=100", {
        total_count: 0,
        artifacts: [],
      });
    }
    if (scenario === "wrong SDK attempt") {
      test.sdk.name = "plugin-sdk-api-release-diff-81-2";
    }
    const result = test.run("reuse", test.env);
    if (scenario === "changed receipt" || scenario === "changed digest") {
      expectRejected(
        result,
        scenario === "changed receipt" ? "npm receipts differ" : "immutable publication tuple",
      );
    } else {
      expect(result.status, result.stderr).toBe(0);
      if (scenario === "retained") {
        assert(result.outputs.prepared_bundle_json);
        assert(result.outputs.qualified_preflight_bundle_json);
        expect(JSON.parse(result.outputs.prepared_bundle_json)).toEqual(test.raw);
        expect(JSON.parse(result.outputs.qualified_preflight_bundle_json)).toEqual(test.qualified);
        expect(result.outputs).toMatchObject({
          publication_artifacts_reused: "true",
          npm_run_id: "81",
          npm_run_attempt: "1",
          prepared_run_id: "91",
          prepared_run_attempt: "1",
          prepared_manifest_sha256: test.docker.preparedManifestSha256,
        });
      } else {
        expect(result.outputs).toEqual({ publication_artifacts_reused: "false" });
      }
    }
  });
  it.each([
    ["exact active parent", {}, true],
    ["another attempt", { run_attempt: 2 }, false],
    ["another workflow", { path: ".github/workflows/ci.yml" }, false],
    ["changed tooling", { head_sha: "c".repeat(40) }, false],
    ["fork source", { head_repository: { full_name: "someone/openclaw" } }, false],
    ["completed parent", { status: "completed", conclusion: "success" }, false],
  ] as const)("admits only its %s", (_name, override, accepted) => {
    const test = fixture();
    test.api(
      "actions/runs/51",
      workflowRun({ id: 51, path: ".github/workflows/full-release-validation.yml", ...override }),
    );
    const result = test.run("admit", { GITHUB_RUN_ID: "81" });
    if (accepted) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs.dispatch_name).toBe(`${DISPATCH_ID}-dispatch`);
      expect(
        JSON.parse(readFileSync(join(result.outputs.directory!, "dispatch.json"), "utf8")),
      ).toEqual({
        request: artifactRequest(),
        runId: "81",
        runAttempt: "1",
      });
    } else {
      expectRejected(result, "exact active FRV parent and frozen tooling");
    }
  });

  it("restores the original producer on attempt two without dispatching or rebuilding", () => {
    const test = fixture();
    const admitted = test.run("admit", { GITHUB_RUN_ID: "81" });
    expect(admitted.status, admitted.stderr).toBe(0);
    const recordPath = join(admitted.outputs.directory!, "dispatch.json");
    const recordBytes = readFileSync(recordPath, "utf8");
    test.artifact(admitted.outputs.dispatch_name!, "dispatch.json", JSON.parse(recordBytes), true);
    const first = test.run("resolve");
    expect(first.status, first.stderr).toBe(0);
    expect(first.outputs).toMatchObject({
      run_id: "81",
      run_attempt: "1",
      dispatch_id: DISPATCH_ID,
    });
    const second = test.run("resolve", {
      GITHUB_RUN_ATTEMPT: "2",
      ARTIFACT_RUN_ID: "99",
      ARTIFACT_RUN_ATTEMPT: "2",
    });
    expect(second.status, second.stderr).toBe(0);
    expect(second.outputs).toEqual(first.outputs);
    expect(readFileSync(recordPath, "utf8")).toBe(recordBytes);
    expect(second.calls).toContainEqual([
      "gh",
      "api",
      `repos/${REPOSITORY}/actions/artifacts?name=${DISPATCH_ID}-dispatch&per_page=100`,
    ]);
    expect(
      second.calls.some((call) => call.some((part) => part.includes("actions/runs/51/"))),
    ).toBe(false);
    expect(
      [...first.calls, ...second.calls]
        .filter(([kind]) => kind === "gh")
        .every(([, command]) => command === "api"),
    ).toBe(true);
  });

  it("adopts a newer producer attempt without replacing its original dispatch", () => {
    const test = fixture();
    test.artifact(
      `${DISPATCH_ID}-dispatch`,
      "dispatch.json",
      {
        request: artifactRequest(),
        runId: "81",
        runAttempt: "1",
      },
      true,
    );
    test.api(
      "actions/runs/81",
      workflowRun({ run_attempt: 2, status: "completed", conclusion: "success" }),
    );
    const result = test.run("resolve", { GITHUB_RUN_ATTEMPT: "2" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs).toMatchObject({
      run_id: "81",
      run_attempt: "2",
      dispatch_id: DISPATCH_ID,
    });
  });

  it.each(["contents retry", "receipt retry", "replacement preparation failed"] as const)(
    "collects failed-job recovery with carried-forward npm bytes: %s",
    (outcome) => {
      const test = fixture();
      const current = workflowRun({ run_attempt: 2, status: "completed", conclusion: "success" });
      test.api("actions/runs/81", current);
      test.api(
        "actions/runs/81/attempts/1",
        workflowRun({ status: "completed", conclusion: "failure" }),
      );
      test.api("actions/runs/81/attempts/2", current);
      if (outcome === "contents retry") {
        test.qualified.producer.runAttempt = "2";
        test.qualified.artifact.runAttempt = "2";
        test.jobs[1]!.run_attempt = 2;
        test.outputs.qualified_preflight_bundle_json = JSON.stringify(test.qualified);
      }
      test.api("actions/runs/81/attempts/1/jobs?per_page=100&page=1", {
        total_count: outcome === "contents retry" ? 1 : 2,
        jobs: outcome === "contents retry" ? [test.jobs[0]] : test.jobs,
      });
      test.api("actions/runs/81/attempts/2/jobs?per_page=100&page=1", {
        total_count: 1,
        jobs:
          outcome === "receipt retry"
            ? [{ ...test.jobs[0], id: 990, name: "Seal artifact producer receipt", run_attempt: 2 }]
            : outcome === "contents retry"
              ? [test.jobs[1]]
              : [{ ...test.jobs[0], id: 999, run_attempt: 2, conclusion: "failure" }],
      });
      test.artifact("openclaw-npm-package-descriptor-81-1", "prepared-npm-bundle.json", test.raw);
      const raw = test.run("wait", { ARTIFACT_OUTPUT: "raw", ARTIFACT_RUN_ATTEMPT: "2" });
      if (outcome === "replacement preparation failed") {
        expectRejected(raw, "Successful npm preparation was replaced");
        return;
      }
      expect(raw.status, raw.stderr).toBe(0);
      expect(JSON.parse(raw.outputs.prepared_bundle_json!)).toEqual(test.raw);
      const sealed = test.run("receipt", {
        GITHUB_RUN_ID: "81",
        GITHUB_RUN_ATTEMPT: "2",
        ARTIFACT_OUTPUTS_JSON: JSON.stringify(test.outputs),
      });
      expect(sealed.status, sealed.stderr).toBe(0);
      test.artifact(
        "full-release-artifact-receipt-81-2",
        "artifact-receipt.json",
        JSON.parse(readFileSync(join(sealed.outputs.directory!, "artifact-receipt.json"), "utf8")),
      );
      const receipt = test.run("wait", { ARTIFACT_OUTPUT: "receipt", ARTIFACT_RUN_ATTEMPT: "2" });
      expect(receipt.status, receipt.stderr).toBe(0);
      expect(receipt.outputs).toEqual(test.outputs);
    },
  );

  it.each([
    "missing record",
    "changed request",
    "record names another producer",
    "producer attempt regressed",
    "missing producer",
  ] as const)("refuses retry reuse with %s", (failure) => {
    const test = fixture();
    const record = { request: artifactRequest(), runId: "81", runAttempt: "1" };
    if (failure === "changed request") {
      record.request.sourceSha = "c".repeat(40);
    }
    if (failure === "record names another producer") {
      record.runId = "83";
      test.api("actions/runs/83", workflowRun({ id: 83 }));
    }
    if (failure === "missing record") {
      test.api(`actions/artifacts?name=${DISPATCH_ID}-dispatch&per_page=100`, {
        total_count: 0,
        artifacts: [],
      });
    } else {
      test.artifact(`${DISPATCH_ID}-dispatch`, "dispatch.json", record, true);
    }
    if (failure === "producer attempt regressed") {
      record.runAttempt = "2";
      test.artifact(`${DISPATCH_ID}-dispatch`, "dispatch.json", record, true);
      test.api("actions/runs/81", workflowRun({ run_attempt: 1 }));
    }
    if (failure === "missing producer") {
      test.api("actions/runs/81", { fixtureError: "HTTP 404: producer missing" });
    }
    const result = test.run("resolve", { GITHUB_RUN_ATTEMPT: "2", ARTIFACT_RUN_ID: "99" });
    const message =
      failure === "producer attempt regressed"
        ? "producer run identity changed"
        : failure === "missing producer"
          ? "HTTP 404: producer missing"
          : "Original artifact dispatch is unavailable or changed";
    expectRejected(result, message);
  });

  it.each([
    ["raw", "Prepare npm artifacts / Prepare publishable npm package"],
    ["receipt", "Prepare npm artifacts / Check npm dependencies"],
  ] as const)("reports a failed %s producer job before its siblings finish", (output, name) => {
    const test = fixture();
    test.api("actions/runs/81/attempts/1/jobs?per_page=100&page=1", {
      total_count: 2,
      jobs: [
        { ...test.jobs[0], name, conclusion: "failure" },
        { ...test.jobs[1], status: "in_progress", conclusion: null },
      ],
    });
    test.api("actions/runs/81/artifacts?name=openclaw-npm-package-descriptor-81-1&per_page=100", {
      total_count: 0,
      artifacts: [],
    });
    const result = test.run("wait", {
      ARTIFACT_OUTPUT: output,
      FIXTURE_STOP_ON_WAIT: "true",
    });
    expectRejected(result, `${name} ended with failure`);
    expect(result.stderr).toContain(`https://github.com/${REPOSITORY}/actions/runs/81/job/901`);
    expect(result.stderr).toContain("Other producer jobs continue running");
  });

  it("keeps waiting while a queued producer has no jobs", () => {
    const test = fixture();
    test.api("actions/runs/81", workflowRun({ status: "queued" }));
    test.api("actions/runs/81/attempts/1/jobs?per_page=100&page=1", {
      total_count: 0,
      jobs: [],
    });
    const result = test.run("wait", {
      ARTIFACT_OUTPUT: "receipt",
      FIXTURE_STOP_ON_WAIT: "true",
    });
    expectRejected(result, "Fixture reached another artifact poll");
  });

  it.each([
    "successful raw job",
    "failed unrelated qualifier",
    "failed raw job",
    "wrong raw attempt",
    "rerun during download",
  ] as const)(
    "requires an exact completed raw job while qualification is still active: %s",
    (outcome) => {
      const test = fixture();
      test.jobs[1]!.status = "in_progress";
      test.jobs[1]!.conclusion = null;
      if (outcome === "failed raw job") {
        test.jobs[0]!.conclusion = "failure";
      }
      if (outcome === "failed unrelated qualifier") {
        test.jobs[1]!.status = "completed";
        test.jobs[1]!.conclusion = "failure";
      }
      if (outcome === "wrong raw attempt") {
        test.jobs[0]!.run_attempt = 2;
      }
      test.artifact("openclaw-npm-package-descriptor-81-1", "prepared-npm-bundle.json", test.raw);
      const result = test.run("wait", {
        ARTIFACT_OUTPUT: "raw",
        FIXTURE_RERUN_DURING_DOWNLOAD: String(outcome === "rerun during download"),
      });
      if (outcome === "successful raw job" || outcome === "failed unrelated qualifier") {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.outputs.prepared_bundle_json!)).toEqual(test.raw);
        expect(result.outputs.qualified_preflight_bundle_json).toBeUndefined();
      } else {
        expectRejected(
          result,
          outcome === "rerun during download"
            ? "Artifact producer run identity changed"
            : "unique exact completed producer job",
        );
      }
    },
  );

  it.each([
    "valid",
    "source changed",
    "tooling changed",
    "attempt changed",
    "qualifier failed",
    "rerun during download",
  ] as const)("authenticates the terminal qualification receipt: %s", (outcome) => {
    const test = fixture();
    test.api("actions/runs/81", workflowRun({ status: "completed", conclusion: "success" }));
    test.api(
      "actions/runs/81/attempts/1",
      workflowRun({ status: "completed", conclusion: "success" }),
    );
    const sealed = test.run("receipt", {
      GITHUB_RUN_ID: "81",
      ARTIFACT_OUTPUTS_JSON: JSON.stringify(test.outputs),
    });
    expect(sealed.status, sealed.stderr).toBe(0);
    const receipt = JSON.parse(
      readFileSync(join(sealed.outputs.directory!, "artifact-receipt.json"), "utf8"),
    );
    if (outcome === "source changed") {
      receipt.sourceSha = "c".repeat(40);
    }
    if (outcome === "tooling changed") {
      receipt.toolingSha = "c".repeat(40);
    }
    if (outcome === "attempt changed") {
      receipt.runAttempt = "2";
    }
    if (outcome === "qualifier failed") {
      test.jobs[1]!.conclusion = "failure";
    }
    test.artifact("full-release-artifact-receipt-81-1", "artifact-receipt.json", receipt);
    const result = test.run("wait", {
      ARTIFACT_OUTPUT: "receipt",
      FIXTURE_RERUN_DURING_DOWNLOAD: String(outcome === "rerun during download"),
    });
    if (outcome === "valid") {
      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs).toEqual(test.outputs);
    } else {
      expectRejected(
        result,
        outcome === "rerun during download"
          ? "Artifact producer run identity changed"
          : outcome === "qualifier failed"
            ? "unique exact completed producer job"
            : "receipt does not match its exact request and producer attempt",
      );
    }
  });

  it.each(["digest changed", "malformed ZIP", "producer failed"] as const)(
    "never exposes raw artifacts after %s",
    (failure) => {
      const test = fixture();
      const archive = test.artifact(
        "openclaw-npm-package-descriptor-81-1",
        "prepared-npm-bundle.json",
        test.raw,
      );
      if (failure === "producer failed") {
        test.api("actions/runs/81", workflowRun({ status: "completed", conclusion: "failure" }));
      } else {
        const corrupted = Buffer.alloc(archive.bytes.length);
        writeFileSync(archive.archivePath, corrupted);
        if (failure === "malformed ZIP") {
          archive.metadata.digest = `sha256:${sha256(corrupted)}`;
        }
      }
      const result = test.run("wait", { ARTIFACT_OUTPUT: "raw" });
      expectRejected(
        result,
        failure === "producer failed"
          ? "Artifact npm producer failed"
          : failure === "digest changed"
            ? "GitHub Actions artifact download digest"
            : "ZIP",
      );
      if (failure === "producer failed") {
        expect(result.calls.some(([kind]) => kind === "fetch")).toBe(false);
      }
    },
  );
});
