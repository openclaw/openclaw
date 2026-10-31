import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { packToArchive } from "../../src/plugins/test-helpers/archive-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const publishStep = parse(
  readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8"),
).jobs.publish_openclaw_npm.steps.find((step: { name: string }) => step.name === "Publish");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const packageNames = [
  "@openclaw/ai",
  "@openclaw/gateway-protocol",
  "@openclaw/gateway-client",
  "openclaw",
];

// Execute the real workflow and admission owner; replace only GitHub/npm transport.
async function fixture() {
  const f = candidatePublicationFixture();
  const root = tempDirs.make("npm-publication-authority-");
  const bin = join(root, "bin");
  const statePath = join(root, "state.json");
  const write = (path: string, content: string, executable = false) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, executable ? { mode: 0o755 } : undefined);
  };
  const json = (path: string, value: unknown) => write(path, JSON.stringify(value));
  const version = "2026.8.28-beta.1";
  json("package.json", { name: "openclaw", version });
  mkdirSync(join(root, "preflight-tarball"));
  const tarballs: { packageName: string; tarballName: string }[] = [];
  for (const [i, name] of packageNames.entries()) {
    const tarballName = "package-" + i + ".tgz";
    json("package/package.json", { name, version });
    // Finish packing before the next identity rewrites the shared package directory.
    await packToArchive({
      pkgDir: join(root, "package"),
      outDir: join(root, "preflight-tarball"),
      outName: tarballName,
    });
    tarballs.push({ packageName: name, tarballName });
  }
  json("preflight-tarball/preflight-manifest.json", { corePackageTarballs: tarballs.slice(0, 3) });
  json("full-release-validation/full-release-validation-manifest.json", f.manifest);
  // Candidate code must never run, including during historical/manual recovery.
  write("scripts/openclaw-npm-publish.sh", "echo CANDIDATE_PUBLISHER_EXECUTED >&2; exit 99\n");
  write(
    "scripts/npm-preflight-tooling-identity.mjs",
    "throw new Error('CANDIDATE_GUARD_EXECUTED');\n",
  );
  symlinkSync(resolve("."), join(root, "trusted-workflow"), "dir");

  const api: Record<string, unknown> = {};
  const binary: Record<string, string> = {};
  const respondBytes = (key: string, value: string | Uint8Array) =>
    (binary[key] = Buffer.from(value).toString("base64"));
  for (const id of new Set([f.runId, ...f.plan.children.map((child) => child.runId)])) {
    api["actions/runs/" + id] = await f.client.getRun(id);
    api["actions/runs/" + id + "/attempts/1"] = f.client.getRunAttempt(id, 1);
    const parentJobs = await f.client.getParentJobs(id);
    api["actions/runs/" + id + "/jobs"] = { total_count: parentJobs.length, jobs: parentJobs };
    const jobs = await f.client.getRunAttemptJobs(id);
    api["actions/runs/" + id + "/attempts/1/jobs"] = { total_count: jobs.length, jobs };
    api["view/" + id] = f.client.getRunView(id);
    if (id === f.runId) {
      for (const job of parentJobs) {
        respondBytes("actions/jobs/" + job.id + "/logs", await f.client.getJobLog(job.id));
      }
    }
  }
  respondBytes("actions/jobs/902/logs", await f.client.getJobLog(902));
  respondBytes("actions/artifacts/70/zip", f.admission.archive());
  const admissionResponse = (path: string) =>
    JSON.parse(f.admission.runGh(["api", `repos/${f.repository}/${path}`]));
  for (const path of [
    "actions/runs/40/attempts/1",
    "actions/runs/40/attempts/1/jobs?per_page=100",
    "actions/artifacts/70",
    "collaborators/" + f.admission.actor.login + "/permission",
    "git/ref/tags/" + f.admission.producer.workflowHeadBranch,
    "compare/" + f.p + "...main",
  ]) {
    api[path.replace(/\?.*$/u, "")] = admissionResponse(path);
  }
  api["compare/" + f.p + "..." + f.p] = { status: "identical" };
  api["actions/runs/99"] = {
    ...f.admission.run,
    id: 99,
    path: ".github/workflows/openclaw-release-publish.yml",
    status: "in_progress",
    conclusion: null,
  };
  for (const key of f.admission.sources.keys()) {
    const separator = key.indexOf(":");
    const path = `contents/${key.slice(separator + 1)}?ref=${key.slice(0, separator)}`;
    api[path] = admissionResponse(path);
  }
  const artifact = <T extends { id: number }>(metadata: T, name: string, value: unknown) => {
    const zip = makeStoredZip({ [name]: JSON.stringify(value) });
    const result = { ...metadata, digest: "sha256:" + hash(zip), size_in_bytes: zip.length };
    api["actions/artifacts/" + metadata.id] = result;
    respondBytes("actions/artifacts/" + metadata.id + "/zip", zip);
    return result;
  };
  const manifestArtifact = artifact(
    f.client.loadManifest().artifact,
    "full-release-validation-manifest.json",
    f.manifest,
  );
  const planArtifact = artifact(
    {
      ...f.client.loadExecutionPlanEvidence().artifact,
      id: 903,
      name: "full-release-execution-plan-" + f.runId,
      expired: false,
      workflow_run: { id: Number(f.runId), head_sha: f.q, head_branch: f.branch },
    },
    "full-release-execution-plan.json",
    f.plan,
  );
  api["actions/runs/" + f.runId + "/artifacts"] = {
    total_count: 2,
    artifacts: [manifestArtifact, planArtifact],
  };
  json("transport.json", { api, binary });
  json("state.json", { writes: [], revoked: false });

  const preload = join(root, "transport.mjs");
  write(
    "transport.mjs",
    `
import { readFileSync, writeFileSync } from 'node:fs';
const root = process.env.NPM_AUTHORITY_FIXTURE;
const statePath = root + '/state.json';
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = state => writeFileSync(statePath, JSON.stringify(state));
if (process.argv[1] === root + '/bin/npm') {
  const state = readState();
  const args = process.argv.slice(2);
  if (args[0] === 'view') {
    process.exit(state.reuseFirst && args[1].startsWith('@openclaw/ai@') ? 0 : 1);
  }
  if (args[0] !== 'publish') throw new Error('Unexpected npm command');
  state.writes.push(args);
  if (state.writes.length === state.revokeAfter) state.revoked = true;
  save(state);
  process.exit(0);
}
if (process.argv[1]?.endsWith('/openclaw-npm-extended-stable-release.mjs') && process.argv[2] === 'publish-plan') {
  const state = readState();
  if (state.revokeAtPreparation) { state.revoked = true; save(state); }
}
const data = JSON.parse(readFileSync(root + '/transport.json', 'utf8'));
function response(args) {
  const state = readState();
  let key = args.find(arg => arg.startsWith('repos/'))?.split('/').slice(3).join('/');
  if (key && !key.startsWith('contents/')) key = key.split('?')[0];
  if (args[0] === 'run' && args[1] === 'view') key = 'view/' + args[2];
  if (!key) throw new Error('Unexpected GitHub transport: ' + JSON.stringify(args));
  if (state.revokeAtParent && key === 'actions/runs/99') { state.revoked = true; save(state); }
  if (data.binary[key]) return Buffer.from(data.binary[key], 'base64');
  const result = data.api[key];
  if (!result) throw new Error('Unexpected GitHub endpoint: ' + key);
  if (state.revoked && key.startsWith('collaborators/')) result.permission = 'read';
  if (state.movedRef && key.startsWith('git/ref/tags/')) result.object.sha = 'd'.repeat(40);
  if ((state.parentCompleted || state.recovery) && key === 'actions/runs/99') {
    Object.assign(result, { status: 'completed', conclusion: 'failure' });
  }
  return Buffer.from(JSON.stringify(result));
}
if (process.argv[1] === root + '/bin/gh') {
  process.stdout.write(response(process.argv.slice(2)));
}
`,
  );
  write("bin/gh", "#!/usr/bin/env node\n", true);
  write("bin/npm", "#!/usr/bin/env node\n", true);
  write(
    "bin/git",
    "#!/bin/sh\n[ \"$*\" = 'rev-parse HEAD' ] || exit 90\nprintf '%s\\n' '" + f.q + "'\n",
    true,
  );
  const env = {
    ...process.env,
    // Preserve the real CLI main guard when the test links the trusted checkout.
    NODE_OPTIONS: "--preserve-symlinks-main --import=" + preload,
    PATH: bin + ":" + process.env.PATH,
    NPM_AUTHORITY_FIXTURE: root,
    OPENCLAW_GH_BIN: join(bin, "gh"),
    GH_TOKEN: "test-only",
    GITHUB_ACTIONS: "true",
    // Publication receipts belong to this fixture, including under hosted Actions.
    GITHUB_OUTPUT: join(root, "github-output"),
    GITHUB_STEP_SUMMARY: join(root, "github-summary"),
    GITHUB_REPOSITORY: f.repository,
    WORKFLOW_SHA: f.p,
    WORKFLOW_REF: f.admission.producer.workflowHeadBranch,
    WORKFLOW_FULL_REF: f.publisherFullRef,
    EXPECTED_RELEASE_SHA: f.q,
    PREFLIGHT_WORKFLOW_SHA: f.q,
    PREFLIGHT_WORKFLOW_BRANCH: f.branch,
    PREFLIGHT_WORKFLOW_PATH: ".github/workflows/full-release-validation.yml",
    PREFLIGHT_RUN_ID: f.runId,
    PREFLIGHT_RUN_ATTEMPT: "1",
    FULL_RELEASE_VALIDATION_RUN_ID: f.runId,
    FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "1",
    RELEASE_PUBLISH_RUN_ID: "99",
    RELEASE_PUBLISH_RUN_ATTEMPT: "1",
    RELEASE_PUBLISH_REF: f.admission.producer.workflowHeadBranch,
    RELEASE_PUBLISH_FULL_REF: f.publisherFullRef,
    RELEASE_PUBLISH_PARENT_STATE_POLICY: "active",
    BYPASS_EXTENDED_STABLE_GUARD: "false",
    OPENCLAW_NPM_PUBLISH_TAG: "beta",
    PUBLISH_TARBALL_PATH: "preflight-tarball/package-3.tgz",
  };
  const state = () =>
    JSON.parse(readFileSync(statePath, "utf8")) as {
      writes: string[][];
      revoked: boolean;
    };
  const change = (values: Record<string, unknown>) =>
    writeFileSync(statePath, JSON.stringify({ ...state(), ...values }));
  const run = (command: string, args: string[]) =>
    spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  const preflight = () =>
    run(process.execPath, [
      resolve("scripts/npm-preflight-tooling-identity.mjs"),
      "--verify-publication-lineage",
      ...Object.entries({
        "full-release-manifest": "full-release-validation/full-release-validation-manifest.json",
        repository: f.repository,
        "source-sha": f.q,
        "workflow-sha": f.q,
        "publisher-sha": f.p,
        "publisher-full-ref": f.publisherFullRef,
        "run-id": f.runId,
        "run-attempt": "1",
      }).flatMap(([key, value]) => ["--" + key, value]),
    ]);
  const publish = () => run("bash", ["--noprofile", "--norc", "-c", publishStep.run]);
  return { state, change, preflight, publish, env };
}

