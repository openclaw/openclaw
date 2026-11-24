import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  readyArtifactName,
  validateReleaseButtonInputs,
} from "../scripts/openclaw-release-ready.mjs";
import { preparedNpmArtifactName } from "../scripts/plugin-npm-prepared-release.mjs";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("replays the executable prepared button with its original receipt identity, without allowing a fresh expired dispatch", () => {
  const root = roots.make("fast-track-button-replay-");
  const scripts = join(root, "scripts");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  copyFileSync(
    resolve(".github/workflows/plugin-npm-release.yml"),
    join(root, ".github/workflows/plugin-npm-release.yml"),
  );
  const moduleUrl = (path: string) =>
    JSON.stringify(pathToFileURL(resolve(`scripts/${path}`)).href);
  const write = (path: string, content: string) => writeFileSync(join(scripts, path), content);
  const sourceSha = "a".repeat(40);
  const toolingSha = "b".repeat(40);
  const repository = "openclaw/openclaw";
  const ref = `release-publish/${toolingSha.slice(0, 12)}-123`;
  const tooling = { ref, fullRef: `refs/tags/${ref}`, sha: toolingSha };
  const exception = JSON.stringify({
    request: { expiresAt: "2020-01-01T00:00:00Z" },
    digest: "original",
  });
  const descriptor = (target: string) => ({
    repository,
    runId: target === "npm" ? 300 : 400,
    runAttempt: 1,
    workflowPath: `.github/workflows/plugin-${target}-release.yml`,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: ref,
    workflowSha: toolingSha,
    artifactId: target === "npm" ? 500 : 600,
    artifactName: "synthetic",
    artifactDigest: `sha256:${"c".repeat(64)}`,
    artifactSizeBytes: 100,
  });
  const npm = descriptor("npm");
  npm.artifactName = preparedNpmArtifactName(sourceSha, npm);
  const ready = {
    schema: "openclaw.release-ready/v1",
    repository,
    sourceSha,
    tooling,
    inputs: validateReleaseButtonInputs({
      tag: "v2026.11.9-beta.1",
      npm_dist_tag: "beta",
      preflight_run_id: "200",
      full_release_validation_run_id: "200",
      full_release_validation_run_attempt: "1",
      fast_track_request: exception,
    }),
    plugins: { npm, clawhub: descriptor("clawhub") },
  };
  const preparedArtifact = {
    ...npm,
    workflowPath: ".github/workflows/openclaw-release-prepare.yml",
    artifactName: readyArtifactName(sourceSha, 300, 1),
  };
  const producer = {
    repository,
    runId: 700,
    runAttempt: 1,
    workflowPath: ".github/workflows/openclaw-release-publish.yml",
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: ref,
    workflowSha: toolingSha,
  };
  const request = {
    schema: "openclaw.release-dispatch/v1",
    repository,
    workflowPath: producer.workflowPath,
    workflowEvent: "workflow_dispatch",
    state: "acknowledged",
    button: { runId: 900, runAttempt: 1 },
    expectedReleaseRunAttempt: 1,
    releaseRunId: 700,
    releaseRunAttempt: 1,
    producer,
    sourceSha,
    tooling,
    preparedArtifact,
    inputs: { ...ready.inputs, prepared_plugins: JSON.stringify(ready.plugins) },
    openclawNpmResumeRunId: null,
  };
  copyFileSync(
    resolve("scripts/openclaw-release-ready.mjs"),
    join(scripts, "openclaw-release-ready.mjs"),
  );
  for (const name of ["record-shared", "release-version"]) {
    write(`lib/${name}.mjs`, `export * from ${moduleUrl(`lib/${name}.mjs`)};`);
  }
  write(
    "clawhub-prepared-artifact.mjs",
    `export * from ${moduleUrl("clawhub-prepared-artifact.mjs")};`,
  );
  write(
    "lib/actions-artifact-archive.mjs",
    `
    export {readBoundedRegularFile} from ${moduleUrl("lib/actions-artifact-archive.mjs")};
    export async function downloadActionsArtifactArchive() { return {archiveBytes: Buffer.from('synthetic transport')}; }
    export function inspectActionsArtifactZipWithPolicy() { return new Map([['release-ready.json', Buffer.from(${JSON.stringify(JSON.stringify(ready))})]]); }
  `,
  );
  // Replace the npm authority boundary, not readiness control flow. Receipt
  // authentication itself is exercised through the real verifier in the receipt suite.
  write(
    "plugin-npm-prepared-release.mjs",
    `
    import {appendFileSync} from 'node:fs';
    export {consumePreparedNpmPackage, createPreparedNpmCapacityObserver, downloadPreparedNpmRelease,
      validatePreparedNpmArtifactDescriptor} from ${moduleUrl("plugin-npm-prepared-release.mjs")};
    export async function authenticatePreparedNpmArtifact(params) {
      if (JSON.stringify(params.fastTrackPublication) !== JSON.stringify({runId:700, runAttempt:1})) {
        throw new Error('Expired request: original publisher receipt identity required');
      }
      appendFileSync(process.env.TRACE, JSON.stringify(params.fastTrackPublication) + '\\n');
      return {workflowSha: ${JSON.stringify(toolingSha)}};
    }
  `,
  );
  write(
    "release-tooling-identity.mjs",
    `
    export function verifyReleaseToolingIdentity() {return {route:'protected-tag', ...${JSON.stringify(tooling)}};}
    export function runReleaseToolingGh(args) {
      if (args.includes('POST') || args.includes('PATCH')) throw new Error('Unexpected mutation');
      if (args[1].includes('/commits/')) return JSON.stringify({sha:${JSON.stringify(sourceSha)}});
      if (args[1].endsWith('/actions/runs/700')) return JSON.stringify({id:700,run_attempt:1,
        repository:{full_name:${JSON.stringify(repository)}},path:${JSON.stringify(producer.workflowPath)},
        event:'workflow_dispatch',head_branch:${JSON.stringify(ref)},head_sha:${JSON.stringify(toolingSha)},status:'completed',conclusion:'success'});
      throw new Error('Unexpected GitHub read: '+JSON.stringify(args));
    }
  `,
  );
  const trace = join(root, "trace");
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, JSON.stringify(request));
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [join(scripts, "openclaw-release-ready.mjs"), ...args, "--output", join(root, "output")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          RELEASE_PUBLISH_RUN_ID: "",
          RELEASE_PUBLISH_RUN_ATTEMPT: "",
          GITHUB_JOB: "verify",
          GITHUB_RUN_ID: "900",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_REPOSITORY: repository,
          GITHUB_REF_NAME: ref,
          GITHUB_REF: tooling.fullRef,
          GITHUB_WORKFLOW_SHA: toolingSha,
          TRACE: trace,
        },
      },
    );
  const replay = run(["validate-request", "--request", requestPath]);
  expect(replay.status, replay.stderr).toBe(0);
  expect(JSON.parse(readFileSync(trace, "utf8").trim())).toEqual({ runId: 700, runAttempt: 1 });
  writeFileSync(
    requestPath,
    JSON.stringify({
      ...request,
      inputs: { ...request.inputs, fast_track_request: '{"digest":"substituted"}' },
    }),
  );
  expect(run(["validate-request", "--request", requestPath]).stderr).toContain(
    "retain the exception request",
  );
  const artifactPath = join(root, "artifact.json");
  writeFileSync(artifactPath, JSON.stringify(preparedArtifact));
  const fresh = run(["dispatch-publish", "--artifact", artifactPath]);
  expect(fresh.status).not.toBe(0);
  expect(fresh.stderr).toContain("original publisher receipt identity required");
});
