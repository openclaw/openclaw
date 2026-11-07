import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Run the actual entry guard/main in Vitest: the authentic candidate fixture
// imports Vitest and cannot be imported by a plain Node child. Only external
// GitHub/git transport is replaced, never admission or adoption decisions.
async function dispatchPrepare(revokeBeforeDispatch: boolean) {
  const qualification = candidatePublicationFixture({ publicationRoute: "prepared" });
  const version = qualification.source.projection?.version;
  if (!version) {
    throw new Error("Candidate fixture has no projected version");
  }
  const root = tempDirs.make("release-ready-q-cli-");
  const inputsPath = join(root, "inputs.json");
  const outputDir = join(root, "ready");
  const requestPath = join(outputDir, "request.json");
  const githubOutput = join(root, "github-output");
  const tooling = {
    ref: qualification.publisherFullRef.replace(/^refs\/tags\//u, ""),
    fullRef: qualification.publisherFullRef,
    sha: qualification.p,
  };
  const descriptor = {
    repository: qualification.repository,
    runId: 9300,
    runAttempt: 2,
    workflowPath: ".github/workflows/plugin-npm-release.yml",
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: qualification.branch,
    workflowSha: qualification.q,
    artifactId: 9500,
    artifactName: "plugin-npm-prepared-" + qualification.q + "-9300-2",
    artifactDigest: "sha256:" + "d".repeat(64),
    artifactSizeBytes: 1024,
  };
  Object.assign(qualification.manifest.publicationArtifacts, { pluginNpm: descriptor });
  const originalDescriptor = structuredClone(descriptor);
  const inputs = {
    tag: "v" + version,
    npm_dist_tag: "beta",
    preflight_run_id: "100",
    full_release_validation_run_id: qualification.runId,
    full_release_validation_run_attempt: "1",
  };
  writeFileSync(inputsPath, JSON.stringify(inputs));
  const posts: Array<{ endpoint: string; args: string[] }> = [];
  const policyReads: string[] = [];
  let tagReads = 0;
  let revokedAtEffect = false;
  const client = {
    ...qualification.client,
    getWorkflowSource(sha: string, path?: string) {
      if (path === descriptor.workflowPath) {
        policyReads.push(sha);
        if (sha !== qualification.q) {
          throw new Error("Requested P policy for Q artifact");
        }
        return "name: immutable Q plugin policy\n# Fixture data only; never executed.\n";
      }
      return qualification.client.getWorkflowSource();
    },
  };
  const argv = process.argv;
  const exitCode = process.exitCode;
  vi.resetModules();
  vi.doMock("../../scripts/release-ci-summary.mjs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../scripts/release-ci-summary.mjs")>()),
    createReleaseEvidenceClient: () => client,
  }));
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFileSync(command: string, args: string[]) {
      if (command === "git" && args.join(" ") === "show " + qualification.q + ":package.json") {
        return JSON.stringify({ version });
      }
      if (command !== "gh" || args[0] !== "api") {
        throw new Error("Unexpected external command: " + command + " " + args.join(" "));
      }
      const endpoint = args[1] ?? "";
      const prefix = "repos/" + qualification.repository + "/";
      if (endpoint === prefix + "git/ref/tags/" + tooling.ref) {
        tagReads += 1;
        if (tagReads === 2 && revokeBeforeDispatch) {
          if (!existsSync(requestPath)) {
            throw new Error("Revocation preceded request persistence");
          }
          qualification.admission.authority.permission = "read";
          revokedAtEffect = true;
        }
        return JSON.stringify({
          ref: tooling.fullRef,
          object: { type: "commit", sha: tooling.sha },
        });
      }
      if (endpoint === prefix + "commits/" + encodeURIComponent(inputs.tag)) {
        return JSON.stringify({ sha: qualification.q });
      }
      if (endpoint === prefix + "actions/runs/" + qualification.runId + "/attempts/1") {
        return JSON.stringify(qualification.parent);
      }
      if (args.includes("POST")) {
        posts.push({ endpoint, args: [...args] });
        return JSON.stringify({ workflow_run_id: 9400 });
      }
      throw new Error("Unexpected GitHub transport: " + args.join(" "));
    },
  }));
  const errors: string[] = [];
  const errorOutput = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  const logOutput = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const [key, value] of Object.entries({
      GITHUB_REPOSITORY: qualification.repository,
      GITHUB_REF_NAME: tooling.ref,
      GITHUB_REF: tooling.fullRef,
      GITHUB_SHA: qualification.p,
      GITHUB_WORKFLOW_SHA: qualification.p,
      GITHUB_RUN_ID: "900",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: githubOutput,
      GITHUB_STEP_SUMMARY: join(root, "summary"),
      GH_TOKEN: "synthetic-token",
    })) {
      vi.stubEnv(key, value);
    }
    process.exitCode = undefined;
    process.argv = [
      process.execPath,
      resolve("scripts/openclaw-release-ready.mjs"),
      "dispatch-prepare",
      "--inputs",
      inputsPath,
      "--output",
      outputDir,
    ];
    await import("../../scripts/openclaw-release-ready.mjs");
    return {
      status: process.exitCode ?? 0,
      errors,
      posts,
      policyReads,
      tagReads,
      revokedAtEffect,
      qualification,
      originalDescriptor,
      tooling,
      requestPath,
      githubOutput,
    };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    errorOutput.mockRestore();
    logOutput.mockRestore();
    vi.unstubAllEnvs();
    vi.doUnmock("node:child_process");
    vi.doUnmock("../../scripts/release-ci-summary.mjs");
    vi.resetModules();
  }
}

