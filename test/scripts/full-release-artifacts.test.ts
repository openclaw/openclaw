import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { continueFailed, preflightContinuation } from "../../scripts/frv.mjs";
import { selectPublicationArtifactSource } from "../../scripts/full-release-artifacts.mjs";
import { buildFullReleaseCandidateBinding } from "../../scripts/full-release-candidate-contract.mjs";
import {
  buildReleaseExecutionPlanArtifact,
  validateReleaseExecutionPlanArtifact,
  releaseExecutionPlanSha256,
  releaseChildSpec,
} from "../../scripts/full-release-validation-policy.mjs";
import { validateFullReleaseNpmPreflight } from "../../scripts/npm-preflight-tooling-identity.mjs";
import {
  validateParentManifest,
  validateReleaseRunEvidence,
} from "../../scripts/release-ci-summary.mjs";
import { authenticateCandidateOwnedArtifact } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { fullReleaseCandidateManifestFixture } from "../helpers/full-release-candidate.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const SCRIPT = resolve("scripts/full-release-artifacts.mjs");
const REPOSITORY = "openclaw/openclaw";
const WORKFLOW = ".github/workflows/full-release-artifacts.yml";
const SOURCE_SHA = "a".repeat(40);
const TOOLING_SHA = "b".repeat(40);
const DISPATCH_ID = "full-release-validation-51-1-artifacts-npm";
const RECEIPT_MISMATCH = "receipt does not match its exact request and producer attempt";
const JOB_MISMATCH = "unique exact completed producer job";
const RUN_MISMATCH = "Artifact producer run identity changed";
const DISPATCH_MISMATCH = "Original artifact dispatch is unavailable or changed";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const readLines = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
const completed = { status: "completed", conclusion: "success" };
const dispatchRecord = () => ({ request: artifactRequest(), runId: "81", runAttempt: "1" });
const bundleOutputs = (raw: unknown, qualified: unknown) => ({
  prepared_bundle_json: JSON.stringify(raw),
  qualified_preflight_bundle_json: JSON.stringify(qualified),
});
function artifactMetadata(id: number, name: string, digest: string, runId = 81, size = 256) {
  return {
    id,
    name,
    digest,
    size_in_bytes: size,
    expired: false,
    workflow_run: { id: runId, head_sha: TOOLING_SHA },
  };
}

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

function npmBundles(sourceSha: string, workflowRef: string) {
  const producer = {
    repository: REPOSITORY,
    workflowRef: `${REPOSITORY}/${WORKFLOW}@refs/heads/${workflowRef}`,
    workflowSha: TOOLING_SHA,
    runId: "81",
    runAttempt: "1",
    jobId: "901",
    jobName: "Prepare npm artifacts / Prepare publishable npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const raw = {
    schema: "openclaw.prepared-npm-bundle/v1",
    source: { sha: sourceSha },
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
      sourceSha,
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
    artifact: { ...raw.artifact, id: "402", name: `openclaw-npm-preflight-${sourceSha}` },
    preparedBundle: raw,
    manifestSha256: "f".repeat(64),
  };
  const outputs = bundleOutputs(raw, qualified);
  const jobs = [raw, qualified].map(({ producer: owner }) => ({
    id: Number(owner.jobId),
    name: owner.jobName,
    run_id: 81,
    run_attempt: 1,
    head_sha: TOOLING_SHA,
    status: "completed",
    conclusion: "success" as string | null,
    started_at: "2026-08-01T00:00:00Z",
    completed_at: "2026-08-01T00:10:00Z",
  }));
  return { raw, qualified, outputs, jobs };
}

function fixture(sourceSha = SOURCE_SHA, workflowRef = "main") {
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
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "api" || args.includes("POST")) throw new Error("Unexpected GitHub mutation");
const fixture = JSON.parse(readFileSync(process.env.FIXTURE_RESPONSES, "utf8"));
const { responses, calls } = fixture;
if (!Object.hasOwn(responses, args[1])) throw new Error("Unexpected GitHub endpoint: " + args[1]);
const response = responses[args[1]];
calls[args[1]] = (calls[args[1]] ?? 0) + 1;
const failure = calls[args[1]] >= (response.fixtureErrorOnRead ?? 1)
  ? response.fixtureErrorOnce ?? response.fixtureError : undefined;