describe("npm final publication authority", () => {
  it.each([true, false])(
    "publishes through trusted tooling with candidate admission: %s",
    async (candidate) => {
      const f = await fixture();
      if (!candidate) {
        f.env.FULL_RELEASE_VALIDATION_RUN_ID = "";
        f.env.FULL_RELEASE_VALIDATION_RUN_ATTEMPT = "";
        f.env.PREFLIGHT_WORKFLOW_SHA = f.env.WORKFLOW_SHA;
      }
      const result = f.publish();
      expect(result.status, result.stderr).toBe(0);
      expect(f.state().writes.map((args) => args[1])).toEqual(
        [0, 1, 2, 3].map((i) => "./preflight-tarball/package-" + i + ".tgz"),
      );
      for (const args of f.state().writes) {
        expect(args.slice(2)).toEqual(["--access", "public", "--tag", "beta", "--provenance"]);
      }
      expect(result.stderr).not.toContain("CANDIDATE_");
      const publications: { package_name: string; source_commit: string }[] = readFileSync(
        f.env.GITHUB_OUTPUT,
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line.slice(line.indexOf("=") + 1)));
      expect(publications.map((publication) => publication.package_name)).toEqual([
        "@openclaw/gateway-protocol",
        "openclaw",
      ]);
      expect(
        publications.every(
          (publication) => publication.source_commit === f.env.EXPECTED_RELEASE_SHA,
        ),
      ).toBe(true);
    },
  );

  const authorityError = "qualification authority";
  it.each<[string, Record<string, unknown>, number[], string]>([
    ["preparation", { revokeAtPreparation: true }, [], authorityError],
    ["publisher check", { revokeAtParent: true }, [], authorityError],
    ["companions", { revokeAfter: 3 }, [0, 1, 2], authorityError],
    ["moved ref", { movedRef: true }, [], "Protected publication tooling tag changed"],
    ["parent completion", { parentCompleted: true }, [], "parent run state"],
    ["manual recovery", { recovery: true, reuseFirst: true, revokeAfter: 1 }, [1], authorityError],
  ])("stops publishing after %s revokes authority", async (_label, change, writes, error) => {
    const f = await fixture();
    if (change.revokeAtPreparation) {
      const preflight = f.preflight();
      expect(preflight.status, preflight.stderr).toBe(0);
    }
    if (change.recovery) {
      f.env.RELEASE_PUBLISH_PARENT_STATE_POLICY = "manual-recovery";
    }
    f.change(change);
    const result = f.publish();
    expect(f.state().writes.map((args) => args[1])).toEqual(
      writes.map((index) => `./preflight-tarball/package-${index}.tgz`),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
    if (change.recovery) {
      expect(result.stdout).toContain("already published; reusing it");
    }
  });
});
