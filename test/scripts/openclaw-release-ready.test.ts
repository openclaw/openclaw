import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { preparedClawHubArtifactName } from "../../scripts/clawhub-prepared-artifact.mjs";
import {
  readyArtifactName,
  validateReadyRelease,
  validateReleaseButtonInputs,
} from "../../scripts/openclaw-release-ready.mjs";
import { preparedNpmArtifactName } from "../../scripts/plugin-npm-prepared-release.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const REPOSITORY = "openclaw/openclaw";
const SOURCE_SHA = "a".repeat(40);
const TOOLING_SHA = "b".repeat(40);
const TOOLING = {
  ref: `release-publish/${TOOLING_SHA.slice(0, 12)}-123`,
  fullRef: `refs/tags/release-publish/${TOOLING_SHA.slice(0, 12)}-123`,
  sha: TOOLING_SHA,
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function inputs(overrides: Record<string, unknown> = {}) {
  return {
    tag: "v2026.9.2-beta.1",
    npm_dist_tag: "beta",
    preflight_run_id: "100",
    full_release_validation_run_id: "200",
    full_release_validation_run_attempt: "1",
    ...overrides,
  };
}

function descriptor(target: "npm" | "clawhub") {
  return {
    repository: REPOSITORY,
    runId: target === "npm" ? 300 : 400,
    runAttempt: 1,
    workflowPath: `.github/workflows/plugin-${target}-release.yml`,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: TOOLING.ref,
    workflowSha: TOOLING_SHA,
    artifactId: target === "npm" ? 500 : 600,
    artifactName: `prepared-${target}`,
    artifactDigest: `sha256:${"c".repeat(64)}`,
    artifactSizeBytes: 100,
  };
}

function readyRelease() {
  return {
    schema: "openclaw.release-ready/v1",
    repository: REPOSITORY,
    sourceSha: SOURCE_SHA,
    tooling: { ...TOOLING },
    inputs: validateReleaseButtonInputs(inputs()),
    plugins: { npm: descriptor("npm"), clawhub: descriptor("clawhub") },
  };
}

function readinessDescriptor() {
  return {
    ...descriptor("npm"),
    workflowPath: ".github/workflows/openclaw-release-prepare.yml",
    artifactName: readyArtifactName(SOURCE_SHA, 300, 1),
  };
}

function publicationRequest(ready = readyRelease(), resumeRunId = "") {
  const effectiveInputs = {
    ...ready.inputs,
    ...(resumeRunId ? { openclaw_npm_resume_run_id: resumeRunId } : {}),
    prepared_plugins: JSON.stringify(ready.plugins),
  };
  return {
    schema: "openclaw.release-dispatch/v1",
    repository: REPOSITORY,
    workflowPath: ".github/workflows/openclaw-release-publish.yml",
    workflowEvent: "workflow_dispatch",
    state: "acknowledged",
    button: { runId: 900, runAttempt: 1 },
    expectedReleaseRunAttempt: 1,
    releaseRunId: 700,
    releaseRunAttempt: 1,
    producer: {
      repository: REPOSITORY,
      runId: 700,
      runAttempt: 1,
      workflowPath: ".github/workflows/openclaw-release-publish.yml",
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: TOOLING.ref,
      workflowSha: TOOLING_SHA,
    },
    sourceSha: ready.sourceSha,
    tooling: TOOLING,
    preparedArtifact: readinessDescriptor(),
    inputs: effectiveInputs,
    openclawNpmResumeRunId: effectiveInputs.openclaw_npm_resume_run_id ?? null,
  };
}

describe("release readiness contract", () => {
  it.each([
    ["v2026.9.2-beta.1", "beta"],
    ["v2026.9.2", "beta"],
    ["v2026.9.2", "latest"],
  ])("seals full-release inputs for %s on %s", (tag, channel) => {
    const value = validateReleaseButtonInputs(
      inputs({
        tag,
        npm_dist_tag: channel,
        publish_openclaw_npm: true,
        publish_docker_only: false,
      }),
    );
    expect(value).toEqual({
      ...inputs({ tag, npm_dist_tag: channel }),
      plugin_publish_scope: "all-publishable",
      publish_openclaw_npm: "true",
      publish_docker_only: "false",
      release_evidence_mode: "full-release-validation",
      wait_for_clawhub: "true",
    });
  });

  it.each([
    ["unsealed input", { prepared_plugins: "{}" }],
    ["moving source", { tag: "main" }],
    ["missing source", { tag: "" }],
    ["wrong beta channel", { npm_dist_tag: "latest" }],
    ["alpha owner", { tag: "v2026.9.2-alpha.1", npm_dist_tag: "alpha" }],
    ["extended-stable owner", { tag: "v2026.9.33", npm_dist_tag: "latest" }],
    ["extended-stable selector", { npm_dist_tag: "extended-stable" }],
    ["invalid preflight", { preflight_run_id: "0" }],
    ["missing validation", { full_release_validation_run_id: "" }],
    ["moving validation attempt", { full_release_validation_run_attempt: "latest" }],
    ["selected repair", { plugin_publish_scope: "selected" }],
    ["partial roster", { plugins: "example" }],
    ["core omission", { publish_openclaw_npm: false }],
    ["Docker-only repair", { publish_docker_only: true }],
    ["focused evidence", { release_evidence_mode: "authorized-beta-focused" }],
    ["output injection", { windows_node_tag: "v2026.9.2\nother=true" }],
  ])("rejects %s before preparation", (_label, overrides) => {
    expect(() => validateReleaseButtonInputs(inputs(overrides))).toThrow();
  });

  it("binds the complete registry pair to the source and protected tooling", () => {
    const value = readyRelease();
    expect(validateReadyRelease(value, { sourceSha: SOURCE_SHA, tooling: TOOLING })).toEqual(value);
    expect(readyArtifactName(SOURCE_SHA, 700, 2)).toBe("release-ready-aaaaaaaaaaaa-700-2");
  });

  it.each([
    ["repository", (value) => void (value.repository = "openclaw/fork")],
    ["source SHA", (value) => void (value.sourceSha = "d".repeat(40))],
    ["tooling SHA", (value) => void (value.tooling.sha = "d".repeat(40))],
    ["tooling ref", (value) => void (value.tooling.fullRef = "refs/heads/main")],
    ["npm-only handoff", (value) => Reflect.deleteProperty(value.plugins, "clawhub")],
    ["extra registry", (value) => Object.assign(value.plugins, { other: descriptor("npm") })],
    [
      "missing normalized inputs",
      (value) => Reflect.deleteProperty(value.inputs, "wait_for_clawhub"),
    ],
    ["channel drift", (value) => void (value.inputs.npm_dist_tag = "latest")],
    ["npm producer", (value) => void (value.plugins.npm.workflowSha = "d".repeat(40))],
    ["ClawHub producer", (value) => void (value.plugins.clawhub.workflowHeadBranch = "main")],
    ["swapped registry", (value) => void (value.plugins.npm = descriptor("clawhub"))],
  ] satisfies Array<[string, (value: ReturnType<typeof readyRelease>) => unknown]>)(
    "rejects %s drift in a readiness receipt",
    (_label, mutate) => {
      const value = readyRelease();
      mutate(value);
      expect(() =>
        validateReadyRelease(value, { sourceSha: SOURCE_SHA, tooling: TOOLING }),
      ).toThrow();
    },
  );
});

type Trace = { event: string; args?: string[]; [key: string]: unknown };

function writeFixtureFile(root: string, file: string, content: string) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function mockReadiness(scripts: string, ready = readyRelease()) {
  writeFixtureFile(
    scripts,
    "lib/actions-artifact-archive.mjs",
    `
    export { readBoundedRegularFile } from ${JSON.stringify(pathToFileURL(resolve("scripts/lib/actions-artifact-archive.mjs")).href)};
    export async function downloadActionsArtifactArchive() { return { archiveBytes: Buffer.from('verified fixture archive') }; }
    export function inspectActionsArtifactZipWithPolicy() {
      return new Map([['release-ready.json', Buffer.from(${JSON.stringify(JSON.stringify(ready))})]]);
    }
    `,
  );
}

function bridgeFixture(releaseRunAttempt = 1, conclusion = "success") {
  const root = tempDirs.make("openclaw-release-ready-");
  const harness = join(root, ".release-harness");
  const scripts = join(harness, "scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(
    resolve("scripts/openclaw-release-ready.mjs"),
    join(scripts, "openclaw-release-ready.mjs"),
  );
  for (const name of ["actions-artifact-archive", "record-shared", "release-version"]) {
    writeFixtureFile(
      scripts,
      `lib/${name}.mjs`,
      `export * from ${JSON.stringify(pathToFileURL(resolve(`scripts/lib/${name}.mjs`)).href)};\n`,
    );
  }
  writeFixtureFile(
    harness,
    ".github/workflows/plugin-npm-release.yml",
    readFileSync(".github/workflows/plugin-npm-release.yml", "utf8"),
  );
  writeFixtureFile(
    scripts,
    "fixture-trace.mjs",
    `
    import { appendFileSync } from 'node:fs';
    export function trace(event, value = {}) {
      appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ event, ...value }) + '\\n');
    }
    export async function preparedPackage(target, entry) {
      const name = target + ':' + entry.packageDir;
      trace('transfer-start', { name });
      if (name === process.env.FIXTURE_FAILED_PACKAGE) throw new Error('fixture transfer unavailable');
      trace('transfer-verified', { name });
      return {};
    }
  `,
  );
  for (const target of ["npm", "clawhub"] as const) {
    const packages = ["one", "two", "three"].map((id, index) => ({
      extensionId: id,
      packageDir: `extensions/${id}`,
      packageName: `@openclaw/${id}`,
      version: "2026.9.2-beta.1",
      publishTag: "beta",
      artifactId: 800 + index,
    }));
    const moduleName =
      target === "npm" ? "plugin-npm-prepared-release" : "clawhub-prepared-artifact";
    const prefix = target === "npm" ? "Npm" : "ClawHub";
    writeFixtureFile(
      scripts,
      `${moduleName}.mjs`,
      `
      import { trace, preparedPackage } from './fixture-trace.mjs';
      export { prepared${prefix}ArtifactName } from ${JSON.stringify(pathToFileURL(resolve(`scripts/${moduleName}.mjs`)).href)};
      export async function downloadPrepared${prefix}Release(options) {
        trace('manifest', { target: '${target}', sourceSha: options.sourceSha ?? options.candidateSha,
          toolingSha: options.workflowSha ?? options.toolingSha, selectionMode: options.selectionMode });
        return { packages: ${JSON.stringify(packages)}, npmDistTag: 'default' };
      }
      ${
        target === "clawhub"
          ? `
      export async function resolvePreparedClawHubMatrix(options) {
        const manifest = await downloadPreparedClawHubRelease(options);
        if (process.env.FIXTURE_MISSING_CLAWHUB_PUBLISHER === 'true') {
          throw new Error('fixture ClawHub trusted publisher missing');
        }
        return manifest.packages.map(entry => ({ ...entry, alreadyPublished: false, prepared: entry }));
      }
      `
          : ""
      }
      export async function ${target === "npm" ? "consumePreparedNpmPackage" : "restorePreparedClawHubPackage"}(options) {
        return preparedPackage('${target}', options.package ?? options.entry);
      }
    `,
    );
  }
  writeFixtureFile(
    scripts,
    "release-tooling-identity.mjs",
    `
    import { trace } from './fixture-trace.mjs';
    export function verifyReleaseToolingIdentity() { return { route: 'protected-tag', ...${JSON.stringify(TOOLING)} }; }
    export function runReleaseToolingGh(args) {
      trace('gh', { args });
      if (args[1]?.startsWith('repos/${REPOSITORY}/commits/')) return JSON.stringify({ sha: '${SOURCE_SHA}' });
      if (args.length !== 2 || args[0] !== 'api' || args[1] !== 'repos/${REPOSITORY}/actions/runs/700') {
        throw new Error('unexpected GitHub operation: ' + JSON.stringify(args));
      }
      return JSON.stringify({ id: 700, run_attempt: ${releaseRunAttempt}, repository: { full_name: '${REPOSITORY}' },
        path: '.github/workflows/openclaw-release-publish.yml', event: 'workflow_dispatch',
        head_branch: ${JSON.stringify(TOOLING.ref)}, head_sha: '${TOOLING_SHA}', status: 'completed', conclusion: ${JSON.stringify(conclusion)} });
    }
  `,
  );
  mockReadiness(scripts);
  writeFixtureFile(
    scripts,
    "clawhub-postpublish.mjs",
    `
    import { trace } from './fixture-trace.mjs';
    export async function verifyClawHubPostpublish({ event }) {
      trace('public-verified', { runId: event.workflow_run.id, runAttempt: event.workflow_run.run_attempt });
    }
  `,
  );
  const temporary = join(root, "temp");
  mkdirSync(temporary);
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    GH_TOKEN: "synthetic-token",
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_WORKSPACE: root,
    GITHUB_REF: TOOLING.fullRef,
    GITHUB_REF_NAME: TOOLING.ref,
    GITHUB_SHA: TOOLING_SHA,
    GITHUB_WORKFLOW_SHA: TOOLING_SHA,
    GITHUB_RUN_ID: "900",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_OUTPUT: join(root, "outputs"),
    GITHUB_STEP_SUMMARY: join(root, "summary"),
    RUNNER_TEMP: temporary,
    FIXTURE_TRACE: join(root, "trace.jsonl"),
    FIXTURE_FAILED_PACKAGE: "",
  };
  return {
    root,
    scripts,
    env,
    trace: (): Trace[] =>
      existsSync(env.FIXTURE_TRACE)
        ? readFileSync(env.FIXTURE_TRACE, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}

describe("release readiness executable handoff", () => {
  it.each([
    ["prepare", "prepare", "dispatch-prepare"],
    ["promote", "publish", "dispatch-publish"],
  ] as const)("fails visibly on main before starting %s", (workflowName, jobName, operation) => {
    const fixture = finalizationFixture();
    const workflow = parse(
      readFileSync(`.github/workflows/openclaw-release-${workflowName}.yml`, "utf8"),
    );
    expect(
      runInNewContext(workflow.jobs[jobName].if, {
        github: { repository: REPOSITORY, ref: "refs/heads/main" },
        startsWith: (value: string, prefix: string) => value.startsWith(prefix),
      }),
    ).toBe(true);
    const result = spawnSync(
      process.execPath,
      [
        join(fixture.scripts, "openclaw-release-ready.mjs"),
        operation,
        "--output",
        join(fixture.root, "wrong-ref"),
      ],
      {
        cwd: fixture.root,
        env: { ...fixture.env, GITHUB_REF_NAME: "main", GITHUB_REF: "refs/heads/main" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("frozen protected release-publish tag");
    expect(fixture.trace()).toEqual([
      {
        event: "gh",
        args: [
          "api",
          `repos/${REPOSITORY}/compare/${TOOLING_SHA}...main`,
          "--method",
          "GET",
          "--jq",
          "{status}",
        ],
      },
    ]);
    expect(fixture.state().writes).toBe(0);
  });

  it.each(["none", "transfer", "publisher"] as const)(
    "admits publishers only after readiness and every package is verified (failure=%s)",
    (failure) => {
      const fail = failure !== "none";
      const fixture = bridgeFixture();
      writeFixtureFile(
        fixture.scripts,
        "fixture-dispatch.mjs",
        `
      import { trace } from './fixture-trace.mjs';
      trace('dispatch', { workflow: process.argv[2], args: process.argv.slice(3) });
      console.log(process.argv[2] === 'plugin-npm-release.yml' ? '1000' : '1001');
    `,
      );
      writeFixtureFile(
        fixture.scripts,
        "lib/release-publish-children.sh",
        `
      is_android_release() { return 1; }
      is_stable_release() { return 1; }
      verify_release_tag_target() { :; }
      render_github_release_notes() { :; }
      guard_existing_public_release() { :; }
      resolve_openclaw_npm_publish_state() {
        openclaw_npm_already_published=false
        openclaw_npm_expected_workflow_ref="$CHILD_WORKFLOW_REF"
        openclaw_npm_expected_workflow_sha="$PARENT_WORKFLOW_SHA"
      }
      resolve_clawhub_release_plan() { clawhub_plan_path="$CLAWHUB_PLAN_PATH"; }
      append_clawhub_dispatch_args() { clawhub_dispatch_args=(-f "plugins=fixture"); }
      dispatch_workflow() { node "$GITHUB_WORKSPACE/.release-harness/scripts/fixture-dispatch.mjs" "$@"; }
      dispatch_workflow_at_ref() { shift 2; dispatch_workflow "$@"; }
    `,
      );
      const plan = writeFixtureFile(
        fixture.root,
        "clawhub-plan.json",
        JSON.stringify({
          bootstrapWorkflowSha: TOOLING_SHA,
          bootstrap: { ref: TOOLING.ref, shouldDispatch: false },
          normal: {
            ref: TOOLING.ref,
            workflow: "plugin-clawhub-release.yml",
            shouldDispatch: true,
          },
        }),
      );
      const env = {
        ...fixture.env,
        PREPARED_PLUGINS: JSON.stringify(readyRelease().plugins),
        TARGET_SHA: SOURCE_SHA,
        RELEASE_NPM_DIST_TAG: "beta",
        PLUGIN_PUBLISH_SCOPE: "all-publishable",
        PLUGINS: "",
        CHILD_WORKFLOW_REF: TOOLING.ref,
        PARENT_WORKFLOW_SHA: TOOLING_SHA,
        PARENT_WORKFLOW_BRANCH: TOOLING.ref,
        PARENT_WORKFLOW_FULL_REF: TOOLING.fullRef,
        RELEASE_TAG: "v2026.9.2-beta.1",
        PUBLISH_OPENCLAW_NPM: "true",
        WAIT_FOR_CLAWHUB: "true",
        CLAWHUB_PLAN_PATH: plan,
        FIXTURE_FAILED_PACKAGE: failure === "transfer" ? "clawhub:extensions/three" : "",
        FIXTURE_MISSING_CLAWHUB_PUBLISHER: failure === "publisher" ? "true" : "",
      };
      const workflow = parse(
        readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"),
      );
      const jobs = Object.values(workflow.jobs) as Array<{
        steps?: Array<{ name: string; run?: string; "continue-on-error"?: boolean }>;
      }>;
      const steps = jobs
        .flatMap((job) => job.steps ?? [])
        .filter((step) =>
          [
            "Verify all prepared plugin bytes before publication",
            "Dispatch publish workflows",
          ].includes(step.name),
        );
      expect(steps).toHaveLength(2);
      let failed = false;
      for (const step of steps) {
        const result = spawnSync("bash", ["-c", step.run ?? ""], {
          cwd: fixture.root,
          env,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (result.status !== 0) {
          expect(fail, result.stderr).toBe(true);
          expect(result.stderr).toContain(
            failure === "publisher"
              ? "fixture ClawHub trusted publisher missing"
              : "fixture transfer unavailable",
          );
          failed = true;
          if (!step["continue-on-error"]) {
            break;
          }
        }
      }
      expect(failed).toBe(fail);
      const events = fixture.trace();
      expect(events.filter((entry) => entry.event === "manifest")).toEqual([
        {
          event: "manifest",
          target: "npm",
          sourceSha: SOURCE_SHA,
          toolingSha: TOOLING_SHA,
          selectionMode: "all-publishable",
        },
        {
          event: "manifest",
          target: "clawhub",
          sourceSha: SOURCE_SHA,
          toolingSha: TOOLING_SHA,
          selectionMode: "all-publishable",
        },
      ]);
      const dispatches = events.filter((entry) => entry.event === "dispatch");
      if (fail) {
        expect(dispatches).toEqual([]);
        if (failure === "publisher") {
          expect(events.filter((entry) => entry.event.startsWith("transfer-"))).toEqual([]);
          expect(events.filter((entry) => entry.args?.includes("POST"))).toEqual([]);
        }
      } else {
        expect(events.filter((entry) => entry.event === "transfer-verified")).toHaveLength(6);
        expect(events.findLastIndex((entry) => entry.event === "transfer-verified")).toBeLessThan(
          events.findIndex((entry) => entry.event === "dispatch"),
        );
        expect(dispatches.map((entry) => entry.workflow)).toEqual([
          "plugin-npm-release.yml",
          "plugin-clawhub-release.yml",
        ]);
        expect(dispatches[0]?.args).toContain(
          `prepared_artifact=${JSON.stringify(readyRelease().plugins.npm)}`,
        );
      }
    },
  );

  it.each([
    [1, "success"],
    [2, "success"],
    [1, "failure"],
  ] as const)(
    "retries only the recorded publication attempt (current parent attempt=%s, conclusion=%s)",
    (attempt, conclusion) => {
      const fixture = bridgeFixture(attempt, conclusion);
      const request = writeFixtureFile(
        fixture.root,
        "dispatch.json",
        JSON.stringify(publicationRequest()),
      );
      const result = spawnSync(
        process.execPath,
        [
          join(fixture.scripts, "openclaw-release-ready.mjs"),
          "verify",
          "--request",
          request,
          "--output",
          join(fixture.root, "verified"),
        ],
        {
          cwd: fixture.root,
          env: { ...fixture.env, GITHUB_RUN_ATTEMPT: "2" },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      if (attempt === 1 && conclusion === "success") {
        expect(result.status, result.stderr).toBe(0);
        expect(fixture.trace().filter((entry) => entry.event !== "gh")).toEqual([
          { event: "public-verified", runId: 700, runAttempt: 1 },
        ]);
        expect(readFileSync(fixture.env.GITHUB_OUTPUT, "utf8")).toContain("verified=true");
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(attempt === 1 ? "owner recovery" : "attempt changed");
        expect(result.stderr).not.toContain("retry its failed jobs");
        expect(fixture.trace().filter((entry) => entry.event !== "gh")).toEqual([]);
        expect(existsSync(fixture.env.GITHUB_OUTPUT)).toBe(false);
      }
    },
  );

  it.each(["dispatch-prepare", "dispatch-publish"])(
    "refuses to repeat %s in a rerun",
    (operation) => {
      const fixture = bridgeFixture();
      const result = spawnSync(
        process.execPath,
        [
          join(fixture.scripts, "openclaw-release-ready.mjs"),
          operation,
          "--output",
          join(fixture.root, "rerun"),
        ],
        {
          cwd: fixture.root,
          env: { ...fixture.env, GITHUB_RUN_ATTEMPT: "2" },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/dispatch|already ran/u);
      expect(fixture.trace()).toEqual([]);
    },
  );
});

function finalizationFixture(overrides: Record<string, unknown> = {}) {
  const fixture = bridgeFixture();
  copyFileSync(
    resolve("scripts/release-tooling-identity.mjs"),
    join(fixture.scripts, "release-tooling-identity.mjs"),
  );
  const statePath = writeFixtureFile(
    fixture.root,
    "github-state.json",
    JSON.stringify({
      sourceSha: SOURCE_SHA,
      toolingSha: TOOLING_SHA,
      toolingMissing: false,
      parentRunAttempt: 1,
      parentConclusion: "success",
      isDraft: true,
      isPrerelease: true,
      isLatest: false,
      writes: 0,
      lostClawHubDispatchResponse: false,
      preparationProducer: {},
      ...overrides,
    }),
  );
  const gh = writeFixtureFile(
    fixture.root,
    "bin/gh",
    `#!${process.execPath}
    const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const args = process.argv.slice(2);
    const state = JSON.parse(readFileSync(process.env.FIXTURE_GITHUB_STATE, 'utf8'));
    appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ event: 'gh', args }) + '\\n');
    if (args[0] === 'api' && args[1].startsWith('repos/${REPOSITORY}/commits/')) {
      const sha = decodeURIComponent(args[1]).includes('/release-publish/') ? state.toolingSha : state.sourceSha;
      console.log(args[args.indexOf('--jq') + 1].startsWith('.sha') ? sha : JSON.stringify({ sha }));
    } else if (args[0] === 'api' && args[1] === 'repos/${REPOSITORY}/compare/${TOOLING_SHA}...main') {
      console.log(JSON.stringify({ status: 'identical' }));
    } else if (args[0] === 'api' && args[1] === 'repos/${REPOSITORY}/git/ref/tags/${TOOLING.ref}') {
      if (state.toolingMissing) process.exit(1);
      console.log(JSON.stringify({ ref: '${TOOLING.fullRef}', object: { type: 'commit', sha: state.toolingSha } }));
    } else if (args[0] === 'api' && args[1] === 'repos/${REPOSITORY}/actions/runs/700') {
      if (state.publicationReadbackUnavailable) process.exit(1);
      console.log(JSON.stringify({ id: 700, run_attempt: state.parentRunAttempt,
        repository: { full_name: '${REPOSITORY}' }, event: 'workflow_dispatch',
        path: '.github/workflows/openclaw-release-publish.yml', head_sha: '${TOOLING_SHA}',
        head_branch: '${TOOLING.ref}', status: 'completed', conclusion: state.parentConclusion,
        ...state.publicationProducer }));
    } else if (args[0] === 'api' && args[1] === 'repos/${REPOSITORY}/actions/workflows/openclaw-release-publish.yml/dispatches') {
      const receipt = join(process.env.RUNNER_TEMP, 'release-button/dispatch.json');
      appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ event: 'publication-dispatch',
        request: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null }) + '\\n');
      if (state.publicationResponse === 'lost') process.exit(1);
      if (state.publicationResponse === 'malformed') { console.log('{}'); process.exit(0); }
      console.log(JSON.stringify({ workflow_run_id: 700 }));
    } else if (args[0] === 'api' && args.includes('repos/${REPOSITORY}/actions/workflows/windows-node-release.yml/dispatches')) {
      const body = JSON.parse(readFileSync(0, 'utf8'));
      appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ event: 'windows-dispatch', body }) + '\\n');
      if (state.windowsDispatchFailure) process.exit(1);
      console.log(JSON.stringify({ workflow_run_id: 800, html_url: 'https://github.com/${REPOSITORY}/actions/runs/800' }));
    } else if (args[0] === 'run' && args[1] === 'view' && args.includes('800')) {
      console.log(JSON.stringify({ headSha: '${TOOLING_SHA}', url: 'https://github.com/${REPOSITORY}/actions/runs/800' }));
    } else if (args[0] === 'api' && ['npm', 'clawhub'].some(target => args[1] === 'repos/${REPOSITORY}/actions/workflows/plugin-' + target + '-release.yml/dispatches')) {
      const target = args[1].includes('plugin-npm-') ? 'npm' : 'clawhub';
      const receipt = join(process.env.RUNNER_TEMP, 'release-ready/request.json');
      appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ event: 'preparation-dispatch', target,
        request: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null }) + '\\n');
      if (target === 'clawhub' && state.lostClawHubDispatchResponse) {
        console.error('fixture: ClawHub dispatch response lost after acceptance');
        process.exit(1);
      }
      console.log(JSON.stringify({ workflow_run_id: target === 'npm' ? 300 : 400 }));
    } else if (args[0] === 'api' && ['300', '400'].some(id => args[1] === 'repos/${REPOSITORY}/actions/runs/' + id)) {
      const id = Number(args[1].split('/').at(-1));
      console.log(JSON.stringify({ id, run_attempt: 1, repository: { full_name: '${REPOSITORY}' },
        path: '.github/workflows/plugin-' + (id === 300 ? 'npm' : 'clawhub') + '-release.yml',
        event: 'workflow_dispatch', head_sha: '${TOOLING_SHA}', head_branch: '${TOOLING.ref}',
        status: 'completed', conclusion: 'success', ...state.preparationProducer }));
    } else if (args[0] === 'api' && ['300', '400'].some(id => args[1] === 'repos/${REPOSITORY}/actions/runs/' + id + '/artifacts?per_page=100&page=1')) {
      const runId = Number(args[1].split('/')[5]);
      const artifacts = state.preparationArtifacts.filter(artifact => artifact.workflow_run.id === runId);
      console.log(JSON.stringify({ total_count: artifacts.length, artifacts }));
    } else if (args[0] === 'release' && args[1] === 'edit') {
      const flag = (name, fallback) => {
        const value = args.find(value => value === name || value.startsWith(name + '='));
        return value === undefined ? fallback : value === name || value.endsWith('=true');
      };
      state.isDraft = flag('--draft', state.isDraft);
      state.isPrerelease = flag('--prerelease', state.isPrerelease);
      state.isLatest = flag('--latest', !state.isPrerelease);
      state.writes += 1;
      writeFileSync(process.env.FIXTURE_GITHUB_STATE, JSON.stringify(state));
    } else if (args[0] === 'release' && args[1] === 'view') {
      console.log(JSON.stringify({ isDraft: state.isDraft, isPrerelease: state.isPrerelease }));
    } else {
      console.error('unexpected fixture GitHub operation: ' + JSON.stringify(args));
      process.exit(99);
    }
  `,
  );
  chmodSync(gh, 0o755);
  const env = {
    ...fixture.env,
    PATH: `${dirname(gh)}:${fixture.env.PATH}`,
    FIXTURE_GITHUB_STATE: statePath,
  };
  return {
    ...fixture,
    env,
    run(
      owner: "button" | "parent",
      tag: string,
      channel: string,
      request?: ReturnType<typeof publicationRequest>,
    ) {
      const ready = readyRelease();
      ready.inputs = validateReleaseButtonInputs(inputs({ tag, npm_dist_tag: channel }));
      if (!request) {
        mockReadiness(fixture.scripts, ready);
      }
      const workflow = parse(
        readFileSync(
          `.github/workflows/openclaw-release-${owner === "button" ? "promote" : "publish"}.yml`,
          "utf8",
        ),
      );
      const job = workflow.jobs[owner === "button" ? "finalize" : "finalize_github_release"];
      const step = job.steps.find((entry: { run?: string }) => entry.run);
      return spawnSync("bash", ["-c", step.run], {
        cwd: dirname(fixture.scripts),
        env: {
          ...env,
          RELEASE_TAG: tag,
          SOURCE_SHA,
          RELEASE_NPM_DIST_TAG: channel,
          RELEASE_REQUEST: JSON.stringify(request ?? publicationRequest(ready)),
        },
        encoding: "utf8",
        timeout: 10_000,
      });
    },
    state: (): { writes: number; isDraft: boolean; isPrerelease: boolean; isLatest: boolean } =>
      JSON.parse(readFileSync(statePath, "utf8")),
  };
}

function preparationRequest() {
  return {
    schema: "openclaw.release-ready/v1",
    repository: REPOSITORY,
    sourceSha: SOURCE_SHA,
    tooling: TOOLING,
    inputs: validateReleaseButtonInputs(inputs()),
    npmRunId: 300,
    clawhubRunId: 400,
  };
}

function preparationFixture(overrides: Record<string, unknown> = {}) {
  const preparationArtifacts = (["npm", "clawhub"] as const).map((target) => {
    const {
      artifactId,
      artifactDigest,
      artifactSizeBytes,
      artifactName: _artifactName,
      ...producer
    } = descriptor(target);
    return {
      id: artifactId,
      name: (target === "npm" ? preparedNpmArtifactName : preparedClawHubArtifactName)(
        SOURCE_SHA,
        producer,
      ),
      digest: artifactDigest,
      size_in_bytes: artifactSizeBytes,
      expired: false,
      workflow_run: { id: producer.runId, head_sha: TOOLING_SHA },
    };
  });
  const fixture = finalizationFixture({ preparationArtifacts, ...overrides });
  const git = writeFixtureFile(
    fixture.root,
    "bin/git",
    `#!${process.execPath}
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['show', '${SOURCE_SHA}:package.json'])) process.exit(99);
    console.log(JSON.stringify({ version: '2026.9.2-beta.1' }));
  `,
  );
  chmodSync(git, 0o755);
  const workflow = parse(readFileSync(".github/workflows/openclaw-release-prepare.yml", "utf8"));
  const step = workflow.jobs.prepare.steps.find(
    (entry: { id?: string }) => entry.id === "dispatch",
  );
  return {
    ...fixture,
    requestPath: join(fixture.env.RUNNER_TEMP, "release-ready/request.json"),
    prepare(request?: unknown, attempt = 1) {
      return spawnSync("bash", ["-c", step.run], {
        cwd: dirname(fixture.scripts),
        env: {
          ...fixture.env,
          PUBLISH_INPUTS: JSON.stringify(inputs()),
          PREPARATION_REQUEST: request === undefined ? "" : JSON.stringify(request),
          GITHUB_RUN_ATTEMPT: String(attempt),
        },
        encoding: "utf8",
        timeout: 10_000,
      });
    },
  };
}

function publicationFixture(overrides: Record<string, unknown> = {}, ready = readyRelease()) {
  const fixture = finalizationFixture(overrides);
  mockReadiness(fixture.scripts, ready);
  const workflow = parse(readFileSync(".github/workflows/openclaw-release-promote.yml", "utf8"));
  const step = workflow.jobs.publish.steps.find(
    (entry: { id?: string }) => entry.id === "dispatch",
  );
  const fault = writeFixtureFile(
    fixture.root,
    "fault.cjs",
    `
    const fs = require('node:fs');
    const { syncBuiltinESMExports } = require('node:module');
    const write = fs.writeFileSync;
    const rename = fs.renameSync;
    let updates = 0;
    fs.writeFileSync = function(path, ...args) {
      if (String(path).endsWith('/dispatch.next.json')) {
        updates++;
        if (process.env.FIXTURE_ACK_FAILURE === updates + ':write') throw new Error('fixture ack write failed');
      }
      return write.call(this, path, ...args);
    };
    fs.renameSync = function(path, ...args) {
      if (String(path).endsWith('/dispatch.next.json') &&
          process.env.FIXTURE_ACK_FAILURE === updates + ':rename') throw new Error('fixture ack rename failed');
      return rename.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    `,
  );
  return {
    ...fixture,
    workflow,
    ready,
    requestPath: join(fixture.env.RUNNER_TEMP, "release-button/dispatch.json"),
    publish(extraEnv: Record<string, string> = {}) {
      return spawnSync("bash", ["-c", step.run], {
        cwd: dirname(fixture.scripts),
        env: {
          ...fixture.env,
          NODE_OPTIONS: `--require=${fault}`,
          PREPARED_ARTIFACT: JSON.stringify(readinessDescriptor()),
          OPENCLAW_NPM_RESUME_RUN_ID: "",
          ...extraEnv,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
    },
  };
}

describe("publication dispatch retention", () => {
  it.each(["success", "lost", "malformed"])("retains intent before POST: %s", (response) => {
    const fixture = publicationFixture({ publicationResponse: response });
    const result = fixture.publish();
    const expected = publicationRequest();
    const unknown = {
      ...expected,
      state: "unknown",
      releaseRunId: null,
      releaseRunAttempt: null,
      producer: null,
    };
    expect(fixture.trace().filter((entry) => entry.event === "publication-dispatch")).toEqual([
      { event: "publication-dispatch", request: unknown },
    ]);
    expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(fixture.requestPath, "utf8"))).toEqual(
      response === "success" ? expected : unknown,
    );
    expect(result.status, result.stderr).toBe(response === "success" ? 0 : 1);
    if (response !== "success") {
      expect(existsSync(fixture.env.GITHUB_OUTPUT)).toBe(false);
      expect(result.stderr).toContain("unknown; do not redispatch");
    }
    expect(fixture.state().writes).toBe(0);
  });

  it.each(["existing", "create failure"])("does not POST after %s", (failure) => {
    const fixture = publicationFixture();
    mkdirSync(dirname(fixture.requestPath), { recursive: true });
    if (failure === "existing") {
      writeFileSync(fixture.requestPath, '{"preserve":"original"}');
    } else {
      mkdirSync(fixture.requestPath);
    }
    expect(fixture.publish().status).toBe(1);
    expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toEqual([]);
    if (failure === "existing") {
      expect(readFileSync(fixture.requestPath, "utf8")).toBe('{"preserve":"original"}');
    }
  });

  it.each([
    ["summary", "acknowledged"],
    ["output", "acknowledged"],
    ["1:write", "unknown"],
    ["1:rename", "unknown"],
    ["2:write", "unverified"],
    ["2:rename", "unverified"],
  ])("retains prior intent after %s failure", (failure, state) => {
    const fixture = publicationFixture();
    const env: Record<string, string> = {};
    if (failure === "summary" || failure === "output") {
      mkdirSync(
        failure === "summary" ? fixture.env.GITHUB_STEP_SUMMARY : fixture.env.GITHUB_OUTPUT,
      );
    } else {
      env.FIXTURE_ACK_FAILURE = failure;
    }
    expect(fixture.publish(env).status).toBe(1);
    expect(JSON.parse(readFileSync(fixture.requestPath, "utf8"))).toMatchObject({
      state,
      releaseRunId: state === "unknown" ? null : 700,
    });
    if (failure.endsWith(":rename")) {
      expect(
        JSON.parse(readFileSync(join(dirname(fixture.requestPath), "dispatch.next.json"), "utf8")),
      ).toMatchObject({
        releaseRunId: 700,
      });
    }
    expect(fixture.publish(env).status).toBe(1);
    expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toHaveLength(1);
  });

  it.each([
    ["workflow", { publicationProducer: { path: ".github/workflows/other.yml" } }],
    ["event", { publicationProducer: { event: "push" } }],
    ["ref", { publicationProducer: { head_branch: "main" } }],
    ["SHA", { publicationProducer: { head_sha: "c".repeat(40) } }],
    ["run ID", { publicationProducer: { id: 701 } }],
    ["attempt", { parentRunAttempt: 2 }],
    ["unavailable readback", { publicationReadbackUnavailable: true }],
  ])("keeps the known publisher after invalid %s", (_label, overrides) => {
    const fixture = publicationFixture(overrides);
    expect(fixture.publish().status).toBe(1);
    expect(JSON.parse(readFileSync(fixture.requestPath, "utf8"))).toMatchObject({
      state: "unverified",
      releaseRunId: 700,
      releaseRunAttempt: null,
      producer: null,
    });
    expect(existsSync(fixture.env.GITHUB_OUTPUT)).toBe(false);
    expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toHaveLength(1);
  });

  it.each([
    { state: "unknown", releaseRunId: null },
    { state: "unverified" },
    { schema: "unsupported" },
    { releaseRunAttempt: 2 },
    { sourceSha: "c".repeat(40) },
    { inputs: { ...publicationRequest().inputs, npm_dist_tag: "latest" } },
  ])("rejects an unusable request without publication: %j", (overrides) => {
    const fixture = publicationFixture();
    const request = writeFixtureFile(
      fixture.root,
      "invalid.json",
      JSON.stringify({
        ...publicationRequest(),
        ...overrides,
      }),
    );
    for (const operation of ["verify", "validate-request"]) {
      const result = spawnSync(
        process.execPath,
        [
          join(fixture.scripts, "openclaw-release-ready.mjs"),
          operation,
          "--request",
          request,
          "--output",
          join(fixture.root, operation),
        ],
        { cwd: dirname(fixture.scripts), env: fixture.env, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(1);
    }
    expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toEqual([]);
    expect(fixture.trace().filter((entry) => entry.event === "public-verified")).toEqual([]);
    expect(fixture.state().writes).toBe(0);
  });
});

describe("release preparation recovery", () => {
  it("retains the preparation child before a summary failure", () => {
    const fixture = preparationFixture();
    mkdirSync(fixture.env.GITHUB_STEP_SUMMARY);
    expect(fixture.prepare().status).toBe(1);
    expect(JSON.parse(readFileSync(fixture.requestPath, "utf8"))).toMatchObject({
      npmRunId: 300,
      clawhubRunId: null,
    });
    expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toHaveLength(1);
  });
  it("does not seal readiness when the prepared ClawHub publisher is unavailable", () => {
    const fixture = preparationFixture();
    const workflow = parse(readFileSync(".github/workflows/openclaw-release-prepare.yml", "utf8"));
    const step = workflow.jobs.seal.steps.find((entry: { id?: string }) => entry.id === "seal");
    const result = spawnSync("bash", ["-c", step.run], {
      cwd: dirname(fixture.scripts),
      env: {
        ...fixture.env,
        PREPARATION_REQUEST: JSON.stringify(preparationRequest()),
        FIXTURE_MISSING_CLAWHUB_PUBLISHER: "true",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixture ClawHub trusted publisher missing");
    expect(fixture.trace().filter((entry) => entry.event.startsWith("transfer-"))).toEqual([]);
    expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toEqual([]);
    expect(existsSync(join(fixture.env.RUNNER_TEMP, "release-ready/release-ready.json"))).toBe(
      false,
    );
    expect(existsSync(fixture.env.GITHUB_OUTPUT)).toBe(false);
  });

  it("retains acknowledged preparation when the second dispatch response is lost", () => {
    const fixture = preparationFixture({ lostClawHubDispatchResponse: true });
    const result = fixture.prepare();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ClawHub dispatch response lost after acceptance");
    const request = { ...preparationRequest(), npmRunId: null, clawhubRunId: null };
    expect(fixture.trace().filter((entry) => entry.event === "preparation-dispatch")).toEqual([
      { event: "preparation-dispatch", target: "npm", request },
      { event: "preparation-dispatch", target: "clawhub", request: { ...request, npmRunId: 300 } },
    ]);
    expect(JSON.parse(readFileSync(fixture.requestPath, "utf8"))).toEqual({
      ...request,
      npmRunId: 300,
    });
    expect(existsSync(fixture.env.GITHUB_OUTPUT)).toBe(false);
  });

  it.each([1, 2])(
    "adopts exact identified preparations without dispatch on attempt %s",
    (attempt) => {
      const fixture = preparationFixture();
      const request = preparationRequest();
      const result = fixture.prepare(request, attempt);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(fixture.requestPath, "utf8"))).toEqual(request);
      expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toEqual([]);
      expect(
        fixture.trace().filter((entry) => entry.args?.[1]?.includes("/actions/runs/")),
      ).toEqual([
        { event: "gh", args: ["api", `repos/${REPOSITORY}/actions/runs/300`] },
        { event: "gh", args: ["api", `repos/${REPOSITORY}/actions/runs/400`] },
      ]);
      expect(readFileSync(fixture.env.GITHUB_OUTPUT, "utf8")).toContain(
        `request=${JSON.stringify(request)}\n`,
      );
    },
  );

  it.each([
    ["schema", { schema: "different" }],
    ["repository", { repository: "openclaw/fork" }],
    ["source", { sourceSha: "c".repeat(40) }],
    ["tooling", { tooling: { ...TOOLING, sha: "c".repeat(40) } }],
    ["frozen inputs", { inputs: validateReleaseButtonInputs(inputs({ preflight_run_id: "999" })) }],
    ["unnormalized inputs", { inputs: inputs() }],
    ["unconfirmed child", { clawhubRunId: null }],
    ["string child ID", { npmRunId: "300" }],
    ["zero child ID", { npmRunId: 0 }],
    ["unsafe child ID", { npmRunId: Number.MAX_SAFE_INTEGER + 1 }],
  ] satisfies Array<[string, Record<string, unknown>]>)(
    "rejects recovery with %s before producing a handoff",
    (_label, overrides) => {
      const fixture = preparationFixture();
      const result = fixture.prepare({ ...preparationRequest(), ...overrides });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Preparation recovery");
      expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toEqual([]);
      expect(existsSync(fixture.requestPath)).toBe(false);
      expect(existsSync(fixture.env.GITHUB_OUTPUT)).toBe(false);
    },
  );

  it.each([
    ["workflow", { path: ".github/workflows/openclaw-release-publish.yml" }],
    ["event", { event: "push" }],
    ["protected ref", { head_branch: "main" }],
    ["tooling SHA", { head_sha: "c".repeat(40) }],
    ["attempt", { run_attempt: 0 }],
  ])("rejects a recovered producer with the wrong %s", (_label, preparationProducer) => {
    const fixture = preparationFixture({ preparationProducer });
    const result = fixture.prepare(preparationRequest());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("producer workflow identity mismatch");
    expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toEqual([]);
    expect(existsSync(fixture.env.GITHUB_OUTPUT)).toBe(false);
  });
});

describe("verified release activation", () => {
  it.each([
    ["", undefined],
    ["", "650"],
    ["800", "650"],
  ] as const)(
    "preserves sealed inputs with resume override %s (sealed=%s)",
    (resumeRunId, sealedResumeRunId) => {
      const fixture = finalizationFixture();
      const ready = readyRelease();
      ready.inputs = validateReleaseButtonInputs(
        inputs({
          tag: "v2026.9.2",
          npm_dist_tag: "beta",
          plugin_sdk_api_acknowledgement: "12345678",
          windows_node_tag: "v1.2.3",
          windows_node_installer_digests: JSON.stringify({
            "OpenClawCompanion-Setup-x64.exe": `sha256:${"d".repeat(64)}`,
            "OpenClawCompanion-Setup-arm64.exe": `sha256:${"e".repeat(64)}`,
          }),
          ...(sealedResumeRunId ? { openclaw_npm_resume_run_id: sealedResumeRunId } : {}),
        }),
      );
      writeFixtureFile(
        fixture.scripts,
        "lib/actions-artifact-archive.mjs",
        `
      export { readBoundedRegularFile } from ${JSON.stringify(pathToFileURL(resolve("scripts/lib/actions-artifact-archive.mjs")).href)};
      export async function downloadActionsArtifactArchive() { return { archiveBytes: Buffer.from('verified fixture archive') }; }
      export function inspectActionsArtifactZipWithPolicy() {
        return new Map([['release-ready.json', Buffer.from(${JSON.stringify(JSON.stringify(ready))})]]);
      }
    `,
      );
      const artifact = {
        ...descriptor("npm"),
        workflowPath: ".github/workflows/openclaw-release-prepare.yml",
        artifactName: readyArtifactName(SOURCE_SHA, 300, 1),
      };
      const workflow = parse(
        readFileSync(".github/workflows/openclaw-release-promote.yml", "utf8"),
      );
      const dispatch = workflow.jobs.publish.steps.find(
        (step: { id?: string }) => step.id === "dispatch",
      );
      const result = spawnSync("bash", ["-c", dispatch.run], {
        cwd: dirname(fixture.scripts),
        env: {
          ...fixture.env,
          PREPARED_ARTIFACT: JSON.stringify(artifact),
          OPENCLAW_NPM_RESUME_RUN_ID: resumeRunId,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const outputs = Object.fromEntries(
        readFileSync(fixture.env.GITHUB_OUTPUT, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      expect(outputs).toMatchObject({
        release_tag: "v2026.9.2",
        npm_dist_tag: "beta",
        release_run_id: "700",
      });
      const posts = fixture.trace().filter((entry) => entry.args?.includes("POST"));
      expect(posts).toHaveLength(1);
      const dispatchedInputs = Object.fromEntries(
        (posts[0]?.args ?? [])
          .filter((arg) => arg.startsWith("inputs["))
          .map((arg) => {
            const separator = arg.indexOf("]=");
            return [arg.slice(7, separator), arg.slice(separator + 2)];
          }),
      );
      expect(dispatchedInputs).toEqual({
        ...ready.inputs,
        ...(resumeRunId ? { openclaw_npm_resume_run_id: resumeRunId } : {}),
        prepared_plugins: JSON.stringify(ready.plugins),
      });
      const request = JSON.parse(
        readFileSync(join(fixture.env.RUNNER_TEMP, "release-button/dispatch.json"), "utf8"),
      );
      expect(request).toEqual(publicationRequest(ready, resumeRunId));
      expect(workflow.jobs.publish.outputs.npm_dist_tag).toBe(
        "${{ steps.dispatch.outputs.npm_dist_tag }}",
      );
      const activate = workflow.jobs.finalize.steps.find((step: { run?: string }) => step.run);
      expect(activate.env.RELEASE_NPM_DIST_TAG).toBe("${{ needs.publish.outputs.npm_dist_tag }}");
      if (resumeRunId) {
        const verify = workflow.jobs.verify.steps.find((step: { run?: string }) => step.run);
        const verified = spawnSync("bash", ["-c", verify.run], {
          cwd: dirname(fixture.scripts),
          env: { ...fixture.env, RELEASE_REQUEST: JSON.stringify(request) },
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(verified.status, verified.stderr).toBe(0);
        expect(fixture.trace().filter((entry) => entry.event === "public-verified")).toEqual([
          { event: "public-verified", runId: 700, runAttempt: 1 },
        ]);
        const finalized = fixture.run("button", "v2026.9.2", "beta", request);
        expect(finalized.status, finalized.stderr).toBe(0);
        expect(fixture.state()).toMatchObject({
          writes: 1,
          isDraft: false,
          isPrerelease: false,
          isLatest: false,
        });
        expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toHaveLength(1);
      }
    },
  );

  it.each(["0", "-1", "1.5", " 800", "9007199254740992"])(
    "rejects malformed resume run %s without dispatching publication",
    (resumeRunId) => {
      const fixture = finalizationFixture();
      const result = spawnSync(
        process.execPath,
        [
          join(fixture.scripts, "openclaw-release-ready.mjs"),
          "dispatch-publish",
          `--openclaw-npm-resume-run-id=${resumeRunId}`,
          "--output",
          join(fixture.root, "invalid-resume"),
        ],
        {
          cwd: dirname(fixture.scripts),
          env: fixture.env,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("openclaw_npm_resume_run_id must be a positive safe integer");
      expect(fixture.trace().filter((entry) => entry.args?.includes("POST"))).toEqual([]);
      expect(existsSync(fixture.env.GITHUB_OUTPUT)).toBe(false);
    },
  );

  it.each([
    ["button", "v2026.9.2-beta.1", "beta", true, false],
    ["button", "v2026.9.2", "beta", false, false],
    ["button", "v2026.9.2", "latest", false, true],
    ["parent", "v2026.9.2-beta.1", "beta", true, false],
    ["parent", "v2026.9.2", "beta", false, false],
    ["parent", "v2026.9.2", "latest", false, true],
  ] as const)(
    "activates %s %s on %s with explicit release flags",
    (owner, tag, channel, prerelease, latest) => {
      const fixture = finalizationFixture({ isPrerelease: !prerelease });
      const result = fixture.run(owner, tag, channel);
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.state()).toMatchObject({
        writes: 1,
        isDraft: false,
        isPrerelease: prerelease,
        isLatest: latest,
      });
      if (owner === "button") {
        const calls = fixture.trace().map((entry) => entry.args as string[]);
        const writeIndex = calls.findIndex((args) => args[0] === "release" && args[1] === "edit");
        expect(calls[writeIndex - 2]).toEqual([
          "api",
          `repos/${REPOSITORY}/git/ref/tags/${TOOLING.ref}`,
          "--method",
          "GET",
        ]);
        expect(calls[writeIndex - 1]).toEqual([
          "api",
          `repos/${REPOSITORY}/actions/runs/700`,
          "--method",
          "GET",
        ]);
      }
    },
  );

  it.each([
    ["moved tooling tag", { toolingSha: "c".repeat(40) }],
    ["deleted tooling tag", { toolingMissing: true }],
    ["replaced parent attempt", { parentRunAttempt: 2 }],
    ["failed parent", { parentConclusion: "failure" }],
    ["moved release tag", { sourceSha: "c".repeat(40) }],
  ])("refuses a %s discovered after environment approval", (_label, overrides) => {
    const fixture = finalizationFixture(overrides);
    const result = fixture.run("button", "v2026.9.2", "beta");
    expect(result.status).toBe(1);
    expect(fixture.state()).toMatchObject({ writes: 0, isDraft: true });
  });
});

describe("prepared Windows handoff", () => {
  it.each([
    ["stable", "v2026.9.2", "success", true, true, false, true],
    ["absent", "v2026.9.2", "success", false, false, false, false],
    ["incomplete", "v2026.9.2", "success", true, false, false, true],
    ["beta", "v2026.9.2-beta.1", "success", true, true, false, false],
    ["alpha", "v2026.9.2-alpha.1", "success", true, true, false, false],
    ["failed activation", "v2026.9.2", "failure", true, true, false, false],
    ["skipped activation", "v2026.9.2", "skipped", true, true, false, false],
    ["dispatch failed", "v2026.9.2", "success", true, true, true, true],
  ] as const)(
    "uses the frozen optional selection after activation: %s",
    (_label, tag, activation, selected, digests, dispatchFailure, scheduled) => {
      const fixture = finalizationFixture({ windowsDispatchFailure: dispatchFailure });
      const ready = readyRelease();
      ready.inputs = {
        ...ready.inputs,
        tag,
        windows_node_tag: selected ? "v1.2.3" : "",
        windows_node_installer_digests: digests
          ? JSON.stringify({
              "OpenClawCompanion-Setup-x64.exe": `sha256:${"d".repeat(64)}`,
            })
          : "",
      };
      mockReadiness(fixture.scripts, ready);
      const request = publicationRequest(ready);
      const workflow = parse(
        readFileSync(".github/workflows/openclaw-release-promote.yml", "utf8"),
      );
      const job = workflow.jobs.publish_windows;
      expect(job, "prepared publication must retain optional Windows handoff").toBeDefined();
      expect(job["continue-on-error"]).toBe(true);
      expect(job.permissions).toEqual({ actions: "write", contents: "read" });
      expect(workflow.jobs.finalize.permissions.actions).toBe("read");
      const admitted = runInNewContext(job.if.replace(/^\$\{\{|\}\}$/gu, ""), {
        cancelled: () => false,
        contains: (value: string, part: string) => value.includes(part),
        fromJSON: JSON.parse,
        needs: {
          publish: { result: "success", outputs: { request: JSON.stringify(request) } },
          finalize: { result: activation },
        },
      });
      expect(admitted).toBe(scheduled);
      if (!admitted) {
        return;
      }
      const git = writeFixtureFile(
        fixture.root,
        "bin/git",
        `#!${process.execPath}
        const args = process.argv.slice(2);
        if (JSON.stringify(args) !== JSON.stringify(['ls-remote', '--tags', 'origin', 'refs/tags/${tag}', 'refs/tags/${tag}^{}'])) process.exit(99);
        console.log('${SOURCE_SHA}\\trefs/tags/${tag}');
        `,
      );
      chmodSync(git, 0o755);
      const sleep = writeFixtureFile(
        fixture.root,
        "bin/sleep",
        '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = 5 ]\n',
      );
      chmodSync(sleep, 0o755);
      mkdirSync(join(fixture.scripts, "lib"), { recursive: true });
      copyFileSync(
        resolve("scripts/lib/release-publish-children.sh"),
        join(fixture.scripts, "lib/release-publish-children.sh"),
      );
      const step = job.steps.find(
        (entry: { name?: string }) => entry.name === "Dispatch detached Windows promotion",
      );
      const result = spawnSync("bash", ["-c", step.run], {
        cwd: dirname(fixture.scripts),
        env: { ...fixture.env, RELEASE_REQUEST: JSON.stringify(request) },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(digests && !dispatchFailure ? 0 : 1);
      const dispatches = fixture.trace().filter((entry) => entry.event === "windows-dispatch");
      expect(dispatches).toHaveLength(digests ? 1 : 0);
      if (digests) {
        expect(dispatches[0]?.body).toEqual({
          ref: TOOLING.ref,
          inputs: {
            tag,
            windows_node_tag: "v1.2.3",
            expected_installer_digests: ready.inputs.windows_node_installer_digests,
          },
        });
      }
      if (dispatchFailure) {
        const failureStep = job.steps.find(
          (entry: { name?: string }) => entry.name === "Record failed Windows dispatch",
        );
        expect(failureStep.if).toBe("${{ failure() }}");
        const reported = spawnSync("bash", ["-c", failureStep.run], {
          cwd: dirname(fixture.scripts),
          env: fixture.env,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(reported.status, reported.stderr).toBe(0);
        expect(reported.stdout).toContain("npm and GitHub publication remain complete");
        expect(readFileSync(fixture.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
          "inspect this job before manual recovery",
        );
      }
      const evidence = JSON.parse(
        readFileSync(join(fixture.env.RUNNER_TEMP, "windows-dispatch.json"), "utf8"),
      );
      expect(evidence.state).toBe(digests && !dispatchFailure ? "dispatched" : "dispatch-failed");
      expect(
        job.steps.find(
          (entry: { name?: string }) => entry.name === "Upload Windows dispatch evidence",
        ).with.name,
      ).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
      const parent = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
      const finalizesParent = runInNewContext(parent.jobs.finalize_github_release.if.slice(3, -2), {
        always: () => true,
        contains: (value: string, part: string) => value.includes(part),
        inputs: {
          tag,
          prepared_plugins: request.inputs.prepared_plugins,
          publish_openclaw_npm: true,
        },
        needs: { publish: { result: "success" }, publish_docker: { result: "success" } },
      });
      expect(finalizesParent).toBe(false);
      expect(parent.jobs.publish_windows.if).toContain(
        "needs.finalize_github_release.result == 'success'",
      );
      expect(
        fixture.trace().filter((entry) => entry.args?.[0] === "run" && entry.args?.[1] === "watch"),
      ).toEqual([]);
    },
  );
});