delete response.fixtureErrorOnce;
writeFileSync(process.env.FIXTURE_RESPONSES, JSON.stringify(fixture));
if (failure) { process.stderr.write(failure); process.exit(1); }
process.stdout.write(response.fixtureOutput ?? JSON.stringify(response));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    preloadPath,
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const { responses, downloads } = JSON.parse(readFileSync(process.env.FIXTURE_RESPONSES, "utf8"));
if (process.env.FIXTURE_STOP_ON_WAIT === "true") {
  globalThis.setTimeout = () => { throw new Error("Fixture reached another artifact poll"); };
} else if (process.env.FIXTURE_ADVANCE_RETRY_CLOCK === "true") {
  let now = Date.now();
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay) => { now += delay; queueMicrotask(callback); };
}
const timeoutMs = new WeakMap();
const originalTimeout = AbortSignal.timeout;
AbortSignal.timeout = (ms) => {
  const signal = originalTimeout(ms);
  timeoutMs.set(signal, ms);
  return signal;
};
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.github.com") throw new Error("Unexpected fetch origin");
  const endpoint = url.pathname.slice(1) + url.search;
  appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(["fetch", endpoint, String(timeoutMs.get(init?.signal))]) + "\\n");
  const statuses = responses[endpoint]?.fixtureHttpStatuses;
  const status = statuses?.shift();
  if (status && status !== 200) {
    if (process.env.FIXTURE_EXPIRE_ON_HTTP_ERROR === "true") {
      const expired = Date.now() + 350 * 60_000 + 1;
      Date.now = () => expired;
    }
    return new Response("fixture unavailable", { status });
  }
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
  const list = (path: string, key: string, values: unknown[]) =>
    api(path, { total_count: values.length, [key]: values });
  const runApi = (path: string, overrides: Record<string, unknown>) =>
    api(`actions/runs/${path}`, workflowRun(overrides));
  const jobsApi = (attempt: number, jobs: unknown[]) =>
    list(`actions/runs/81/attempts/${attempt}/jobs?per_page=100&page=1`, "jobs", jobs);
  const run = (
    command: string,
    env: NodeJS.ProcessEnv = {},
    script = SCRIPT,
    { preloadFetch = true, executable = process.execPath } = {},
  ) => {
    const directory = join(root, `invocation-${++invocation}`);
    mkdirSync(directory);
    const outputPath = join(directory, "github-output");
    const callsPath = join(directory, "calls.jsonl");
    writeFileSync(responsesPath, JSON.stringify({ responses, downloads, calls: {} }));
    const result = spawnSync(
      executable,
      [...(preloadFetch ? ["--import", pathToFileURL(preloadPath).href] : []), script, command],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          ARTIFACT_STAGE: "npm",
          ARTIFACT_DISPATCH_ID: DISPATCH_ID,
          TARGET_SHA: sourceSha,
          PARENT_WORKFLOW_SHA: TOOLING_SHA,
          CHILD_WORKFLOW_REF: workflowRef,
          RELEASE_TAG: "v2026.8.1",
          PREFLIGHT_PHASE: "all",
          GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_SHA: TOOLING_SHA,
          GITHUB_REF_NAME: workflowRef,
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
    const outputs = Object.fromEntries(
      readLines(outputPath).map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    const calls = readLines(callsPath).map((line) => JSON.parse(line) as string[]);
    const apiCalls = readJson(responsesPath).calls as Record<string, number>;
    return { ...result, outputs, calls, apiCalls };
  };
  const artifactFiles = (
    name: string,
    files: Record<string, string | Buffer>,
    repositoryListing = false,
    runId = 81,
    id = ++artifactId,
  ) => {
    const bytes = makeStoredZip(files);
    const archivePath = join(root, `artifact-${id}.zip`);
    writeFileSync(archivePath, bytes);
    const metadata = {
      ...artifactMetadata(id, name, `sha256:${sha256(bytes)}`, runId, bytes.length),
      expires_at: "2030-01-01T00:00:00Z",
    };
    list(
      `${repositoryListing ? "actions" : `actions/runs/${runId}`}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
      "artifacts",
      [metadata],
    );
    api(`actions/artifacts/${id}`, metadata);
    downloads[`repos/${REPOSITORY}/actions/artifacts/${id}/zip`] = archivePath;
    return { bytes, archivePath, metadata };
  };
  const artifact = (
    name: string,
    fileName: string,
    value: unknown,
    repositoryListing = false,
    runId = 81,
  ) => artifactFiles(name, { [fileName]: JSON.stringify(value) }, repositoryListing, runId);
  const npm = npmBundles(sourceSha, workflowRef);
  runApi("51", { id: 51, path: ".github/workflows/full-release-validation.yml" });
  runApi("81", {});
  runApi("81/attempts/1", {});
  jobsApi(1, npm.jobs);
  for (const job of npm.jobs) {
    api(`actions/jobs/${job.id}`, job);
  }
  const rawArtifact = () =>
    artifact("openclaw-npm-package-descriptor-81-1", "prepared-npm-bundle.json", npm.raw);
  const wait = (output: string, env: NodeJS.ProcessEnv = {}) =>
    run("wait", { ARTIFACT_OUTPUT: output, ...env });
  const collect = (output: string, env: NodeJS.ProcessEnv = {}, error = "") => {
    const result = wait(output, env);
    if (error) {
      expectRejected(result, error);
    } else {
      expectSuccess(result);
    }
    return result.outputs;
  };
  const seal = (attempt = "1") => {
    const result = expectSuccess(
      run("receipt", {
        GITHUB_RUN_ID: "81",
        GITHUB_RUN_ATTEMPT: attempt,
        ARTIFACT_OUTPUTS_JSON: JSON.stringify(npm.outputs),
      }),
    );
    return readJson(join(result.outputs.directory!, "artifact-receipt.json"));
  };
  const receiptArtifact = (value: unknown, attempt = "1") =>
    artifact(`full-release-artifact-receipt-81-${attempt}`, "artifact-receipt.json", value);
  return {
    root,
    api,
    list,
    runApi,
    jobsApi,
    run,
    wait,
    collect,
    artifact,
    artifactFiles,
    rawArtifact,
    seal,
    receiptArtifact,
    ...npm,
  };
}

function publicationReuseFixture(
  changedReceipt = false,
  withPayloads = false,
  wrongQualifiedPackage = false,
) {
  const workflowRef = `release-ci/${TOOLING_SHA.slice(0, 12)}-123`;
  const test = fixture(SOURCE_SHA, workflowRef);
  const currentRef = `release-ci/${TOOLING_SHA.slice(0, 12)}-456`;
  const fullRef = `refs/heads/${workflowRef}`;
  const npmRun = {
    ...completed,
    head_branch: workflowRef,
    path: `${WORKFLOW}@${fullRef}`,
  };
  test.runApi("81", npmRun);
  test.runApi("81/attempts/1", npmRun);
  const packageBytes = Buffer.from("retained original npm package");
  test.raw.package.sha256 = sha256(packageBytes);
  const packageManifest = JSON.stringify({
    schema: "openclaw.npm-package-bundle/v1",
    packageName: test.raw.package.name,
    packageVersion: test.raw.package.version,
    releaseSha: SOURCE_SHA,
    tarballName: test.raw.package.fileName,
    tarballSha256: test.raw.package.sha256,
    producer: test.raw.producer,
    corePackageTarballs: [],
    dependencyTarballs: [],
  });
  test.raw.manifestSha256 = sha256(Buffer.from(packageManifest));
  const rawArchive = test.artifactFiles(
    test.raw.artifact.name,
    { "package-bundle.json": packageManifest, [test.raw.package.fileName]: packageBytes },
    false,
    81,
    401,
  );
  test.raw.artifact.digest = rawArchive.metadata.digest.slice("sha256:".length);
  const qualifiedManifest = JSON.stringify({ sourceSha: SOURCE_SHA });
  test.qualified.manifestSha256 = sha256(Buffer.from(qualifiedManifest));
  const qualifiedArchive = test.artifactFiles(
    test.qualified.artifact.name,
    {
      "preflight-manifest.json": qualifiedManifest,
      [test.raw.package.fileName]: wrongQualifiedPackage
        ? Buffer.from("changed package")
        : packageBytes,
    },
    false,
    81,
    402,
  );
  test.qualified.artifact.digest = qualifiedArchive.metadata.digest.slice("sha256:".length);
  const receipt = (stage: string, runId: string, outputs: Record<string, string>) => ({
    schema: "openclaw.full-release-artifact-receipt/v1",
    ...artifactRequest(),
    sourceSha: SOURCE_SHA,
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
    receipt("npm", "81", bundleOutputs(test.raw, qualifiedReceipt)),
  );
  const artifactName = `docker-release-${SOURCE_SHA}-1`;
  const dockerManifest = {
    schemaVersion: 1,
    repository: REPOSITORY,
    sourceSha: SOURCE_SHA,
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
  const architectureArchives = dockerManifest.architectures.map((entry, index) => {
    const archive = test.artifactFiles(
      entry.artifact.name,
      { "image.tar": `image-${entry.architecture}` },
      false,
      91,
      601 + index,
    );
    entry.artifact.digest = archive.metadata.digest;
    return archive;
  });
  const docker = {
    preparedRunId: "91",
    preparedRunAttempt: "1",
    preparedArtifactName: artifactName,
    preparedManifestSha256: sha256(Buffer.from(JSON.stringify(dockerManifest))),
  };
  const dockerRun = {
    id: 91,
    ...completed,
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
  };
  test.runApi("91", dockerRun);
  test.runApi("91/attempts/1", dockerRun);
  test.api("actions/jobs/903", {
    id: 903,
    name: dockerManifest.producer.jobName,
    run_id: 91,
    run_attempt: 1,
    head_sha: TOOLING_SHA,
    ...completed,
  });
  const payloads = architectureArchives.map(({ metadata }) => metadata);
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
  const dockerArchive = test.artifact(artifactName, "manifest.json", dockerManifest, false, 91);
  const sdkArchive = test.artifact(
    "plugin-sdk-api-release-diff-81-1",
    "plugin-sdk-api-release-evidence.json",
    {},
  );
  const sdk = sdkArchive.metadata;
  const pluginArchive = withPayloads
    ? test.artifactFiles(
        `plugin-npm-prepared-${SOURCE_SHA}-1001-1`,
        { "prepared.json": "{}" },
        false,
        1001,
      )
    : null;
  const plugin = pluginArchive
    ? {
        repository: REPOSITORY,
        workflowPath: ".github/workflows/plugin-npm-release.yml",
        workflowSha: TOOLING_SHA,
        workflowHeadBranch: workflowRef,
        workflowEvent: "workflow_dispatch",
        runId: 1001,
        runAttempt: 1,
        artifactId: pluginArchive.metadata.id,
        artifactName: pluginArchive.metadata.name,
        artifactDigest: pluginArchive.metadata.digest,
        artifactSizeBytes: pluginArchive.metadata.size_in_bytes,
      }
    : null;
  if (plugin) {
    for (const suffix of ["1001", "1001/attempts/1"]) {
      test.runApi(suffix, {
        id: 1001,
        ...completed,
        head_branch: workflowRef,
        path: plugin.workflowPath,
      });
    }
  }
  const evidence = {
    schema: "openclaw.release-validation-evidence/v4",
    valid: true,
    directRoot: true,
    current: { conclusion: "success" },
    root: { runId: "51", targetSha: SOURCE_SHA },
    manifest: {
      workflowName: "Full Release Validation",
      runId: "51",
      runAttempt: "1",
      sourceParentRunAttempt: 1,
      workflowSha: TOOLING_SHA,
      targetSha: SOURCE_SHA,
      workflowRef,
      workflowFullRef: fullRef,
      publicationArtifacts: { npmPreflight: test.qualified, docker, pluginNpm: plugin },
    },
  };
  const validator = join(test.root, "validate-evidence.mjs");
  writeFileSync(
    validator,
    `
import assert from "node:assert/strict";
const value = (key) => process.argv[process.argv.indexOf(key) + 1];
const qualification = JSON.parse(value("--qualification-reuse-json"));
assert.equal(qualification.candidateSha, "${SOURCE_SHA}");
assert.equal(qualification.workflowRef, "${currentRef}");
assert.equal(value("--verifier-source-sha"), "${"f".repeat(40)}");
process.stdout.write(${JSON.stringify(JSON.stringify(evidence))});
`,
  );
  return {
    ...test,
    publicationArtifacts: evidence.manifest.publicationArtifacts,
    docker,
    sdk,
    payloads,
    archives: [
      rawArchive,
      qualifiedArchive,
      sdkArchive,
      dockerArchive,
      ...architectureArchives,
      ...(pluginArchive ? [pluginArchive] : []),
    ],
    verifyRetained: (
      options: Record<string, unknown>,
      root = evidence.manifest,
      env: NodeJS.ProcessEnv = {},
    ) => {
      const entrypoint = join(test.root, "verify-retained.mjs");
      writeFileSync(
        entrypoint,
        `
import { verifyRetainedPublicationArtifacts } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
const result = await verifyRetainedPublicationArtifacts(${JSON.stringify(root)}, process.env, ${JSON.stringify(options)});
console.log(JSON.stringify(result));
`,
      );
      return test.run(
        "verify",
        {
          // Recovery tooling can differ; original identities come only from root.
          PARENT_WORKFLOW_SHA: "f".repeat(40),
          PLUGIN_NPM_REQUIRED: withPayloads ? "true" : "false",
          ...env,
        },
        entrypoint,
      );
    },
    expectedPackage: { fileName: test.raw.package.fileName, sha256: test.raw.package.sha256 },
    env: {
      EVIDENCE_REUSE: "true",
      EVIDENCE_POLICY: "exact-target-full-validation-v1",
      EVIDENCE_SHA: SOURCE_SHA,
      EVIDENCE_ROOT_RUN_ID: "51",
      TARGET_SHA: SOURCE_SHA,
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

type Result = ReturnType<ReturnType<typeof fixture>["run"]>;
function expectSuccess(result: Result) {
  expect(result.status, result.stderr).toBe(0);
  return result;
}
function expectRejected(result: Result, message: string) {
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(result.outputs).toEqual({});
}

describe.skipIf(process.platform === "win32")("immutable release artifact CLI", () => {
  it.each([
    { label: "brief visibility lag", output: "raw", statuses: [404, 200], reads: 2, ok: true },
    {
      label: "persistent missing metadata",
      output: "raw",
      statuses: [404, 404, 404, 200],
      reads: 3,
    },
    { label: "missing archive", output: "raw", statuses: [404, 200], reads: 1, archive: true },
    { label: "unauthorized metadata", output: "raw", statuses: [401, 200], reads: 1 },
    { label: "forbidden metadata", output: "raw", statuses: [403, 200], reads: 1 },
    { label: "missing sealed receipt", output: "receipt", statuses: [404, 200], reads: 1 },
    {
      label: "changed immutable ID",
      output: "raw",
      statuses: [404, 200],
      reads: 2,
      changedId: true,
    },
    {
      label: "expired acquisition deadline",
      output: "raw",
      statuses: [404, 200],
      reads: 1,
      expire: true,
    },
  ])("bounds fresh artifact metadata recovery: $label", (scenario) => {
    const test = fixture();
    if (scenario.output === "receipt") {
      test.api("actions/runs/81", workflowRun({ status: "completed", conclusion: "success" }));
      test.api(
        "actions/runs/81/attempts/1",
        workflowRun({ status: "completed", conclusion: "success" }),
      );
    }
    const archive = test.artifact(
      scenario.output === "raw"
        ? "openclaw-npm-package-descriptor-81-1"
        : "full-release-artifact-receipt-81-1",
      scenario.output === "raw" ? "prepared-npm-bundle.json" : "artifact-receipt.json",
      test.raw,
    );
    const endpoint = "actions/artifacts/" + archive.metadata.id + (scenario.archive ? "/zip" : "");
    test.api(endpoint, {
      ...archive.metadata,
      ...(scenario.changedId ? { id: archive.metadata.id + 1 } : {}),
      fixtureHttpStatuses: scenario.statuses,
    });
    const result = test.run("wait", {
      ARTIFACT_OUTPUT: scenario.output,
      FIXTURE_ADVANCE_RETRY_CLOCK: "true",
      FIXTURE_EXPIRE_ON_HTTP_ERROR: String(scenario.expire === true),
    });
    if (scenario.ok) {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.outputs.prepared_bundle_json!)).toEqual(test.raw);
    } else {
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.outputs).toEqual({});
    }
    if (!scenario.ok) {
      expect(result.stderr).toContain(
        scenario.changedId
          ? "metadata does not match"
          : scenario.expire
            ? "deadline exceeded"
            : "HTTP " + scenario.statuses[0],
      );
    }
    expect(
      result.calls.filter(
        ([kind, path]) => kind === "fetch" && path === "repos/" + REPOSITORY + "/" + endpoint,
      ),
    ).toHaveLength(scenario.reads);
    expect(
      Object.entries(result.apiCalls).filter(([path]) => path.includes("/artifacts?name=")),
    ).toHaveLength(1);
  });

  it("authenticates and reuses original payloads without replacing the recovery tooling identity", () => {
    const test = publicationReuseFixture(false, true);
    const result = expectSuccess(
      test.verifyRetained({
        verifyPayloads: true,
        expectedPackage: test.expectedPackage,
        dockerArchiveTimeoutMs: 240_000,
      }),
    );
    const verified = JSON.parse(result.stdout);
    expect(verified.outputs).toMatchObject({
      publication_artifacts_reused: "true",
      npm_run_id: "81",
      prepared_run_id: "91",
    });
    const kinds = [
      "raw-npm",
      "qualified-npm",
      "sdk",
      "docker-manifest",
      "docker-amd64",
      "docker-arm64",
      "plugin-npm",
    ];
    expect(verified.payloads).toHaveLength(test.archives.length);
    for (const [index, { metadata, bytes }] of test.archives.entries()) {
      expect(verified.payloads[index]).toMatchObject({
        kind: kinds[index],
        artifact: { id: String(metadata.id) },
        sha256: sha256(bytes),
        producer: { workflowSha: TOOLING_SHA },
        ...(index < 2 ? { package: test.expectedPackage } : {}),
      });
    }
    const dockerIds = test.archives.slice(4, 6).map(({ metadata }) => metadata.id);
    const requests = result.calls.filter(([kind]) => kind === "fetch");
    expect(requests.filter(([, endpoint]) => endpoint?.endsWith("/zip"))).toHaveLength(9);
    for (const [, endpoint, timeoutMs] of requests) {
      const dockerBody = dockerIds.some((id) => endpoint?.endsWith(`/artifacts/${id}/zip`));
      if (dockerBody) {
        expect(Number(timeoutMs)).toBeGreaterThan(60_000);
        expect(Number(timeoutMs)).toBeLessThanOrEqual(240_000);
      } else {
        expect(timeoutMs).toBe("60000");
      }
    }
    expect(result.outputs).toEqual({});

    const reuseOptions = {
      verifyPayloads: true,
      expectedPackage: test.expectedPackage,
      authenticatedPayloads: verified.payloads,
    };
    const reused = expectSuccess(test.verifyRetained(reuseOptions));
    expect(JSON.parse(reused.stdout)).toEqual(verified);
    const manifestId = test.archives[3]!.metadata.id;
    const reusedDownloads = reused.calls.filter(([, endpoint]) => endpoint?.endsWith("/zip"));
    expect(reusedDownloads).toHaveLength(3);
    expect(reusedDownloads).toEqual(
      result.calls.filter(
        ([, endpoint]) =>
          endpoint?.endsWith("/zip") &&
          !test.archives.some(
            ({ metadata }) =>
              metadata.id !== manifestId && endpoint.endsWith(`/artifacts/${metadata.id}/zip`),
          ),
      ),
    );
    for (const { metadata } of test.archives) {
      expect(
        (reused.apiCalls[`repos/${REPOSITORY}/actions/artifacts/${metadata.id}`] ?? 0) +
          reused.calls.filter(
            ([kind, endpoint]) =>
              kind === "fetch" &&
              endpoint === `repos/${REPOSITORY}/actions/artifacts/${metadata.id}`,
          ).length,
      ).toBeGreaterThan(0);
    }
    for (const authenticatedPayloads of [
      verified.payloads.slice(1),
      [...verified.payloads, verified.payloads[0]],
      verified.payloads.map((payload: { kind: string }) =>
        payload.kind === "raw-npm" ? { ...payload, package: test.raw.package } : payload,
      ),
      verified.payloads.map((payload: { kind: string }) =>
        payload.kind === "docker-manifest"
          ? { ...payload, manifestSha256: "0".repeat(64) }
          : payload,
      ),
    ]) {
      expectRejected(
        test.verifyRetained({ ...reuseOptions, authenticatedPayloads }),
        "differs from the authenticated recovery inventory",
      );
    }
    expectRejected(
      test.verifyRetained({ verifyPayloads: false, authenticatedPayloads: verified.payloads }),
      "Authenticated payload reuse requires payload verification",
    );
    Object.assign(test.archives[0]!.metadata, { expired: true });
    expectRejected(test.verifyRetained(reuseOptions), "Original publication artifact has expired");
  });

  it.each([
    ["raw-npm", 0],
    ["qualified-npm", 1],
    ["sdk", 2],
    ["docker-manifest", 3],
    ["docker-amd64", 4],
    ["docker-arm64", 5],
    ["plugin-npm", 6],
  ] as const)(
    "rejects changed %s archive bytes without a fresh-artifact fallback",
    (_kind, index) => {
      const test = publicationReuseFixture(false, true);
      const archive = test.archives[index]!;
      const changed = Buffer.from(archive.bytes);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      writeFileSync(archive.archivePath, changed);
      const result = test.verifyRetained({
        verifyPayloads: true,
        expectedPackage: test.expectedPackage,
      });
      expectRejected(result, "digest");
      expect(result.stdout).toBe("");
    },
  );

  it("rejects a qualified archive whose authenticated package bytes differ from the expected package", () => {
    const test = publicationReuseFixture(false, true, true);
    expectRejected(
      test.verifyRetained({ verifyPayloads: true, expectedPackage: test.expectedPackage }),
      "Retained qualified npm package digest mismatch",
    );
  });

  it("fails closed when an original payload disappears", () => {
    const test = publicationReuseFixture(false, true);
    test.api("actions/artifacts/402", { fixtureError: "gh: Not Found (HTTP 404)" });
    expectRejected(
      test.verifyRetained({ verifyPayloads: true }),
      "Original publication artifact is unavailable",
    );
  });

  it.each([
    ["retained", {}, {}, "", ""],
    ["expired payload", { expired: true }, {}, "", ""],
    ["deleted archive", {}, {}, "npm", ""],
    ["retained metadata 404", {}, {}, "", ""],
    ["expired SDK archive", {}, { expired: true }, "", ""],
    ["missing SDK archive", {}, {}, "sdk", ""],
    ["wrong SDK attempt", {}, { name: "plugin-sdk-api-release-diff-81-2" }, "", ""],
    ["changed receipt", {}, {}, "", "npm receipts differ"],
    [
      "changed digest",
      { digest: `sha256:${"0".repeat(64)}` },
      {},
      "",
      "immutable publication tuple",
    ],
  ] as const)(
    "reuses publication artifacts without dispatch for %s",
    (scenario, payloadChanges, sdkChanges, missing, error) => {
      const test = publicationReuseFixture(scenario === "changed receipt");
      Object.assign(test.payloads[0]!, payloadChanges);
      Object.assign(test.sdk, sdkChanges);
      if (scenario === "retained metadata 404") {
        test.api("actions/artifacts/501", { fixtureHttpStatuses: [404, 200] });
      }
      if (missing === "npm") {
        test.api("actions/artifacts/402", { fixtureError: "gh: Not Found (HTTP 404)" });
      }
      if (missing === "sdk") {
        test.list(
          "actions/runs/81/artifacts?name=plugin-sdk-api-release-diff-81-1&per_page=100",
          "artifacts",
          [],
        );
      }
      const result = test.run("reuse", test.env);
      if (scenario === "retained metadata 404") {
        expect(
          result.calls.filter(
            ([kind, endpoint]) =>
              kind === "fetch" && endpoint === `repos/${REPOSITORY}/actions/artifacts/501`,
          ),
        ).toHaveLength(1);
        expect(
          result.calls.some(([kind, endpoint]) => kind === "fetch" && endpoint?.endsWith("/zip")),
        ).toBe(false);
      }
      if (error) {
        expectRejected(result, error);
      } else {
        expectSuccess(result);
        if (scenario === "retained") {
          expect(JSON.parse(result.outputs.prepared_bundle_json!)).toEqual(test.raw);
          expect(JSON.parse(result.outputs.qualified_preflight_bundle_json!)).toEqual(
            test.qualified,
          );
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
    },
  );
  it.each([
    ["exact active parent", {}, true],
    ["another attempt", { run_attempt: 2 }, false],
    ["another workflow", { path: ".github/workflows/ci.yml" }, false],
    ["changed tooling", { head_sha: "c".repeat(40) }, false],
    ["fork source", { head_repository: { full_name: "someone/openclaw" } }, false],
    ["completed parent", { status: "completed", conclusion: "success" }, false],
  ] as const)("admits only its %s", (_name, override, accepted) => {
    const test = fixture();
    test.runApi("51", {
      id: 51,
      path: ".github/workflows/full-release-validation.yml",
      ...override,
    });
    const result = test.run("admit", { GITHUB_RUN_ID: "81" });
    if (accepted) {
      expectSuccess(result);
      expect(result.outputs.dispatch_name).toBe(`${DISPATCH_ID}-dispatch`);
      expect(readJson(join(result.outputs.directory!, "dispatch.json"))).toEqual(dispatchRecord());
    } else {
      expectRejected(result, "exact active FRV parent and frozen tooling");
    }
  });

  it.each([
    ["npm", 1],
    ["npm", 2],
    ["docker", 2],
  ] as const)(
    "restores %s producer attempt %i without dispatching or rebuilding",
    (stage, attempt) => {
      const test = fixture();
      const dispatchId = `full-release-validation-51-1-artifacts-${stage}`;
      const env = { ARTIFACT_STAGE: stage, ARTIFACT_DISPATCH_ID: dispatchId };
      const admitted = expectSuccess(test.run("admit", { ...env, GITHUB_RUN_ID: "81" }));
      const recordPath = join(admitted.outputs.directory!, "dispatch.json");
      const recordBytes = readFileSync(recordPath, "utf8");
      test.artifact(
        admitted.outputs.dispatch_name!,
        "dispatch.json",
        JSON.parse(recordBytes),
        true,
      );
      test.runApi("81", { display_title: `Full Release Artifacts ${dispatchId}` });
      const first = expectSuccess(test.run("resolve", env));
      expect(first.outputs).toMatchObject({
        run_id: "81",
        run_attempt: "1",
        dispatch_id: dispatchId,
      });
      if (attempt === 2) {
        test.runApi("81", {
          run_attempt: attempt,
          ...completed,
          display_title: `Full Release Artifacts ${dispatchId}`,
        });
      }
      const second = expectSuccess(
        test.run("resolve", {
          ...env,
          GITHUB_RUN_ATTEMPT: "2",
          ARTIFACT_RUN_ID: "99",
          ARTIFACT_RUN_ATTEMPT: "2",
        }),
      );
      expect(second.outputs).toEqual({ ...first.outputs, run_attempt: String(attempt) });
      expect(readFileSync(recordPath, "utf8")).toBe(recordBytes);
    },
  );

  it.each([
    "contents retry",
    "receipt retry",
    "carried preparation copy",
    "replacement preparation failed",
  ] as const)("collects failed-job recovery with carried-forward npm bytes: %s", (outcome) => {
    const test = fixture();
    const current = { run_attempt: 2, ...completed };
    test.runApi("81", current);
    test.runApi("81/attempts/1", { ...completed, conclusion: "failure" });
    test.runApi("81/attempts/2", current);
    if (outcome === "contents retry") {
      test.qualified.producer.runAttempt = "2";
      test.qualified.artifact.runAttempt = "2";
      test.jobs[1]!.run_attempt = 2;
      test.outputs.qualified_preflight_bundle_json = JSON.stringify(test.qualified);
    }
    test.jobsApi(1, outcome === "contents retry" ? [test.jobs[0]] : test.jobs);
    test.jobsApi(
      2,
      outcome === "receipt retry"
        ? [{ ...test.jobs[0], id: 990, name: "Seal artifact producer receipt", run_attempt: 2 }]
        : outcome === "contents retry"
          ? [test.jobs[1]]
          : outcome === "carried preparation copy"
            ? [{ ...test.jobs[0], id: 998, run_attempt: 2 }]
            : [{ ...test.jobs[0], id: 999, run_attempt: 2, conclusion: "failure" }],
    );
    test.rawArtifact();
    if (outcome === "replacement preparation failed") {
      test.artifact("openclaw-npm-package-descriptor-81-2", "prepared-npm-bundle.json", {
        ...test.raw,
        producer: { ...test.raw.producer, jobId: "999", runAttempt: "2" },
        artifact: {
          ...test.raw.artifact,
          id: "499",
          name: "openclaw-npm-package-81-2",
          runAttempt: "2",
        },
      });
    } else {
      test.list(
        "actions/runs/81/artifacts?name=openclaw-npm-package-descriptor-81-2&per_page=100",
        "artifacts",
        [],
      );
    }
    const raw = test.wait("raw", { ARTIFACT_RUN_ATTEMPT: "2" });
    if (outcome === "replacement preparation failed") {
      expectRejected(raw, "Successful npm preparation was replaced");
      return;
    }
    expectSuccess(raw);
    expect(JSON.parse(raw.outputs.prepared_bundle_json!)).toEqual(test.raw);
    test.receiptArtifact(test.seal("2"), "2");
    const receipt = expectSuccess(test.wait("receipt", { ARTIFACT_RUN_ATTEMPT: "2" }));
    expect(receipt.outputs).toEqual(test.outputs);
  });

  it("keeps polling when the npm descriptor appears before its producer job completes", () => {
    const test = fixture();
    const pending = { ...test.jobs[0], status: "in_progress", conclusion: null };
    test.jobsApi(1, [pending]);
    test.api(`actions/jobs/${pending.id}`, pending);
    test.rawArtifact();

    const raw = test.wait("raw", { FIXTURE_STOP_ON_WAIT: "true" });
    expectRejected(raw, "Fixture reached another artifact poll");
    expect(raw.stderr).not.toContain("unique exact completed producer job");
  });

  it("ignores a failed preparation descriptor when a later retry succeeds", () => {
    const test = fixture();
    const current = { run_attempt: 2, ...completed };
    const failed = { ...test.jobs[0], conclusion: "failure" };
    const succeeded = {
      ...test.jobs[0],
      id: 999,
      run_attempt: 2,
      status: "completed",
      conclusion: "success",
    };
    const retried = {
      ...test.raw,
      producer: {
        ...test.raw.producer,
        jobId: "999",
        runAttempt: "2",
      },
      artifact: {
        ...test.raw.artifact,
        id: "499",
        name: "openclaw-npm-package-81-2",
        runAttempt: "2",
      },
    };
    test.runApi("81", current);
    test.runApi("81/attempts/1", { ...completed, conclusion: "failure" });
    test.runApi("81/attempts/2", current);
    test.jobsApi(1, [failed]);
    test.jobsApi(2, [succeeded]);
    test.api("actions/jobs/901", failed);
    test.api("actions/jobs/999", succeeded);
    test.rawArtifact();
    test.artifact("openclaw-npm-package-descriptor-81-2", "prepared-npm-bundle.json", retried);

    const raw = expectSuccess(test.wait("raw", { ARTIFACT_RUN_ATTEMPT: "2" }));
    expect(JSON.parse(raw.outputs.prepared_bundle_json!)).toEqual(retried);
  });

  it.each([
    ["missing record", {}, true, "", DISPATCH_MISMATCH],
    [
      "changed request",
      { request: { ...artifactRequest(), sourceSha: "c".repeat(40) } },
      false,
      "",
      DISPATCH_MISMATCH,
    ],
    ["record names another producer", { runId: "83" }, false, "", DISPATCH_MISMATCH],
    ["producer attempt regressed", { runAttempt: "2" }, false, "", "producer run identity changed"],
    ["missing producer", {}, false, "HTTP 404: producer missing", "HTTP 404: producer missing"],
  ] as const)("refuses retry reuse with %s", (_name, changes, missing, apiError, error) => {
    const test = fixture();
    const record = { ...dispatchRecord(), ...changes };
    if (record.runId === "83") {
      test.runApi("83", { id: 83 });
    }
    if (missing) {
      test.list(`actions/artifacts?name=${DISPATCH_ID}-dispatch&per_page=100`, "artifacts", []);
    } else {
      test.artifact(`${DISPATCH_ID}-dispatch`, "dispatch.json", record, true);
    }
    if (apiError) {
      test.api("actions/runs/81", { fixtureError: apiError });
    }
    const result = test.run("resolve", { GITHUB_RUN_ATTEMPT: "2", ARTIFACT_RUN_ID: "99" });
    expectRejected(result, error);
  });

  it.each([
    ["raw", "Prepare npm artifacts / Prepare publishable npm package"],
    ["receipt", "Prepare npm artifacts / Check npm dependencies"],
  ] as const)("reports a failed %s producer job before its siblings finish", (output, name) => {
    const test = fixture();
    test.jobsApi(1, [
      { ...test.jobs[0], name, conclusion: "failure" },
      { ...test.jobs[1], status: "in_progress", conclusion: null },
    ]);
    test.list(
      "actions/runs/81/artifacts?name=openclaw-npm-package-descriptor-81-1&per_page=100",
      "artifacts",
      [],
    );
    const result = test.wait(output, { FIXTURE_STOP_ON_WAIT: "true" });
    expectRejected(result, `${name} ended with failure`);
    expect(result.stderr).toContain(`https://github.com/${REPOSITORY}/actions/runs/81/job/901`);
    expect(result.stderr).toContain("Other producer jobs continue running");
  });

  it.each([
    ["valid response", {}, "Fixture reached another artifact poll", 1],
    [
      "one truncated CLI response",
      { fixtureErrorOnce: "unexpected end of JSON input" },
      "Fixture reached another artifact poll",
      2,
    ],
    [
      "persistent truncation",
      { fixtureError: "unexpected end of JSON input" },
      "unexpected end of JSON input",
      2,
    ],
    ["authorization failure", { fixtureError: "gh: Forbidden (HTTP 403)" }, "HTTP 403", 1],
    ["malformed successful response", { fixtureOutput: "{" }, "JSON", 1],
  ] as const)("handles a queued producer's jobs read with %s", (_name, response, error, reads) => {
    const test = fixture();
    const dispatchId = "full-release-validation-51-1-artifacts-docker";
    test.runApi("81", { status: "queued", display_title: `Full Release Artifacts ${dispatchId}` });
    const path = "actions/runs/81/attempts/1/jobs?per_page=100&page=1";
    test.api(path, { total_count: 0, jobs: [], ...response });
    const result = test.wait("receipt", {
      ARTIFACT_STAGE: "docker",
      ARTIFACT_DISPATCH_ID: dispatchId,
      FIXTURE_STOP_ON_WAIT: "true",
    });
    expectRejected(result, error);
    expect(result.apiCalls[`repos/${REPOSITORY}/${path}`]).toBe(reads);
  });

  it.each([false, true])(
    "keeps incomplete live job pages pending without hiding identity changes: %s",
    (changedIdentity) => {
      const test = fixture();
      test.api("actions/runs/81/attempts/1/jobs?per_page=100&page=1", {
        total_count: 2,
        jobs: [{ ...test.jobs[0], ...(changedIdentity ? { head_sha: "c".repeat(40) } : {}) }],
      });
      test.collect(
        "receipt",
        { FIXTURE_STOP_ON_WAIT: "true" },
        changedIdentity
          ? "Artifact producer job identity changed"
          : "Fixture reached another artifact poll",
      );
    },
  );

  it("preserves jobs API diagnostics while authenticating the raw producer", () => {
    const test = fixture();
    test.rawArtifact();
    // The first read authenticates the producer; fail the preservation lookup.
    test.api("actions/runs/81/attempts/1/jobs?per_page=100&page=1", {
      total_count: test.jobs.length,
      jobs: test.jobs,
      fixtureErrorOnRead: 2,
      fixtureError: "gh: Forbidden (HTTP 403): fixture jobs permission denied",
    });
    const result = test.wait("raw");
    expectRejected(result, "HTTP 403");
    expect(result.stderr).toContain("fixture jobs permission denied");
  });

  it.each([
    ["failed unrelated qualifier", {}, { ...completed, conclusion: "failure" }, false, ""],
    ["failed raw job", { conclusion: "failure" }, {}, false, JOB_MISMATCH],
    ["wrong raw attempt", { run_attempt: 2 }, {}, false, JOB_MISMATCH],
    ["rerun during download", {}, {}, true, RUN_MISMATCH],
  ] as const)("requires an exact completed raw job: %s", (_name, raw, qualifier, rerun, error) => {
    const test = fixture();
    Object.assign(test.jobs[0]!, raw);
    Object.assign(test.jobs[1]!, { status: "in_progress", conclusion: null }, qualifier);
    test.rawArtifact();
    const outputs = test.collect("raw", { FIXTURE_RERUN_DURING_DOWNLOAD: String(rerun) }, error);
    if (!error) {
      expect(JSON.parse(outputs.prepared_bundle_json!)).toEqual(test.raw);
      expect(outputs.qualified_preflight_bundle_json).toBeUndefined();
    }
  });

  it.each([
    ["valid", {}, false, false, ""],
    ["source changed", { sourceSha: "c".repeat(40) }, false, false, RECEIPT_MISMATCH],
    ["tooling changed", { toolingSha: "c".repeat(40) }, false, false, RECEIPT_MISMATCH],
    ["attempt changed", { runAttempt: "2" }, false, false, RECEIPT_MISMATCH],
    ["qualifier failed", {}, true, false, JOB_MISMATCH],
    ["rerun during download", {}, false, true, RUN_MISMATCH],
  ] as const)(
    "authenticates the terminal qualification receipt: %s",
    (_name, changes, failed, rerun, error) => {
      const test = fixture();
      test.runApi("81", completed);
      test.runApi("81/attempts/1", completed);
      const receipt = Object.assign(test.seal(), changes);
      if (failed) {
        test.jobs[1]!.conclusion = "failure";
      }
      test.receiptArtifact(receipt);
      const outputs = test.collect(
        "receipt",
        { FIXTURE_RERUN_DURING_DOWNLOAD: String(rerun) },
        error,
      );
      if (!error) {
        expect(outputs).toEqual(test.outputs);
      }
    },
  );

  it("never downloads raw artifacts after the producer failed", () => {
    const test = fixture();
    test.rawArtifact();
    test.runApi("81", { ...completed, conclusion: "failure" });
    const result = test.wait("raw");
    expectRejected(result, "Artifact npm producer failed");
    expect(result.calls).toEqual([]);
  });
});

