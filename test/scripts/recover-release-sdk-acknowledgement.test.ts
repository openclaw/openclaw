import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const repo = "openclaw/openclaw";
const targetSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const branch = "release-publish/bbbbbbbbbbbb-123";
const workflow = ".github/workflows/openclaw-release-publish.yml";
const releaseTag = "v2026.11.10-beta.2";
const predecessor = "v2026.11.10-beta.1";
const payload = { entrypointsAdded: ["new"], entrypointsRemoved: [], exports: [] };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = hash(JSON.stringify(payload));
const acknowledgement = digest.slice(0, 8) + "@" + predecessor;
const env = {
  GITHUB_REPOSITORY: repo,
  GH_TOKEN: "fixture-token",
  SDK_ACKNOWLEDGEMENT_REUSE: "reuse:42/2",
  RELEASE_TAG: releaseTag,
  EXPECTED_SHA: targetSha,
  RELEASE_NPM_DIST_TAG: "beta",
};

it.each([
  ["matched", {}, ""],
  ["wrong release", { releaseTag: predecessor }, "does not match"],
  ["wrong digest", { digest: "d".repeat(64) }, "does not match"],
  ["digest without review", { acknowledgement: "" }, "does not match"],
  ["wrong attempt", { attempt: "1" }, "does not match"],
  ["missing record", {}, "missing, expired, or ambiguous"],
  ["unattested record", {}, "attestation verify"],
] as const)("recovers only an authenticated exact SDK review: %s", (scenario, overrides, error) => {
  const root = roots.make("recover-sdk-ack-");
  const manifest = join(root, "manifest.json");
  const evidence = createPluginSdkApiReleaseEvidence({
    baseRef: predecessor,
    baseSha: "c".repeat(40),
    headSha: targetSha,
    workflowSha: toolingSha,
    diff: { ...payload, digest },
  });
  writeFileSync(manifest, JSON.stringify({ pluginSdkApi: evidence }));
  const review = JSON.stringify({
    runId: "42",
    attempt: "2",
    releaseTag,
    targetSha,
    npmDistTag: "beta",
    digest,
    acknowledgement,
    ...overrides,
  });
  const archive = makeStoredZip({ "review.json": review });
  const artifact = {
    id: 7,
    name: "release-sdk-acknowledgement-42-2",
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    digest: "sha256:" + hash(archive),
    workflow_run: { id: 42, head_sha: toolingSha },
  };
  const routes = {
    ["repos/" + repo + "/actions/runs/42/attempts/2"]: {
      id: 42,
      run_attempt: 2,
      status: "completed",
      conclusion: "failure",
      head_branch: branch,
      head_sha: toolingSha,
      event: "workflow_dispatch",
      path: workflow,
      repository: { full_name: repo },
    },
    ["repos/" + repo + "/git/ref/tags/" + branch]: {
      ref: "refs/tags/" + branch,
      object: { type: "commit", sha: toolingSha },
    },
    ["repos/" + repo + "/actions/runs/42/artifacts?name=" + artifact.name + "&per_page=100"]:
      scenario === "missing record"
        ? { artifacts: [], total_count: 0 }
        : { artifacts: [artifact], total_count: 1 },
  };
  const fixture = {
    routes,
    review,
    attested: scenario !== "unattested record",
    signer: {
      "--repo": repo,
      "--signer-workflow": repo + "/" + workflow,
      "--signer-digest": toolingSha,
      "--source-digest": toolingSha,
      "--source-ref": "refs/tags/" + branch,
    },
    artifact,
    archive: archive.toString("base64"),
  };
  writeFileSync(
    join(root, "gh"),
    `#!/usr/bin/env node
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const fixture = JSON.parse(process.env.SDK_FIXTURE);
const [command, operand, file, ...flags] = process.argv.slice(2);
if (command === "api" && Object.hasOwn(fixture.routes, operand)) {
  console.log(JSON.stringify(fixture.routes[operand]));
} else if (command === "attestation" && operand === "verify") {
  assert.equal(readFileSync(file, "utf8"), fixture.review);
  for (const [key, value] of Object.entries(fixture.signer)) {
    assert.equal(flags[flags.indexOf(key) + 1], value);
  }
  assert.ok(flags.includes("--deny-self-hosted-runners"));
  process.exit(fixture.attested ? 0 : 1);
} else { process.exit(2); }
`,
    { mode: 0o755 },
  );
  const preloader = join(root, "fixture-fetch.mjs");
  writeFileSync(
    preloader,
    `
const { artifact, archive } = JSON.parse(process.env.SDK_FIXTURE);
globalThis.fetch = async (url) => {
  const api = "https://api.github.com/repos/openclaw/openclaw/actions/artifacts/7";
  if (String(url) === api) return Response.json(artifact);
  if (String(url) === api + "/zip") return new Response(Buffer.from(archive, "base64"));
  throw new Error("Unexpected fixture request: " + url);
};
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", preloader, resolve("scripts/recover-release-sdk-acknowledgement.mjs"), manifest],
    {
      cwd: root,
      env: {
        ...env,
        SDK_FIXTURE: JSON.stringify(fixture),
        PATH: root + delimiter + process.env.PATH,
      },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  expect(result.status, result.stderr).toBe(error ? 1 : 0);
  if (error) {
    expect(result.stderr).toContain(error);
    expect(result.stderr).toContain("Review the SDK evidence and rerun Docker-only recovery");
    expect(result.stdout).toBe("");
  } else {
    expect(result.stdout).toBe(acknowledgement);
  }
});