describe("dispatch-prepare authentic candidate-owned Q != P CLI", () => {
  it("adopts original Q descriptor and dispatches only ClawHub at P", async () => {
    const result = await dispatchPrepare(false);
    expect(result.qualification.q).not.toBe(result.qualification.p);
    // On base this reports the CLI's normal exit 1 and descriptor rejection,
    // not a missing-new-export import error or a mocked authorization result.
    expect(result.status, result.errors.join("\n")).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.policyReads).toEqual([result.qualification.q]);
    expect(JSON.parse(readFileSync(result.requestPath, "utf8"))).toMatchObject({
      sourceSha: result.qualification.q,
      tooling: result.tooling,
      npmArtifact: result.originalDescriptor,
      clawhubRunId: 9400,
    });
    const endpoint =
      "repos/" +
      result.qualification.repository +
      "/actions/workflows/plugin-clawhub-release.yml/dispatches";
    expect(result.posts).toEqual([
      {
        endpoint,
        args: [
          "api",
          endpoint,
          "--method",
          "POST",
          "-H",
          "X-GitHub-Api-Version: 2026-03-10",
          "-f",
          "ref=" + result.tooling.ref,
          "-f",
          "inputs[ref]=" + result.qualification.q,
          "-f",
          "inputs[publish_scope]=all-publishable",
          "-f",
          "inputs[dry_run]=true",
        ],
      },
    ]);
    expect(readFileSync(result.githubOutput, "utf8")).toContain("clawhub_run_id=9400");
  });

  it("denies ClawHub after live authority is revoked at the dispatch boundary", async () => {
    const result = await dispatchPrepare(true);
    expect(result.revokedAtEffect, result.errors.join("\n")).toBe(true);
    expect(result.tagReads).toBe(2);
    expect(result.status).toBe(1);
    expect(result.errors).toEqual([
      "Qualification operator no longer has repository qualification authority",
      "[openclaw-release-ready] FAILED (exit 1)",
    ]);
    expect(result.policyReads).toEqual([result.qualification.q]);
    expect(result.posts).toEqual([]);
    expect(JSON.parse(readFileSync(result.requestPath, "utf8"))).toMatchObject({
      sourceSha: result.qualification.q,
      tooling: result.tooling,
      npmArtifact: result.originalDescriptor,
      clawhubRunId: null,
    });
    expect(existsSync(result.githubOutput)).toBe(false);
  });
});