function selectionFixture(
  options: { packageMismatch?: boolean; tamperedReceipt?: boolean; workloadChanged?: boolean } = {},
) {
  const retained = publicationReuseFixture(false, true);
  const f = candidatePublicationFixture({
    runId: "51",
    candidateSha: SOURCE_SHA,
    qualificationSha: TOOLING_SHA,
    candidateVersion: "2026.8.1",
    releaseProfile: "stable",
  });
  f.parent.conclusion = "failure";
  const current = candidatePublicationFixture({
    runId: "99",
    candidateSha: f.c,
    qualificationSha: "c".repeat(40),
    candidateVersion: "2026.8.1",
    releaseProfile: "stable",
    publicationArtifactSource: { runId: "51", runAttempt: 1 },
  });
  const request = f.plan.candidateRequest;
  if (request?.schema !== "openclaw.full-release-candidate-request/v3") {
    throw new Error("Expected the current candidate request fixture");
  }
  const candidate = fullReleaseCandidateManifestFixture({
    ...request,
    upgradeSurvivorBaseline: request.upgradeBaseline,
    upgradeSurvivorBaselines: request.upgradeSurvivorBaselines.join(" "),
  });
  candidate.package.version = f.plan.targetVersion;
  candidate.package.packageSha256 = retained.raw.package.sha256;
  candidate.sharedImage.packageSha256 = retained.raw.package.sha256;
  for (const part of [
    candidate.package,
    candidate.sharedImage,
    candidate.prepublishPluginRegistry,
  ]) {
    part.artifact.expiresAt = "2099-01-01T00:00:00Z";
  }
  const candidateBytes = makeStoredZip({
    "full-release-candidate.json": JSON.stringify(candidate),
  });
  const candidateBinding = buildFullReleaseCandidateBinding({
    manifest: candidate,
    artifact: {
      id: "104",
      name: "full-release-candidate-v2-" + candidate.requestSha256,
      digest: sha256(candidateBytes),
      expiresAt: "2099-01-01T00:00:00Z",
      runId: "77",
      runAttempt: "1",
    },
  });
  f.plan.candidate = candidateBinding;
  f.plan.sha256 = releaseExecutionPlanSha256(f.plan);
  const qualified = structuredClone(retained.qualified);
  if (options.packageMismatch) {
    qualified.preparedBundle.package.sha256 = "0".repeat(64);
  }
  const archives = new Map<string, Buffer>([["104", candidateBytes]]);
  const artifacts = new Map<string, Array<Record<string, unknown>>>();
  const runs = new Map<string, Record<string, unknown>>();
  const logs = new Map<number, string>();
  const jobs: Array<Record<string, unknown>> = [];
  for (const [stage, id, name] of [
    ["npm", "81", "Prepare release npm artifacts"],
    ["docker", "91", "Prepare release Docker artifacts"],
  ] as const) {
    const run = {
      ...f.parent,
      id: Number(id),
      conclusion: "success",
      path: ".github/workflows/full-release-artifacts.yml",
      display_title: "Full Release Artifacts full-release-validation-51-1-artifacts-" + stage,
    };
    runs.set(id, run);
    const receipt = {
      schema: "openclaw.full-release-artifact-receipt/v1",
      stage,
      sourceSha: options.tamperedReceipt ? "0".repeat(40) : f.c,
      toolingSha: f.q,
      dispatchId: "full-release-validation-51-1-artifacts-" + stage,
      repository: f.repository,
      workflowRef: f.branch,
      releaseTag: "v" + f.plan.targetVersion,
      preflightPhase: "all",
      runId: id,
      runAttempt: "1",
      outputs:
        stage === "npm"
          ? {
              prepared_bundle_json: JSON.stringify(qualified.preparedBundle),
              qualified_preflight_bundle_json: JSON.stringify(qualified),
            }
          : {
              prepared_run_id: id,
              prepared_run_attempt: "1",
              prepared_artifact_name: retained.docker.preparedArtifactName,
              prepared_manifest_sha256: retained.docker.preparedManifestSha256,
            },
    };
    const bytes = makeStoredZip({ "artifact-receipt.json": JSON.stringify(receipt) });
    archives.set(id, bytes);
    artifacts.set(id, [
      {
        id: Number(id),
        name: "full-release-artifact-receipt-" + id + "-1",
        digest: "sha256:" + sha256(bytes),
        size_in_bytes: bytes.length,
        expired: false,
        workflow_run: { id: Number(id), head_sha: f.q },
      },
    ]);
    jobs.push({ id: Number(id), name });
    logs.set(
      Number(id),
      "Dispatched full-release-artifacts.yml: https://github.com/openclaw/openclaw/actions/runs/" +
        id +
        " (attempt 1)",
    );
  }
  const plugin = retained.publicationArtifacts.pluginNpm!;
  const pluginArchive = retained.artifact(
    plugin.artifactName,
    "plugin-npm-prepared.json",
    {
      producer: {
        repository: plugin.repository,
        workflowPath: plugin.workflowPath,
        workflowSha: plugin.workflowSha,
        workflowHeadBranch: plugin.workflowHeadBranch,
        workflowEvent: plugin.workflowEvent,
        runId: plugin.runId,
        runAttempt: plugin.runAttempt,
      },
    },
    false,
    1001,
  );
  archives.set(String(pluginArchive.metadata.id), pluginArchive.bytes);
  artifacts.set("1001", [pluginArchive.metadata]);
  runs.set("1001", {
    ...f.parent,
    id: 1001,
    conclusion: "success",
    path: ".github/workflows/plugin-npm-release.yml",
  });
  jobs.push({ id: 1001, name: "Prepare exact plugin npm artifacts" });
  logs.set(
    1001,
    "Dispatched plugin-npm-release.yml: https://github.com/openclaw/openclaw/actions/runs/1001 (attempt 1)",
  );
  const candidateRun = {
    ...f.parent,
    id: 77,
    conclusion: "success",
    path: ".github/workflows/full-release-validation.yml",
  };
  const constituents = [
    candidateBinding.evidenceArtifact,
    candidate.package.artifact,
    candidate.sharedImage.artifact,
    candidate.prepublishPluginRegistry.artifact,
  ];
  const client = {
    ...f.client,
    readWorkloadIdentity: async (path: string) => {
      if (path.startsWith("compare/")) {
        return {
          status: "ahead",
          merge_base_commit: { sha: f.q },
          files: [
            {
              filename: options.workloadChanged
                ? "src/index.ts"
                : ".github/workflows/full-release-validation.yml",
              status: "modified",
            },
          ],
        };
      }
      const source = Buffer.from("jobs:\n  checks:\n    runs-on: ubuntu-latest\n");
      const blobSha = createHash("sha1")
        .update("blob " + source.length + "\0")
        .update(source)
        .digest("hex");
      const root = path === "git/commits/" + f.q ? "1".repeat(40) : "2".repeat(40);
      if (path.startsWith("git/commits/")) {
        return { sha: path.slice(12), tree: { sha: root } };
      }
      if (path.startsWith("git/blobs/")) {
        return {
          sha: blobSha,
          encoding: "base64",
          content: source.toString("base64"),
          size: source.length,
        };
      }
      const sha = path.slice(10);
      const entry = (name: string, oid: string, type = "tree") => ({
        path: name,
        sha: oid,
        type,
        mode: type === "tree" ? "040000" : "100644",
      });
      const tree =
        sha === "3".repeat(40)
          ? [entry("workflows", "4".repeat(40))]
          : sha === "4".repeat(40)
            ? [entry("openclaw-release-checks.yml", blobSha, "blob")]
            : [entry(".github", "3".repeat(40)), entry("src", sha)];
      return { sha, truncated: false, tree };
    },
    getRun: async (id: string) => runs.get(id) ?? f.client.getRun(id),
    getRunAttempt: (id: string, attempt: number) =>
      id === "77" ? candidateRun : f.client.getRunAttempt(id, attempt),
    getRunAttemptJobs: async (id: string) =>
      id === "77"
        ? [candidate.producer, candidate.publisher].map((job) => ({
            id: Number(job.jobId),
            name: job.jobName,
            status: "completed",
            conclusion: "success",
            head_sha: f.q,
            run_id: 77,
            run_attempt: 1,
          }))
        : [...(await f.client.getRunAttemptJobs(id)), ...jobs],
    getJobLog: async (id: number) => logs.get(id) ?? f.client.getJobLog(id),
    getRunArtifacts: (id: string) => artifacts.get(id) ?? [],
    getArtifact: async (id: string) => {
      const receipt = [...artifacts.values()].flat().find((entry) => String(entry.id) === id);
      if (receipt) {
        return receipt;
      }
      const a = constituents.find((entry) => entry.id === id)!;
      return {
        id: Number(id),
        name: a.name,
        digest: "sha256:" + a.digest,
        expires_at: a.expiresAt,
        expired: false,
        size_in_bytes: candidateBytes.length,
        workflow_run: { id: Number(a.runId), head_sha: f.q },
      };
    },
    downloadArtifactArchive: async ({
      expected,
    }: {
      expected: { artifactId: number; artifactDigest: string };
    }) => {
      const archiveBytes = archives.get(String(expected.artifactId))!;
      if ("sha256:" + sha256(archiveBytes) !== expected.artifactDigest) {
        throw new Error("archive digest mismatch");
      }
      return {
        archiveBytes,
        artifactMetadata: await client.getArtifact(String(expected.artifactId)),
      };
    },
    verifyRetainedPublicationArtifacts: vi.fn(
      async (root: Parameters<typeof retained.verifyRetained>[1], env: NodeJS.ProcessEnv) => {
        const verified = expectSuccess(
          retained.verifyRetained({ verifyPayloads: true }, root, {
            RELEASE_TAG: env.RELEASE_TAG,
          }),
        );
        return JSON.parse(verified.stdout);
      },
    ),
  };
  const env = {
    GITHUB_REPOSITORY: f.repository,
    GITHUB_RUN_ID: "99",
    GITHUB_RUN_ATTEMPT: "1",
    TARGET_SHA: f.c,
    PARENT_WORKFLOW_SHA: current.q,
    SOURCE_ADMISSION_JSON: JSON.stringify(current.source),
    CANDIDATE_REQUEST_JSON: JSON.stringify({ ...candidate.request, toolingSha: current.q }),
    RELEASE_TAG: "v" + candidate.package.version,
  };
  return { f, current, client, env, candidate, archives, artifacts, qualified };
}

