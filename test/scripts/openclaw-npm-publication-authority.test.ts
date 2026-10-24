import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  const tarballs = packageNames.map((name, i) => {
    const tarballName = "package-" + i + ".tgz";
    json("package/package.json", { name, version });
    const target = join(root, "preflight-tarball", tarballName);
    execFileSync("tar", ["-czf", target, "-C", root, "package"]);
    return { packageName: name, tarballName };
  });
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
  api["actions/runs/40/attempts/1"] = f.admission.run;
  api["actions/runs/40/attempts/1/jobs"] = f.admission.jobs;
  api["actions/artifacts/70"] = f.admission.metadata;
  respondBytes("actions/artifacts/70/zip", f.admission.archive());
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
  const archive = (name: string, value: unknown) =>
    makeStoredZip({ [name]: JSON.stringify(value) });
  const artifact = <T extends { id: number }>(metadata: T, name: string, value: unknown) => {
    const zip = archive(name, value);
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
      id: 903,
      name: "full-release-execution-plan-" + f.runId,
      expired: false,
      created_at: "2026-08-28T12:01:02.000Z",
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
  json("state.json", { writes: [], calls: [], revoked: false });

  const preload = join(root, "transport.mjs");
  write(
    "transport.mjs",
    `
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
const root = process.env.NPM_AUTHORITY_FIXTURE;
const isGh = command => command === 'gh' || command === root + '/bin/gh';
const statePath = root + '/state.json';
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = state => writeFileSync(statePath, JSON.stringify(state));
if (process.argv[1] === root + '/bin/npm') {
  const state = readState();
  const args = process.argv.slice(2);
  if (args[0] === 'view') {
    state.calls.push('registry:' + args[1]);
    save(state);
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
  if (data.binary[key]) return Buffer.from(data.binary[key], 'base64');
  let result = data.api[key];
  if (!result) throw new Error('Unexpected GitHub endpoint: ' + key);
  result = structuredClone(result);
  if (state.revoked && key.startsWith('collaborators/')) result.permission = 'read';
  if (state.movedRef && key.startsWith('git/ref/tags/')) result.object.sha = 'd'.repeat(40);
  if ((state.parentCompleted || state.recovery) && key === 'actions/runs/99') {
    Object.assign(result, { status: 'completed', conclusion: 'failure' });
  }
  return Buffer.from(JSON.stringify(result));
}
const originalSync = cp.execFileSync;
cp.execFileSync = (command, args, options = {}) => {
  if (!isGh(command)) return originalSync(command, args, options);
  const bytes = response(args);
  if (Number.isInteger(options.stdio?.[1])) writeFileSync(options.stdio[1], bytes);
  return options.encoding ? bytes.toString(options.encoding) : bytes;
};
const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
  if (!isGh(command)) return originalSpawn(command, args, options);
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => {
    let code = 0;
    try { child.stdout.end(response(args)); }
    catch (error) { code = 1; child.emit('error', error); child.stdout.end(); }
    child.stderr.end();
    child.emit('close', code, null);
  });
  return child;
};
syncBuiltinESMExports();
`,
  );
  write("bin/gh", "#!/bin/sh\necho 'GitHub transport escaped the fixture' >&2; exit 90\n", true);
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
      expect(f.state().calls.filter((key) => key === "actions/runs/99")).toHaveLength(4);
      if (!candidate) {
        expect(f.state().calls).not.toContain("actions/artifacts/70/zip");
      }
    },
  );

  const authorityError = "qualification authority";
  it.each<[string, Record<string, unknown>, number[], string, string?]>([
    ["preparation", { revokeAtPreparation: true }, [], authorityError, "prepare"],
    ["publisher check", { revokeAtParent: true }, [], authorityError, "actions/runs/99"],
    ["companions", { revokeAfter: 3 }, [0, 1, 2], authorityError],
    ["moved ref", { movedRef: true }, [], "Protected publication tooling tag changed"],
    ["parent completion", { parentCompleted: true }, [], "parent run state"],
    ["manual recovery", { recovery: true, reuseFirst: true, revokeAfter: 1 }, [1], authorityError],
  ])("stops publishing after %s revokes authority", async (_label, change, writes, error, call) => {
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
    if (call) {
      expect(f.state().calls).toContain(call);
    }
    if (change.recovery) {
      expect(result.stdout).toContain("already published; reusing it");
    }
  });
});
