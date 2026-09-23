import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import JSZip from "jszip";
import * as tar from "tar";
import { expect } from "vitest";
import {
  createPluginPublicationArtifact,
  verifyPluginPublicationArtifact,
} from "../../scripts/plugin-publication-artifact.mjs";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
export const sourceSha = "b".repeat(40);
export const workflowSha = "a".repeat(40);
const repository = "openclaw/openclaw";
const workflowPath = ".github/workflows/plugin-npm-release.yml";
export const packageName = "@openclaw/demo";
export const version = "2026.9.2-beta.1";
const publisherName = `Publish plugin npm package (${packageName})`;
const preflightName = `Preflight plugin npm package (${packageName})`;

async function zip(entries: Record<string, Buffer>) {
  const archive = new JSZip();
  for (const [name, bytes] of Object.entries(entries)) {
    archive.file(name, bytes);
  }
  return archive.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

export async function createNpmPublicationReadbackFixture(
  root: string,
  mode = "direct",
  fault = "none",
) {
  const runId = mode === "prior-deferred" ? 201 : 200;
  const runAttempt = 2;
  const replanned = mode === "replanned-failed";
  const noPublication = fault === "no-publish" || mode === "prior-deferred" || replanned;
  const publisherAttempt = mode === "retained-publisher" || replanned ? 1 : 2;
  const plannerAttempt = mode === "retained-plan" ? 1 : replanned ? 2 : publisherAttempt;
  const producerId = mode === "prepared" ? 100 : runId;
  const producerAttempt =
    mode === "prepared" ? 3 : mode === "retained-qualification" ? 1 : publisherAttempt;
  const source = writePublishablePluginFixture(root, {
    extensionId: "demo",
    version,
    publishTo: "npm",
  });
  const mixed = ["missing-planned-job", "existing-package"].includes(fault);
  if (mixed) {
    writePublishablePluginFixture(root, {
      extensionId: "existing",
      version,
      publishTo: "npm",
    });
  }
  const sourcePackage = readFileSync(join(source.packageDir, "package.json"));
  const packRoot = join(root, "packed/package");
  mkdirSync(join(packRoot, "dist"), { recursive: true });
  writeFileSync(join(packRoot, "package.json"), sourcePackage);
  writeFileSync(join(packRoot, "openclaw.plugin.json"), JSON.stringify({ id: "demo" }));
  writeFileSync(join(packRoot, "dist/index.js"), "export default {};\n");
  writeFileSync(join(packRoot, "README.md"), "Qualified plugin.\n");
  const artifactDir = join(root, "artifact");
  mkdirSync(artifactDir);
  const tarballPath = join(artifactDir, "demo.tgz");
  await tar.c(
    {
      cwd: join(root, "packed"),
      file: tarballPath,
      gzip: true,
      portable: true,
      noPax: true,
      mtime: new Date("1985-10-26T08:15:00Z"),
    },
    [
      "package/package.json",
      "package/openclaw.plugin.json",
      "package/dist/index.js",
      "package/README.md",
    ],
  );
  const artifactName = `plugin-npm-package-demo-${version}-npm-oidc-${producerId}-${producerAttempt}`;
  const common = {
    artifactName,
    packageDir: "extensions/demo",
    packageName,
    version,
    publishTag: "beta",
    route: "npm-oidc",
    targetSha: sourceSha,
    sourcePackageJsonSha256: createHash("sha256").update(sourcePackage).digest("hex"),
    publicationReason: "Stable npm registry preflight selected npm-oidc.",
    publisherPolicy: {
      schema: "openclaw.plugin-npm-publisher-policy/v1",
      policyId: "plugin-npm-release-workflow",
      sha256: createHash("sha256").update(readFileSync(workflowPath)).digest("hex"),
    },
  };
  const created = createPluginPublicationArtifact({ ...common, artifactDir });
  const bytes = readFileSync(tarballPath);
  let existingBytes = bytes;
  if (mixed || fault === "archive-identity") {
    const existingRoot = join(root, "packed-existing");
    mkdirSync(join(existingRoot, "package"), { recursive: true });
    writeFileSync(
      join(existingRoot, "package/package.json"),
      JSON.stringify({ name: "@openclaw/existing", version }),
    );
    writeFileSync(
      join(existingRoot, "package/openclaw.plugin.json"),
      JSON.stringify({ id: "existing" }),
    );
    const existingTarball = join(root, "existing.tgz");
    await tar.c(
      {
        cwd: existingRoot,
        file: existingTarball,
        gzip: true,
        portable: true,
        noPax: true,
        mtime: new Date("1985-10-26T08:15:00Z"),
      },
      ["package/package.json", "package/openclaw.plugin.json"],
    );
    existingBytes = readFileSync(existingTarball);
  }
  const qualifiedZip = await zip({
    "demo.tgz": bytes,
    "plugin-publication-manifest.json": readFileSync(created.manifestPath),
  });
  const run = (id: number, attempt: number, completed = true, conclusion = "success") => ({
    id,
    run_attempt: attempt,
    path: workflowPath,
    event: "workflow_dispatch",
    head_sha: workflowSha,
    head_branch: "main",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    status: completed ? "completed" : "in_progress",
    conclusion: completed ? conclusion : null,
  });
  const job = (id: number, name: string, attempt: number, conclusion = "success") => ({
    id,
    name,
    run_id: runId,
    run_attempt: attempt,
    head_sha: workflowSha,
    status: "completed",
    conclusion,
  });
  const producerJobs = [job(1, preflightName, producerAttempt)];
  const publisher = {
    ...job(2, publisherName, publisherAttempt, replanned ? "failure" : "success"),
    steps:
      fault === "missing-upload-step"
        ? []
        : [
            {
              name: "Upload consumed npm qualification",
              status: "completed",
              conclusion: fault === "failed-upload-step" ? "failure" : "success",
            },
          ],
  };
  const planner = job(3, "preview_plugins_npm", plannerAttempt);
  const allJobs = [...producerJobs, publisher, planner];
  const metadata = (id: number, name: string, data: Buffer, producer: number) => ({
    id,
    name,
    digest: `sha256:${createHash("sha256").update(data).digest("hex")}`,
    size_in_bytes: data.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: producer, head_sha: workflowSha },
  });
  const qualifiedMetadata = metadata(41, artifactName, qualifiedZip, producerId);
  const metadataPath = join(root, "metadata.json");
  const runPath = join(root, "run.json");
  const jobsPath = join(root, "jobs.json");
  const zipPath = join(root, "qualified.zip");
  const receiptPath = join(root, "qualification.json");
  const producerRun = run(
    producerId,
    producerAttempt,
    mode === "prepared" || producerAttempt < publisherAttempt,
    mode === "prepared" ? "success" : "failure",
  );
  writeFileSync(metadataPath, JSON.stringify(qualifiedMetadata));
  writeFileSync(runPath, JSON.stringify(producerRun));
  writeFileSync(jobsPath, JSON.stringify({ total_count: producerJobs.length, jobs: producerJobs }));
  writeFileSync(zipPath, qualifiedZip);
  verifyPluginPublicationArtifact({
    ...common,
    repository,
    workflowPath,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: "main",
    workflowSha,
    runId: producerId,
    runAttempt: producerAttempt,
    consumerRunAttempt: publisherAttempt,
    producerJobName: preflightName,
    runStatePolicy: mode === "prepared" ? "completed-success" : "same-run-producer-success",
    artifactId: 41,
    artifactDigest: qualifiedMetadata.digest,
    artifactSizeBytes: qualifiedZip.length,
    artifactMetadataPath: metadataPath,
    workflowRunMetadataPath: runPath,
    workflowJobsMetadataPath: jobsPath,
    artifactZipPath: zipPath,
    outputDir: join(root, "consumed"),
    verificationOutput: receiptPath,
  });
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  expect(JSON.stringify(receipt)).not.toContain(root);
  expect(receipt).toMatchObject({ runId: producerId, runAttempt: producerAttempt, artifactId: 41 });
  if (fault === "source") {
    receipt.targetSha = "c".repeat(40);
  }
  if (fault === "attempt") {
    receipt.runAttempt = 99;
  }
  if (fault === "artifact") {
    receipt.artifactDigest = `sha256:${"f".repeat(64)}`;
  }
  const receiptZip = await zip({
    "demo-npm-qualification.json": Buffer.from(JSON.stringify(receipt)),
  });
  const receiptMetadata = metadata(
    42,
    `plugin-npm-qualification-demo-${runId}-${publisherAttempt}`,
    receiptZip,
    runId,
  );
  const selected = [{ packageName, packageDir: "extensions/demo", version }];
  if (mixed) {
    selected.push({
      packageName: "@openclaw/existing",
      packageDir: "extensions/existing",
      version,
    });
  }
  const candidates = noPublication
    ? []
    : fault === "existing-package"
      ? selected.slice(0, 1)
      : selected;
  const planZip = await zip({
    "npm-publication-plan.json": Buffer.from(
      JSON.stringify({
        sourceSha,
        all: selected,
        candidates,
        skippedPublished: selected.filter((entry) => !candidates.includes(entry)),
      }),
    ),
  });
  const planMetadata = metadata(43, `plugin-npm-plan-${runId}-${plannerAttempt}`, planZip, runId);
  const requests: string[] = [];
  const effectiveJobs =
    fault === "empty-jobs"
      ? []
      : noPublication
        ? [
            ...(replanned ? allJobs : [planner]),
            job(4, "Publish plugin npm package (${{ matrix.plugin.packageName }})", 1, "skipped"),
          ]
        : allJobs;
  const ghResponses: Record<string, string> = {};
  const respondGh = (endpoint: string) => {
    if (endpoint.endsWith(`/actions/runs/${runId}`)) {
      return JSON.stringify(run(runId, runAttempt));
    }
    if (endpoint.includes(`/actions/runs/${runId}/jobs?`)) {
      return JSON.stringify({ total_count: effectiveJobs.length, jobs: effectiveJobs });
    }
    if (endpoint.includes(`/actions/runs/${runId}/artifacts?`)) {
      const artifacts = [planMetadata, ...(fault === "missing-receipt" ? [] : [receiptMetadata])];
      return JSON.stringify({ total_count: artifacts.length, artifacts });
    }
    if (endpoint.includes("/attempts/") && endpoint.includes("/jobs?")) {
      const attempt = Number(endpoint.split("/attempts/")[1]?.split("/")[0]);
      const jobs = allJobs.filter((entry) => entry.run_attempt === attempt);
      return JSON.stringify({ total_count: jobs.length, jobs });
    }
    if (endpoint.endsWith(`/actions/runs/${producerId}/attempts/${producerAttempt}`)) {
      return JSON.stringify(
        run(
          producerId,
          producerAttempt,
          true,
          mode === "prepared" || producerAttempt === runAttempt ? "success" : "failure",
        ),
      );
    }
    if (endpoint.endsWith(`/actions/runs/${runId}/attempts/${publisherAttempt}`)) {
      return JSON.stringify(
        run(runId, publisherAttempt, true, publisherAttempt < runAttempt ? "failure" : "success"),
      );
    }
    if (endpoint.endsWith(`/actions/runs/${runId}/attempts/${plannerAttempt}`)) {
      return JSON.stringify(
        run(runId, plannerAttempt, true, plannerAttempt < runAttempt ? "failure" : "success"),
      );
    }
    if (endpoint.endsWith("/actions/artifacts/41")) {
      return JSON.stringify(qualifiedMetadata);
    }
    throw new Error(`Unexpected GitHub read: ${endpoint}`);
  };
  const runGh = (args: string[]) => {
    const endpoint = expectDefined(args[1], "GitHub fixture endpoint");
    const response = respondGh(endpoint);
    ghResponses[endpoint] = response;
    return response;
  };
  const transferResponses: Record<string, { status: number; bytes: string }> = {};
  const respondFetch = async (url: string) => {
    requests.push(url);
    if (url.endsWith("/artifacts/41/zip")) {
      return new Response(new Uint8Array(qualifiedZip));
    }
    if (url.endsWith("/artifacts/42/zip")) {
      return new Response(new Uint8Array(receiptZip));
    }
    if (url.endsWith("/artifacts/43/zip")) {
      return new Response(new Uint8Array(planZip));
    }
    if (url.endsWith("/artifacts/41")) {
      return Response.json(qualifiedMetadata);
    }
    if (url.endsWith("/artifacts/42")) {
      return Response.json(receiptMetadata);
    }
    if (url.endsWith("/artifacts/43")) {
      return Response.json(planMetadata);
    }
    if (url.endsWith(".tgz")) {
      if (fault === "missing-tarball") {
        return new Response(null, { status: 404 });
      }
      return new Response(
        fault === "conflicting-bytes"
          ? Buffer.alloc(bytes.length)
          : url.endsWith("/existing.tgz") || fault === "archive-identity"
            ? existingBytes
            : bytes,
      );
    }
    if (url.startsWith("https://registry.npmjs.org/")) {
      const name = decodeURIComponent(url).endsWith("/@openclaw/existing")
        ? "@openclaw/existing"
        : packageName;
      const registryBytes =
        name === "@openclaw/existing" || fault === "archive-identity" ? existingBytes : bytes;
      return Response.json({
        name,
        "dist-tags": { beta: version },
        versions: {
          [version]: {
            name,
            version,
            dist: {
              integrity: `sha512-${createHash("sha512").update(registryBytes).digest("base64")}`,
              shasum: createHash("sha1").update(registryBytes).digest("hex"),
              tarball: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}.tgz`,
            },
          },
        },
      });
    }
    throw new Error(`Unexpected transfer: ${url}`);
  };
  const fetchImpl = async (url: string) => {
    const response = await respondFetch(url);
    transferResponses[url] = {
      status: response.status,
      bytes: Buffer.from(await response.clone().arrayBuffer()).toString("base64"),
    };
    return response;
  };
  return {
    root,
    ghResponses,
    transferResponses,
    requests,
    producerId,
    producerAttempt,
    publisherAttempt,
    receipt,
    options: {
      repository,
      runId,
      sourceSha,
      workflowSha,
      workflowRef: "main",
      sourceRoot: root,
      cacheDir: join(root, "parent"),
      token: "synthetic-token",
      runGh,
      fetchImpl,
    },
  };
}