async function selectedPublicationFixture() {
  const { f, current, client, env } = selectionFixture();
  const selected = await selectPublicationArtifactSource(
    { runId: "51", runAttempt: 1 },
    env,
    client,
  );
  Object.assign(
    current.plan,
    buildReleaseExecutionPlanArtifact({
      ...current.plan,
      expected: current.plan,
      candidate: selected.candidate,
      publicationArtifactSource: selected.source,
    }),
  );
  Object.assign(current.manifest, {
    candidateBinding: selected.candidate,
    publicationArtifactSource: selected.source,
    publicationArtifacts: selected.publicationArtifacts,
    executionPlanSha256: current.plan.sha256,
  });
  expect(validateReleaseExecutionPlanArtifact(current.plan).candidate).toEqual(selected.candidate);
  const finalClient = {
    ...current.client,
    selectPublicationArtifactSource(
      selection: Parameters<typeof selectPublicationArtifactSource>[0],
      selectionEnv: NodeJS.ProcessEnv,
    ) {
      return selectPublicationArtifactSource(selection, selectionEnv, this);
    },
    readWorkloadIdentity: client.readWorkloadIdentity,
    getArtifact: client.getArtifact,
    getRunArtifacts: client.getRunArtifacts,
    downloadArtifactArchive: client.downloadArtifactArchive,
    verifyRetainedPublicationArtifacts: client.verifyRetainedPublicationArtifacts,
    getRun: (id: string) =>
      ["51", "77", "81", "91", "1001"].includes(id) ? client.getRun(id) : current.client.getRun(id),
    getRunAttempt: (id: string, attempt: number) =>
      ["51", "77", "81", "91", "1001"].includes(id)
        ? client.getRunAttempt(id, attempt)
        : current.client.getRunAttempt(id, attempt),
    getRunAttemptJobs: async (id: string) => {
      if (id === "51") {
        // Preserve the original fixture's job identities for source authentication.
        const jobs = structuredClone(await client.getRunAttemptJobs(id));
        for (const job of jobs) {
          job.id = Number(job.id) + 1e12;
        }
        return jobs;
      }
      return id === "77" ? client.getRunAttemptJobs(id) : current.client.getRunAttemptJobs(id);
    },
    getJobLog: (id: number) =>
      id >= 1e12 ? client.getJobLog(id - 1e12) : current.client.getJobLog(id),
    getWorkflowSource: (sha: string, path?: string) =>
      sha === f.q
        ? f.client.getWorkflowSource(sha, path)
        : current.client.getWorkflowSource(sha, path),
    loadExecutionPlanEvidence: (id: string) =>
      id === "51"
        ? f.client.loadExecutionPlanEvidence()
        : current.client.loadExecutionPlanEvidence(),
    verifyQualificationAdmission: (
      options: Parameters<typeof current.client.verifyQualificationAdmission>[0],
    ) =>
      options.qualificationSha === f.q
        ? f.client.verifyQualificationAdmission(options)
        : current.client.verifyQualificationAdmission(options),
  };
  return { f, current, client, env, selected, finalClient };
}

