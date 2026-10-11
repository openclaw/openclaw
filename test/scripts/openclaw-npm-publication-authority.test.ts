import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
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

// Run the actual workflow body, trusted shell, CLI, full FRV verifier and
// admission owner. Only GitHub subprocess transport and npm are replaced.
// In-process transport avoids hundreds of fake-gh process boots per proof.
async function fixture(candidateTrap = false) {
  const f = candidatePublicationFixture();
  const root = tempDirs.make("npm-publication-authority-");
  const bin = join(root, "bin");
  const statePath = join(root, "state.json");
  mkdirSync(bin);
  mkdirSync(join(root, "preflight-tarball"));
  mkdirSync(join(root, "full-release-validation"));
  mkdirSync(join(root, "package"));
  mkdirSync(join(root, "scripts"));
  const version = "2026.8.28-beta.1";
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  const tarballs = packageNames.map((name, i) => {
    const tarballName = "package-" + i + ".tgz";
    writeFileSync(join(root, "package/package.json"), JSON.stringify({ name, version }));
    execFileSync("tar", [
      "-czf",
      join(root, "preflight-tarball", tarballName),
      "-C",
      root,
      "package",
    ]);
    return { packageName: name, tarballName };
  });
  writeFileSync(
    join(root, "preflight-tarball/preflight-manifest.json"),
    JSON.stringify({ corePackageTarballs: tarballs.slice(0, 3) }),
  );
  writeFileSync(
    join(root, "full-release-validation/full-release-validation-manifest.json"),
    JSON.stringify(f.manifest),
  );
  // Keep the original mutation path executable for red-before proof. The
  // separate trap case proves a frozen candidate need not ship the repaired P.
  for (const file of [
    "scripts/openclaw-npm-publish.sh",
    "scripts/openclaw-npm-extended-stable-release.mjs",
    "scripts/lib/npm-publish-plan.mjs",
    "scripts/lib/release-version.mjs",
  ]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    copyFileSync(file, join(root, file));
  }
  if (candidateTrap) {
    writeFileSync(
      join(root, "scripts/openclaw-npm-publish.sh"),
      "echo CANDIDATE_PUBLISHER_EXECUTED >&2; exit 99\n",
    );
  }
  writeFileSync(
    join(root, "scripts/npm-preflight-tooling-identity.mjs"),
    "throw new Error('CANDIDATE_GUARD_EXECUTED');\n",
  );
  symlinkSync(resolve("."), join(root, "trusted-workflow"), "dir");

  const api: Record<string, unknown> = {};
  const archives: Record<string, string> = {};
  const logs: Record<string, string> = {};
  const views: Record<string, unknown> = {};
  for (const id of new Set([f.runId, ...f.plan.children.map((child) => child.runId)])) {
    api["actions/runs/" + id] = await f.client.getRun(id);
    api["actions/runs/" + id + "/attempts/1"] = f.client.getRunAttempt(id, 1);
    const parentJobs = await f.client.getParentJobs(id);
    api["actions/runs/" + id + "/jobs"] = { total_count: parentJobs.length, jobs: parentJobs };
    const jobs = await f.client.getRunAttemptJobs(id);
    api["actions/runs/" + id + "/attempts/1/jobs"] = { total_count: jobs.length, jobs };
    views[id] = f.client.getRunView(id);
    if (id === f.runId) {
      for (const job of parentJobs) {
        logs["actions/jobs/" + job.id + "/logs"] = await f.client.getJobLog(job.id);
      }
    }
  }
  logs["actions/jobs/902/logs"] = await f.client.getJobLog(902);
  api["actions/runs/40/attempts/1"] = f.admission.run;
  api["actions/runs/40/attempts/1/jobs"] = f.admission.jobs;
  api["actions/artifacts/70"] = f.admission.metadata;
  archives["actions/artifacts/70/zip"] = f.admission.archive().toString("base64");
  api["collaborators/" + f.admission.actor.login + "/permission"] = {
    permission: "write",
    user: f.admission.actor,
  };
  api["git/ref/tags/" + f.admission.producer.workflowHeadBranch] = {
    ref: f.publisherFullRef,
    object: { type: "commit", sha: f.p },
  };
  api["compare/" + f.p + "...main"] = { status: "ahead" };
  api["compare/" + f.p + "..." + f.p] = { status: "identical" };
  api["actions/runs/99"] = {
    id: 99,
    run_attempt: 1,
    event: "workflow_dispatch",
    head_sha: f.p,
    head_branch: f.admission.producer.workflowHeadBranch,
    path: ".github/workflows/openclaw-release-publish.yml",
    repository: { full_name: f.repository },
    status: "in_progress",
    conclusion: null,
  };
  for (const [key, source] of f.admission.sources) {
    const separator = key.indexOf(":");
    const sha = key.slice(0, separator);
    const path = key.slice(separator + 1);
    const bytes = Buffer.from(source);
    api["contents/" + path + "?ref=" + sha] = {
      type: "file",
      path,
      encoding: "base64",
      size: bytes.length,
      content: bytes.toString("base64"),
      sha: createHash("sha1")
        .update("blob " + bytes.length + "\0")
        .update(bytes)
        .digest("hex"),
    };
  }
  const manifestArchive = makeStoredZip({
    "full-release-validation-manifest.json": JSON.stringify(f.manifest),
  });
  const manifestArtifact = {
    ...f.client.loadManifest().artifact,
    digest: "sha256:" + hash(manifestArchive),
    size_in_bytes: manifestArchive.length,
  };
  const planArchive = makeStoredZip({ "full-release-execution-plan.json": JSON.stringify(f.plan) });
  const planArtifact = {
    id: 903,
    name: "full-release-execution-plan-" + f.runId,
    digest: "sha256:" + hash(planArchive),
    size_in_bytes: planArchive.length,
    expired: false,
    created_at: "2026-08-28T12:01:02.000Z",
    workflow_run: { id: Number(f.runId), head_sha: f.q, head_branch: f.branch },
  };
  api["actions/artifacts/" + manifestArtifact.id] = manifestArtifact;
  api["actions/artifacts/903"] = planArtifact;
  archives["actions/artifacts/" + manifestArtifact.id + "/zip"] =
    manifestArchive.toString("base64");
  archives["actions/artifacts/903/zip"] = planArchive.toString("base64");
  api["actions/runs/" + f.runId + "/artifacts"] = {
    total_count: 2,
    artifacts: [manifestArtifact, planArtifact],
  };
  writeFileSync(join(root, "transport.json"), JSON.stringify({ api, archives, logs, views }));
  writeFileSync(statePath, JSON.stringify({ writes: [], calls: [], revoked: false }));

  const preload = join(root, "transport.mjs");
  writeFileSync(
    preload,
    `
import cp from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const root = process.env.NPM_AUTHORITY_FIXTURE;
const isGh = command => command === 'gh' || command === root + '/bin/gh';
const statePath = root + '/state.json';
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = state => writeFileSync(statePath, JSON.stringify(state));
if (process.argv[1]?.endsWith('/openclaw-npm-extended-stable-release.mjs') && process.argv[2] === 'publish-plan') {
  const state = readState();
  state.calls.push('prepare');
  if (state.revokeAtPreparation) state.revoked = true;
  save(state);
}
const data = JSON.parse(readFileSync(root + '/transport.json', 'utf8'));
function response(args) {
  const state = readState();
  let key = args.find(arg => arg.startsWith('repos/'))?.split('/').slice(3).join('/');
  if (key && !key.startsWith('contents/')) key = key.split('?')[0];
  if (args[0] === 'run' && args[1] === 'view') key = 'view/' + args[2];
  if (!key) throw new Error('Unexpected GitHub transport: ' + JSON.stringify(args));
  state.calls.push(key);
  if (state.revokeAtParent && key === 'actions/runs/99') state.revoked = true;
  save(state);
  if (data.archives[key]) return Buffer.from(data.archives[key], 'base64');
  if (data.logs[key]) return Buffer.from(data.logs[key]);
  let result = key.startsWith('view/') ? data.views[key.slice(5)] : data.api[key];
  if (!result) throw new Error('Unexpected GitHub endpoint: ' + key);
  result = structuredClone(result);
  if (state.revoked && key.startsWith('collaborators/')) result.permission = 'read';
  if (state.movedRef && key.startsWith('git/ref/tags/')) result.object.sha = 'd'.repeat(40);
  if (state.parentCompleted && key === 'actions/runs/99') { result.status = 'completed'; result.conclusion = 'failure'; }
  if (state.recovery && key === 'actions/runs/99') { result.status = 'completed'; result.conclusion = 'failure'; }
  return Buffer.from(JSON.stringify(result));
}
const originalSync = cp.execFileSync;
cp.execFileSync = (command, args, options = {}) => {
  if (!isGh(command)) return originalSync(command, args, options);
  const bytes = response(args);
  if (Number.isInteger(options.stdio?.[1])) writeFileSync(options.stdio[1], bytes);
  return options.encoding ? bytes.toString(options.encoding) : bytes;
};
const originalAsync = cp.execFile;
cp.execFile = (command, args, options, callback) => {
  if (!isGh(command)) return originalAsync(command, args, options, callback);
  try { callback(null, response(args).toString('utf8'), ''); }
  catch (error) { callback(error, '', ''); }
};
cp.execFile[promisify.custom] = async (command, args, options) => {
  if (!isGh(command)) throw new Error('Unexpected async transport: ' + command);
  return { stdout: response(args).toString('utf8'), stderr: '' };
};
syncBuiltinESMExports();
`,
  );
  writeFileSync(
    join(bin, "gh"),
    "#!/bin/sh\necho 'GitHub transport escaped the fixture' >&2; exit 90\n",
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.env.NPM_AUTHORITY_FIXTURE + '/state.json';
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'view') {
  state.calls.push('registry:' + args[1]);
  fs.writeFileSync(path, JSON.stringify(state));
  process.exit(state.reuseFirst && args[1].startsWith('@openclaw/ai@') ? 0 : 1);
}
if (args[0] !== 'publish') throw new Error('Unexpected npm command');
state.writes.push(args);
if (state.writes.length === state.revokeAfter) state.revoked = true;
fs.writeFileSync(path, JSON.stringify(state));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "git"),
    "#!/bin/sh\n[ \"$*\" = 'rev-parse HEAD' ] || exit 90\nprintf '%s\\n' '" + f.q + "'\n",
    { mode: 0o755 },
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
      calls: string[];
      revoked: boolean;
    };
  const change = (values: Record<string, unknown>) =>
    writeFileSync(statePath, JSON.stringify({ ...state(), ...values }));
  const preflight = () =>
    spawnSync(
      process.execPath,
      [
        resolve("scripts/npm-preflight-tooling-identity.mjs"),
        "--verify-publication-lineage",
        "--full-release-manifest",
        "full-release-validation/full-release-validation-manifest.json",
        "--repository",
        f.repository,
        "--source-sha",
        f.q,
        "--workflow-sha",
        f.q,
        "--publisher-sha",
        f.p,
        "--publisher-full-ref",
        f.publisherFullRef,
        "--run-id",
        f.runId,
        "--run-attempt",
        "1",
      ],
      { cwd: root, env, encoding: "utf8" },
    );
  const publish = () =>
    spawnSync("bash", ["--noprofile", "--norc", "-c", publishStep.run], {
      cwd: root,
      env,
      encoding: "utf8",
    });
  return { state, change, preflight, publish, env };
}

