import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("../../scripts/release-ci-summary.mjs");
  vi.resetModules();
});

// Exercise the actual CLI entrypoint through archive loading, recovery authentication,
// Q-owned npm adoption, retained dispatch intent, and the last live authority check.
// GitHub is fixture transport only; package sealing and publication are not run.
describe("release readiness consumes receipt-backed recovery", () => {
  it.each([false, true])(
    "dispatches only with current recovery authority (revoked=%s)",
    async (revoke) => {
      vi.resetModules();
      const { recoveryConsumptionFixture } =
        await import("./release-evidence-consumption.test-support.js");
      const { verifyOriginalReceiptQualification } =
        await import("../../scripts/full-release-receipt-recovery.mjs");
      const f = recoveryConsumptionFixture();
      const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
      f.manifest.retainedPublicationPayloads = original.publication.payloads;
      const root = tempDirs.make("release-ready-recovery-cli-");
      const outputDir = join(root, "ready");
      const requestPath = join(outputDir, "dispatch.json");
      const githubOutput = join(root, "github-output");
      const tooling = {
        ref: f.direct.publisherFullRef.slice("refs/tags/".length),
        fullRef: f.direct.publisherFullRef,
        sha: f.direct.p,
      };
      const producer = {
        repository: f.direct.repository,
        runId: 9300,
        runAttempt: 1,
        workflowPath: ".github/workflows/openclaw-release-prepare.yml",
        workflowEvent: "workflow_dispatch",
        workflowHeadBranch: tooling.ref,
        workflowSha: tooling.sha,
      };
      const ready = {
        schema: "openclaw.release-ready/v1",
        repository: f.direct.repository,
        sourceSha: f.direct.q,
        tooling,
        inputs: {
          tag: "v2026.8.28-beta.1",
          npm_dist_tag: "beta",
          preflight_run_id: "81",
          full_release_validation_run_id: "900",
          full_release_validation_run_attempt: "1",
          plugin_publish_scope: "all-publishable",
          publish_openclaw_npm: "true",
          publish_docker_only: "false",
          release_evidence_mode: "full-release-validation",
          wait_for_clawhub: "true",
        },
        plugins: {
          npm: f.manifest.publicationArtifacts.pluginNpm,
          clawhub: {
            ...producer,
            workflowPath: ".github/workflows/plugin-clawhub-release.yml",
            artifactId: 9302,
            artifactName: "retained-clawhub-package",
            artifactDigest: "sha256:" + "e".repeat(64),
            artifactSizeBytes: 100,
          },
        },
      };
      const archive = makeStoredZip({ "release-ready.json": JSON.stringify(ready) });
      const descriptor = {
        ...producer,
        artifactId: 9301,
        artifactName: "release-ready-" + f.direct.q.slice(0, 12) + "-9300-1",
        artifactDigest: "sha256:" + createHash("sha256").update(archive).digest("hex"),
        artifactSizeBytes: archive.length,
      };
      const artifactPath = join(root, "artifact.json");
      writeFileSync(artifactPath, JSON.stringify(descriptor));
      const publicationRun = {
        ...f.run,
        id: 9400,
        head_branch: tooling.ref,
        path: ".github/workflows/openclaw-release-publish.yml",
      };
      let tagReads = 0;
      const posts: string[][] = [];
      const runGh = (args: string[]) => {
        const path = (args[1] ?? "").replace("repos/" + f.direct.repository + "/", "");
        if (path === "git/ref/tags/" + tooling.ref) {
          tagReads += 1;
          if (tagReads === 2 && revoke) {
            expect(existsSync(requestPath)).toBe(true);
            f.recoveryAuthority.permission = "read";
          }
          return JSON.stringify({
            ref: tooling.fullRef,
            object: { type: "commit", sha: tooling.sha },
          });
        }
        if (path === "commits/" + ready.inputs.tag) {
          return JSON.stringify({ sha: f.direct.q });
        }
        if (path === "actions/workflows/openclaw-release-publish.yml/dispatches") {
          posts.push(args);
          return JSON.stringify({ workflow_run_id: 9400 });
        }
        if (path === "actions/runs/9400") {
          return JSON.stringify(publicationRun);
        }
        return f.runGh(args);
      };
      const transport = await import("../../scripts/release-tooling-identity.mjs");
      vi.spyOn(transport, "runReleaseToolingGh").mockImplementation(runGh);
      vi.spyOn(childProcess, "execFileSync").mockImplementation((command, args) => {
        if (command !== "gh" || !Array.isArray(args)) {
          throw new Error("Unexpected external command: " + command);
        }
        return runGh(args);
      });
      vi.doMock("../../scripts/release-ci-summary.mjs", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../../scripts/release-ci-summary.mjs")>()),
        createReleaseEvidenceClient: () => f.client,
      }));
      const artifactFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/actions/artifacts/9301/zip")) {
          return Promise.resolve(new Response(new Uint8Array(archive)));
        }
        if (path.endsWith("/actions/artifacts/9301")) {
          return Promise.resolve(
            Response.json({
              id: descriptor.artifactId,
              name: descriptor.artifactName,
              digest: descriptor.artifactDigest,
              size_in_bytes: descriptor.artifactSizeBytes,
              expired: false,
              workflow_run: { id: producer.runId, head_sha: tooling.sha },
            }),
          );
        }
        if (path.endsWith("/actions/runs/9300/attempts/1")) {
          return Promise.resolve(
            Response.json({ ...publicationRun, id: 9300, path: producer.workflowPath }),
          );
        }
        return artifactFetch(input, init);
      });
      for (const [key, value] of Object.entries({
        GITHUB_REPOSITORY: f.direct.repository,
        GITHUB_REF_NAME: tooling.ref,
        GITHUB_REF: tooling.fullRef,
        GITHUB_SHA: tooling.sha,
        GITHUB_WORKFLOW_SHA: tooling.sha,
        GITHUB_RUN_ID: "9200",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_OUTPUT: githubOutput,
        GITHUB_STEP_SUMMARY: join(root, "summary"),
      })) {
        vi.stubEnv(key, value);
      }
      const argv = process.argv;
      const exitCode = process.exitCode;
      const errors: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) =>
        errors.push(args.map(String).join(" ")),
      );
      vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        process.exitCode = undefined;
        process.argv = [
          process.execPath,
          resolve("scripts/openclaw-release-ready.mjs"),
          "dispatch-publish",
          "--artifact",
          artifactPath,
          "--output",
          outputDir,
        ];
        await import("../../scripts/openclaw-release-ready.mjs");
        expect(process.exitCode ?? 0, errors.join("\n")).toBe(revoke ? 1 : 0);
        expect(tagReads).toBe(2);
        expect(posts).toHaveLength(revoke ? 0 : 1);
        expect(JSON.parse(readFileSync(requestPath, "utf8"))).toMatchObject({
          state: revoke ? "unknown" : "acknowledged",
          sourceSha: f.direct.q,
          tooling,
          releaseRunId: revoke ? null : 9400,
          inputs: { ...ready.inputs, prepared_plugins: JSON.stringify(ready.plugins) },
        });
        expect(existsSync(githubOutput)).toBe(!revoke);
        if (revoke) {
          expect(errors.join("\n")).toContain(
            "Qualification operator no longer has repository qualification authority",
          );
        } else {
          expect(errors).toEqual([]);
          expect(posts[0]).toEqual(
            expect.arrayContaining([
              "ref=" + tooling.ref,
              "inputs[full_release_validation_run_id]=900",
              "inputs[prepared_plugins]=" + JSON.stringify(ready.plugins),
            ]),
          );
        }
      } finally {
        process.argv = argv;
        process.exitCode = exitCode;
      }
    },
  );
});