async function retainedRecoveryFixture(legacy = false) {
  const selectedFixture = await selectedPublicationFixture();
  const { current, finalClient } = selectedFixture;
  if (legacy) {
    const getWorkflowSource = finalClient.getWorkflowSource;
    finalClient.getWorkflowSource = (sha: string, path?: string) =>
      getWorkflowSource(sha, path).replace('  FULL_RELEASE_ARTIFACT_RECOVERY_CONTRACT: "2"\n', "");
  }
  const parentJobs = await current.client.getRunAttemptJobs(current.runId);
  for (const name of [
    "Prepare release npm artifacts",
    "Prepare release Docker artifacts",
    "Prepare exact plugin npm artifacts",
    ...current.plan.children
      .filter((entry) => entry.selected)
      .map((entry) => releaseChildSpec(entry.key).parentJobName),
  ]) {
    if (!parentJobs.some((job) => job.name === name)) {
      parentJobs.push({ ...parentJobs[0]!, id: 20000 + parentJobs.length, name });
    }
  }
  const logs = new Map<number, string>();
  for (const job of parentJobs) {
    const child = current.plan.children.find(
      (entry) => entry.selected && releaseChildSpec(entry.key).parentJobName === job.name,
    );
    logs.set(
      job.id,
      [
        "RERUN_GROUP: all",
        "FAIL_FAST: false",
        `TARGET_SHA: ${current.c}`,
        ...(child
          ? [
              "CI_RELEASE_SCOPE: npm-stable",
              "-f publish_reports=false",
              `Dispatched ${releaseChildSpec(child.key).workflow}: https://github.com/${current.repository}/actions/runs/${child.runId} (attempt 1)`,
            ]
          : ["Retained original artifact descriptor"]),
      ].join("\n"),
    );
  }
  const client = {
    repository: current.repository,
    getReleaseEvidenceClient: () => finalClient,
    getRunAttempt: async (id: string, attempt: number) =>
      id === current.runId
        ? { ...current.parent, display_title: "Full Release Validation" }
        : finalClient.getRunAttempt(id, attempt),
    getParentJobs: async () => parentJobs,
    getJobLog: async (id: number) => logs.get(id)!,
    getRun: finalClient.getRun,
    getAttemptJobs: finalClient.getRunAttemptJobs,
    rerunJob: vi.fn(),
    rerunParent: vi.fn(),
  };
  return { ...selectedFixture, recoveryClient: client, parentJobs, logs };
}