describe("npm final publication authority", () => {
  it("publishes all companions and core through trusted tooling after fresh admission", async () => {
    const f = await fixture(true);
    const result = f.publish();
    expect(result.status, result.stderr).toBe(0);
    expect(f.state().writes.map((args) => args[1])).toEqual(
      [0, 1, 2, 3].map((i) => "./preflight-tarball/package-" + i + ".tgz"),
    );
    for (const args of f.state().writes) {
      expect(args.slice(2)).toEqual(["--access", "public", "--tag", "beta", "--provenance"]);
    }
    expect(result.stderr).not.toContain("CANDIDATE_");
    expect(f.state().calls.filter((key) => key === "actions/runs/99")).toHaveLength(4);
  });

  it("retains the historical publisher-lineage route without candidate admission", async () => {
    const f = await fixture();
    f.env.FULL_RELEASE_VALIDATION_RUN_ID = "";
    f.env.FULL_RELEASE_VALIDATION_RUN_ATTEMPT = "";
    f.env.PREFLIGHT_WORKFLOW_SHA = f.env.WORKFLOW_SHA;
    const result = f.publish();
    expect(result.status, result.stderr).toBe(0);
    expect(f.state().writes).toHaveLength(4);
    expect(f.state().calls).not.toContain("actions/artifacts/70/zip");
    expect(f.state().calls.filter((key) => key === "actions/runs/99")).toHaveLength(4);
  });

  it("refuses revocation after successful preflight and during shell preparation", async () => {
    const f = await fixture();
    const preflight = f.preflight();
    expect(preflight.status, preflight.stderr).toBe(0);
    f.change({ revokeAtPreparation: true });
    const result = f.publish();
    expect(f.state().writes).toEqual([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("qualification authority");
    expect(f.state().calls).toContain("prepare");
  });

  it("refreshes the authenticated admission after the final publisher check", async () => {
    const f = await fixture();
    f.change({ revokeAtParent: true });
    const result = f.publish();
    expect(f.state().writes).toEqual([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("qualification authority");
    expect(f.state().calls).toContain("actions/runs/99");
  });

  it.each([3])(
    "stops every later write when admission is revoked after %i companions",
    async (count) => {
      const f = await fixture();
      f.change({ revokeAfter: count });
      const result = f.publish();
      expect(f.state().writes).toHaveLength(count);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("qualification authority");
      expect(f.state().writes.some((args) => args[1]?.endsWith("package-3.tgz"))).toBe(false);
    },
  );

  it.each(["movedRef", "parentCompleted"])(
    "preserves the %s publisher guard",
    async (condition) => {
      const f = await fixture();
      f.change({ [condition]: true });
      const result = f.publish();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        condition === "movedRef" ? "Protected publication tooling tag changed" : "parent run state",
      );
      expect(f.state().writes).toEqual([]);
    },
  );

  it("rechecks admission for manual recovery while reusing a published companion", async () => {
    const f = await fixture();
    f.env.RELEASE_PUBLISH_PARENT_STATE_POLICY = "manual-recovery";
    f.change({ recovery: true, reuseFirst: true, revokeAfter: 1 });
    const result = f.publish();
    expect(f.state().writes.map((args) => args[1])).toEqual(["./preflight-tarball/package-1.tgz"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("already published; reusing it");
    expect(result.stderr).toContain("qualification authority");
  });
});
