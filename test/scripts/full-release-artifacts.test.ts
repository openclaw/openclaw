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
const failure = response.fixtureErrorOnce ?? response.fixtureError;
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
  const list = (path: string, key: string, values: unknown[]) =>
    api(path, { total_count: values.length, [key]: values });
  const runApi = (path: string, overrides: Record<string, unknown>) =>
    api(`actions/runs/${path}`, workflowRun(overrides));
  const jobsApi = (attempt: number, jobs: unknown[]) =>
    list(`actions/runs/81/attempts/${attempt}/jobs?per_page=100&page=1`, "jobs", jobs);
  const run = (command: string, env: NodeJS.ProcessEnv = {}, script = SCRIPT) => {
    const directory = join(root, `invocation-${++invocation}`);
    mkdirSync(directory);
    const outputPath = join(directory, "github-output");
    const callsPath = join(directory, "calls.jsonl");
    writeFileSync(responsesPath, JSON.stringify({ responses, downloads, calls: {} }));
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preloadPath).href, script, command],
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
  const test = fixture(TOOLING_SHA, workflowRef);
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
    releaseSha: TOOLING_SHA,
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
  const qualifiedManifest = JSON.stringify({ sourceSha: TOOLING_SHA });
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
    receipt("npm", "81", bundleOutputs(test.raw, qualifiedReceipt)),
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
        `plugin-npm-prepared-${TOOLING_SHA}-101-1`,
        { "prepared.json": "{}" },
        false,
        101,
      )
    : null;
  const plugin = pluginArchive
    ? {
        repository: REPOSITORY,
        workflowPath: ".github/workflows/plugin-npm-release.yml",
        workflowSha: TOOLING_SHA,
        workflowHeadBranch: workflowRef,
        workflowEvent: "workflow_dispatch",
        runId: 101,
        runAttempt: 1,
        artifactId: pluginArchive.metadata.id,
        artifactName: pluginArchive.metadata.name,
        artifactDigest: pluginArchive.metadata.digest,
        artifactSizeBytes: pluginArchive.metadata.size_in_bytes,
      }
    : null;
  if (plugin) {
    for (const suffix of ["101", "101/attempts/1"]) {
      test.runApi(suffix, {
        id: 101,
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
    archives: [
      rawArchive,
      qualifiedArchive,
      sdkArchive,
      dockerArchive,
      ...architectureArchives,
      ...(pluginArchive ? [pluginArchive] : []),
    ],
    verifyRetained: (options: Record<string, unknown>, root = evidence.manifest) => {
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
        },
        entrypoint,
      );
    },
    expectedPackage: { fileName: test.raw.package.fileName, sha256: test.raw.package.sha256 },
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
  it("authenticates every original payload without replacing the recovery tooling identity", () => {
    const test = publicationReuseFixture(false, true);
    const result = expectSuccess(
      test.verifyRetained({ verifyPayloads: true, expectedPackage: test.expectedPackage }),
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
    expect(result.outputs).toEqual({});
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