describe("explicit publication artifact selection", () => {
  it("forwards the existing GitHub credential to retained candidate downloads", async () => {
    const { current, recoveryClient, finalClient } = await retainedRecoveryFixture();
    const downloadArchive = finalClient.downloadArtifactArchive;
    let downloads = 0;
    finalClient.downloadArtifactArchive = async (options) => {
      if (!("token" in options) || options.token !== "synthetic-recovery-token") {
        throw new Error("Retained candidate download omitted the existing GitHub credential");
      }
      downloads += 1;
      return downloadArchive(options);
    };
    vi.stubEnv("GH_TOKEN", "synthetic-recovery-token");
    try {
      await preflightContinuation(current.plan, current.runId, recoveryClient);
      expect(downloads).toBeGreaterThan(0);
      expect(JSON.stringify(current.plan)).not.toContain("synthetic-recovery-token");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([false, true])(
    "recovers a retained-original parent without inventing a new npm dispatch (legacy: %s)",
    async (legacy) => {
      const { current, recoveryClient, client } = await retainedRecoveryFixture(legacy);
      client.verifyRetainedPublicationArtifacts.mockClear();
      const before = JSON.stringify(current.plan);
      await expect(
        preflightContinuation(current.plan, current.runId, recoveryClient),
      ).resolves.toMatchObject({
        artifactProducers: [],
        pendingArtifactProducers: false,
      });
      expect(client.verifyRetainedPublicationArtifacts).toHaveBeenCalledOnce();
      expect(JSON.stringify(current.plan)).toBe(before);
      const normalCi = current.plan.children.find((entry) => entry.key === "normalCi")!;
      const [job] = await recoveryClient.getAttemptJobs(normalCi.runId);
      if (typeof job?.name !== "string") {
        throw new Error("Expected the fixture normal CI job name");
      }
      await expect(
        continueFailed(current.plan, current.runId, recoveryClient, {
          job: `normalCi:${job.name}`,
          noFollow: true,
          dryRun: true,
          log: () => {},
        }),
      ).resolves.toMatchObject({ action: "would-rerun" });
      expect(recoveryClient.rerunJob).not.toHaveBeenCalled();
      expect(recoveryClient.rerunParent).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "forged", "ambiguous"])(
    "refuses %s retained-original evidence before retry",
    async (fault) => {
      const { current, recoveryClient, finalClient } = await retainedRecoveryFixture();
      if (fault === "missing") {
        const getRunArtifacts = finalClient.getRunArtifacts;
        finalClient.getRunArtifacts = (id: string) => (id === "81" ? [] : getRunArtifacts(id));
      } else {
        const getJobLog = finalClient.getJobLog;
        finalClient.getJobLog = async (id: number) => {
          const log = await getJobLog(id);
          return id !== 1e12 + 81
            ? log
            : fault === "forged"
              ? log.replace("openclaw/openclaw", "forged/repository")
              : log + "\n" + log;
        };
      }
      await expect(
        continueFailed(current.plan, current.runId, recoveryClient, {
          job: "normalCi:checks-node-compact-large-17 (node)",
          noFollow: true,
          log: () => {},
        }),
      ).rejects.toThrow(
        fault === "forged" ? "original dispatch identity differs" : "missing or ambiguous",
      );
      expect(recoveryClient.rerunJob).not.toHaveBeenCalled();
      expect(recoveryClient.rerunParent).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "runs workflow selection in its provisioned checkout (admitted Q: %s)",
    (admitted) => {
      const test = fixture();
      const steps = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"))
        .jobs.evidence_reuse.steps;
      const install = steps.find(
        (step: { name?: string }) => step.name === "Install qualification verifier dependencies",
      );
      const selection = steps.find((step: { id?: string }) => step.id === "artifacts");
      const source = {
        ...(admitted ? { qualificationAdmission: { workflowSha: "c".repeat(40) } } : {}),
        coverage: {
          publication_artifact_source_json: JSON.stringify({ runId: "51", runAttempt: 1 }),
        },
      };
      const context = {
        needs: {
          resolve_target: {
            result: "success",
            outputs: { source_admission_json: JSON.stringify(source) },
          },
        },
        github: { workspace: test.root },
        fromJSON: JSON.parse,
        format: (pattern: string, workspace: string) => pattern.replace("{0}", workspace),
      };
      const evaluate = (expression: string) =>
        runInNewContext(expression.replace(/^\s*\$\{\{|\}\}\s*$/gu, "").trim(), context);
      for (const checkout of ["workflow", "qualification-verifier"]) {
        // Copy real scripts, not a symlink that could resolve dependencies in the source checkout.
        cpSync("scripts", join(test.root, checkout, "scripts"), { recursive: true });
      }
      const provisioned = evaluate(install["working-directory"]);
      expect(provisioned).toBe(admitted ? "qualification-verifier" : "workflow");
      symlinkSync(resolve("node_modules"), join(test.root, provisioned, "node_modules"), "dir");
      expect(
        existsSync(
          join(test.root, admitted ? "workflow" : "qualification-verifier", "node_modules"),
        ),
      ).toBe(false);
      const script = join(test.root, "select-artifacts.sh");
      writeFileSync(script, selection.run);
      const result = test.run(
        "reuse",
        {
          SOURCE_ADMISSION_JSON: JSON.stringify(source),
          OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: evaluate(
            selection.env.OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR,
          ),
        },
        script,
        { preloadFetch: false, executable: "bash" },
      );
      expect(result.status, result.stderr).toBe(1);
      expectRejected(
        result,
        "Selected publication artifact parent attempt changed or is not terminal",
      );
      expect(result.apiCalls[`repos/${REPOSITORY}/actions/runs/51`]).toBe(1);
      expect(result.outputs).toEqual({});
      expect(selection.env.PARENT_WORKFLOW_SHA).toBe("${{ github.sha }}");
    },
  );
  it("runs explicit selection through the direct CLI and reports asynchronous evidence rejection", () => {
    const test = fixture();
    // Match the workflow node command, without preloads or the test runner's Bun executable.
    const result = test.run(
      "reuse",
      {
        SOURCE_ADMISSION_JSON: JSON.stringify({
          coverage: {
            publication_artifact_source_json: JSON.stringify({ runId: "51", runAttempt: 1 }),
          },
        }),
      },
      SCRIPT,
      { preloadFetch: false, executable: "node" },
    );
    expect(result.status, result.stderr).toBe(1);
    expectRejected(
      result,
      "Selected publication artifact parent attempt changed or is not terminal",
    );
    expect(result.apiCalls[`repos/${REPOSITORY}/actions/runs/51`]).toBe(1);
    expect(result.outputs).toEqual({});
  });
  it("rejects a caller release tag that differs from the sealed candidate", async () => {
    const { client, env } = selectionFixture();
    await expect(
      selectPublicationArtifactSource(
        { runId: "51", runAttempt: 1 },
        { ...env, RELEASE_TAG: "v2026.8.2" },
        client,
      ),
    ).rejects.toThrow("release tag differs from the sealed candidate");
    expect(client.verifyRetainedPublicationArtifacts).not.toHaveBeenCalled();
  });
  it("keeps exact receipt tag equality in the real retained verifier", () => {
    const retained = publicationReuseFixture(false, true);
    expectRejected(
      retained.verifyRetained({ verifyPayloads: true }, undefined, { RELEASE_TAG: "v2026.8.2" }),
      RECEIPT_MISMATCH,
    );
  });
  it("adopts exact original bytes from a failed parent without changing producer Q", async () => {
    const { f, client, env } = selectionFixture();
    const selected = await selectPublicationArtifactSource(
      { runId: "51", runAttempt: 1 },
      env,
      client,
    );
    expect(selected.candidate).toEqual(f.plan.candidate);
    expect(selected.source).toEqual(f.source);
    expect(selected.outputs.publication_artifacts_reused).toBe("true");
    expect(client.verifyRetainedPublicationArtifacts).toHaveBeenCalledOnce();
  });
  it("seals and authenticates historical bytes through final verification and publication", async () => {
    const { f, current, client, selected, finalClient } = await selectedPublicationFixture();
    const options = {
      repository: current.repository,
      runId: current.runId,
      trustedWorkflowSha: current.p,
      trustedWorkflowFullRef: current.publisherFullRef,
      trustedWorkflowRef: current.publisherFullRef.replace("refs/tags/", ""),
      verifierSourceSha: current.p,
      verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
    };
    const downloadArchive = finalClient.downloadArtifactArchive;
    let authenticatedDownloads = 0;
    finalClient.downloadArtifactArchive = async (downloadOptions) => {
      if (!("token" in downloadOptions) || downloadOptions.token !== "synthetic-verifier-token") {
        throw new Error("Final verifier omitted the existing GitHub credential");
      }
      authenticatedDownloads += 1;
      return downloadArchive(downloadOptions);
    };
    vi.stubEnv("GH_TOKEN", "synthetic-verifier-token");
    let evidence;
    try {
      evidence = await validateReleaseRunEvidence(options, finalClient);
      expect(authenticatedDownloads).toBeGreaterThan(0);
      expect(JSON.stringify(current.plan)).not.toContain("synthetic-verifier-token");
    } finally {
      vi.unstubAllEnvs();
      finalClient.downloadArtifactArchive = downloadArchive;
    }
    expect(evidence.current.conclusion).toBe("success");
    expect(client.verifyRetainedPublicationArtifacts).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ RELEASE_TAG: "v" + selected.candidate.package.version }),
    );
    expect(
      validateFullReleaseNpmPreflight({
        manifest: current.manifest,
        repository: current.repository,
        runId: current.runId,
        runAttempt: "1",
        sourceSha: f.c,
        toolingSha: f.q,
      }),
    ).toEqual(selected.publicationArtifacts.npmPreflight);
    await expect(
      authenticateCandidateOwnedArtifact({
        manifest: current.manifest,
        repository: current.repository,
        candidateSha: f.c,
        qualificationSha: f.q,
        publisherSha: current.p,
        publisherFullRef: current.publisherFullRef,
        client: finalClient,
      }),
    ).resolves.toMatchObject({ current: { conclusion: "success" } });
    current.manifest.publicationArtifacts = structuredClone(selected.publicationArtifacts);
    current.manifest.publicationArtifacts.npmPreflight.manifestSha256 = "0".repeat(64);
    await expect(validateReleaseRunEvidence(options, finalClient)).rejects.toThrow(
      "historical producers",
    );
  });
  it("rejects changed candidate workload inputs", async () => {
    const { client, env, candidate } = selectionFixture();
    env.CANDIDATE_REQUEST_JSON = JSON.stringify({
      ...candidate.request,
      toolingSha: env.PARENT_WORKFLOW_SHA,
      releaseSoak: !candidate.request.releaseSoak,
    });
    await expect(
      selectPublicationArtifactSource({ runId: "51", runAttempt: 1 }, env, client),
    ).rejects.toThrow("admitted workload inputs");
    expect(client.verifyRetainedPublicationArtifacts).not.toHaveBeenCalled();
  });
  it.each([
    [{ packageMismatch: true }, "prepared publication bytes"],
    [{ tamperedReceipt: true }, "receipt discovery identity"],
    [{ workloadChanged: true }, "workload closure changed"],
  ] as const)("rejects changed publication evidence %j", async (options, message) => {
    const { client, env } = selectionFixture(options);
    await expect(
      selectPublicationArtifactSource({ runId: "51", runAttempt: 1 }, env, client),
    ).rejects.toThrow(message);
    expect(client.verifyRetainedPublicationArtifacts).not.toHaveBeenCalled();
  });
  it("rejects a changed selected parent attempt", async () => {
    const { client, env } = selectionFixture();
    await expect(
      selectPublicationArtifactSource({ runId: "51", runAttempt: 2 }, env, client),
    ).rejects.toThrow("attempt changed");
  });
});

describe("release-only retired recovery entry points", () => {
  it("rejects a recovery manifest before interpreting its contents", () => {
    expect(() => validateParentManifest({ receiptRecovery: {} }, {})).toThrow(
      "Receipt-backed recovery is retired",
    );
  });
  it("rejects the missing recovery workflow before reading an aggregate or importing it", async () => {
    const f = candidatePublicationFixture();
    const loadManifest = vi.fn(() => {
      throw new Error("Recovery aggregate must not be read");
    });
    await expect(
      validateReleaseRunEvidence(
        {
          repository: f.repository,
          runId: f.runId,
          trustedWorkflowSha: f.p,
          trustedWorkflowFullRef: f.publisherFullRef,
          trustedWorkflowRef: f.publisherFullRef.replace("refs/tags/", ""),
          verifierSourceSha: f.p,
          verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
        },
        {
          ...f.client,
          getRun: async (id: string) => ({
            ...(await f.client.getRun(id)),
            path: ".github/workflows/full-release-receipt-recovery.yml",
          }),
          loadManifest,
        },
      ),
    ).rejects.toThrow("Receipt-backed recovery is retired");
    expect(loadManifest).not.toHaveBeenCalled();
  });
  it("does not introduce the unrelated publication acquisition CLI", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/release-ci-summary.mjs", "--acquire-publication-manifest", "51", "--help"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--acquire-publication-manifest");
  });
});
