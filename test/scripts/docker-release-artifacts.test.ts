import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  dockerReleaseArtifactName,
  preparedDockerEvidenceFromFullRelease,
  publishDockerRelease,
  sealDockerRelease,
  validateDockerReleaseIdentity,
  validateDockerReleaseManifest,
  verifyDockerReleaseLayout,
  verifyDockerReleaseProducer,
  verifyPreparedDockerReleaseManifest,
} from "../../scripts/docker-release-artifacts.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  candidatePublicationFixture,
  dockerArtifactPermissionProof,
} from "./candidate-publication.test-support.js";

const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const repository = "openclaw/openclaw";
const runId = "100";
const runAttempt = "2";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mediaType = "application/vnd.oci.image.manifest.v1+json";
const indexMediaType = "application/vnd.oci.image.index.v1+json";

function temporaryDirectory() {
  return tempDirs.make("openclaw-docker-artifacts-");
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function createLayout(
  directory: string,
  architecture: string,
  options: { labelSha?: string; provenance?: boolean; version?: string; builtAt?: string } = {},
) {
  function blob(value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const file = path.join(directory, "blobs", "sha256", digest);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return { digest: `sha256:${digest}`, size: bytes.length };
  }
  const config = blob({
    architecture,
    os: "linux",
    rootfs: { type: "layers", diff_ids: [] },
    config: {
      Labels: {
        "org.opencontainers.image.revision": options.labelSha ?? sourceSha,
        "org.opencontainers.image.version": options.version ?? "2026.8.1-beta.2",
        "org.opencontainers.image.created": options.builtAt ?? "2026-09-01T00:00:00.000Z",
      },
    },
  });
  const image = blob({
    schemaVersion: 2,
    mediaType,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
    layers: [],
  });
  const predicates = [
    "https://spdx.dev/Document",
    ...(options.provenance === false ? [] : ["https://slsa.dev/provenance/v1"]),
  ];
  const attestation = blob({
    schemaVersion: 2,
    mediaType,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...blob({}) },
    layers: predicates.map((predicateType) =>
      Object.assign(
        blob({ predicateType, subject: [{ digest: { sha256: image.digest.slice(7) } }] }),
        {
          mediaType: "application/vnd.in-toto+json",
          annotations: { "in-toto.io/predicate-type": predicateType },
        },
      ),
    ),
  });
  const manifests = [
    { mediaType, ...image, platform: { os: "linux", architecture } },
    {
      mediaType,
      ...attestation,
      platform: { os: "unknown", architecture: "unknown" },
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": image.digest,
      },
    },
  ];
  const index = blob({ schemaVersion: 2, mediaType: indexMediaType, manifests });
  writeJson(path.join(directory, "oci-layout"), { imageLayoutVersion: "1.0.0" });
  writeJson(path.join(directory, "index.json"), {
    schemaVersion: 2,
    manifests: [{ mediaType: indexMediaType, ...index }],
  });
  return {
    indexDigest: index.digest,
    imageDigest: image.digest,
    configDigest: config.digest,
    manifests,
  };
}

async function createPreparedRelease(includeBrowser = true, version = "2026.8.1-beta.2") {
  const root = temporaryDirectory();
  const artifactName = dockerReleaseArtifactName(sourceSha, runAttempt);
  const context = {
    schemaVersion: 1,
    repository,
    sourceSha,
    toolingSha,
    tag: `v${version}`,
    version,
    imageTagSuffix: "-r20260901",
    builtAt: "2026-09-01T00:00:00.000Z",
    includeBrowser,
    artifactPlan: { sourceSha, state: "required" },
    producer: {
      runId,
      runAttempt,
      workflowRef: `${repository}/.github/workflows/full-release-validation.yml@refs/heads/main`,
      workflowSha: toolingSha,
      preparationWorkflowRef: `${repository}/.github/workflows/docker-release-prepare.yml@refs/heads/main`,
    },
  };
  const artifacts = ["amd64", "arm64"].map((architecture, index) => ({
    id: index + 10,
    name: `${artifactName}-${architecture}`,
    digest: `sha256:${String(index + 1).repeat(64)}`,
    expired: false,
    size_in_bytes: 1024,
    workflow_run: { id: Number(runId), head_sha: toolingSha },
  }));
  const job = {
    id: 7,
    run_id: Number(runId),
    run_attempt: Number(runAttempt),
    name: "Prepare Docker / Seal prepared Docker images",
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/7`,
    status: "completed",
    conclusion: "success",
    head_sha: toolingSha,
  };
  const run = {
    id: Number(runId),
    run_attempt: Number(runAttempt),
    path: ".github/workflows/full-release-validation.yml",
    head_branch: "main",
    head_sha: toolingSha,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null as string | null,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    referenced_workflows: [
      {
        path: `${repository}/.github/workflows/docker-release-prepare.yml@${toolingSha}`,
        sha: toolingSha,
        ref: "refs/heads/main",
      },
    ],
  };
  const attemptRun = structuredClone(run);
  const readApi = (endpoint: string) => {
    if (endpoint.includes("/artifacts?")) {
      return { artifacts: artifacts.filter((artifact) => endpoint.includes(artifact.name)) };
    }
    if (endpoint.includes("/compare/")) {
      return { status: "identical" };
    }
    if (endpoint.endsWith("/actions/jobs/7")) {
      return job;
    }
    if (endpoint.includes("/jobs?")) {
      return {
        jobs: [
          job,
          {
            ...job,
            id: 8,
            check_run_url: `https://api.github.com/repos/${repository}/check-runs/8`,
          },
        ],
        total_count: 2,
      };
    }
    if (endpoint.endsWith(`/actions/runs/${runId}/attempts/${runAttempt}`)) {
      return attemptRun;
    }
    if (endpoint.endsWith(`/actions/runs/${runId}`)) {
      return run;
    }
    throw new Error(`Unexpected API read: ${endpoint}`);
  };
  for (const architecture of ["amd64", "arm64"]) {
    const images = [];
    for (const variant of includeBrowser ? ["default", "browser"] : ["default"]) {
      const directory = path.join(root, "payloads", `${artifactName}-${architecture}`, variant);
      const image = createLayout(directory, architecture, { version });
      const verified = await verifyDockerReleaseLayout({
        ...context,
        directory,
        architecture,
        expectedDigest: image.indexDigest,
      });
      images.push({
        variant,
        ...verified,
        artifactPermissions: dockerArtifactPermissionProof(
          verified.configDigest,
          variant === "browser",
        ),
        smoke: "success",
        attestations: "success",
      });
    }
    writeJson(path.join(root, "metadata", `${architecture}.json`), {
      ...context,
      architecture,
      images,
    });
  }
  const manifest = sealDockerRelease({
    metadataDirectory: path.join(root, "metadata"),
    context,
    checkRunId: "7",
    readApi,
  });
  return { root, manifest, run, attemptRun, job, artifacts, readApi };
}

async function createPublicationRetry(conclusion = "failure") {
  const fixture = await createPreparedRelease(false);
  const workflow = ".github/workflows/openclaw-release-publish.yml";
  fixture.manifest.producer.workflowRef = `${repository}/${workflow}@refs/heads/main`;
  fixture.run.path = fixture.attemptRun.path = workflow;
  fixture.attemptRun.status = "completed";
  fixture.attemptRun.conclusion = conclusion;
  fixture.run.run_attempt += 1;
  fixture.run.referenced_workflows = [];
  return {
    ...fixture,
    publisher: {
      publisherSha: toolingSha,
      publisherRunId: runId,
      publisherRunAttempt: String(fixture.run.run_attempt),
      readApi: fixture.readApi,
    },
  };
}

function preparedReleaseIdentity(
  manifest: Awaited<ReturnType<typeof createPreparedRelease>>["manifest"],
) {
  return {
    repository,
    sourceSha,
    tag: manifest.tag,
    imageTagSuffix: manifest.imageTagSuffix,
    artifactName: manifest.artifactName,
    runId,
    runAttempt,
  };
}

const historicalDockerContracts = [
  {
    revision: "a162944f",
    owner: "f512cbff44fc16568c8740bdbb6315824f448215",
    workflow: "06269c7599f281b1d416601a9bf752a58d8e4613",
  },
  {
    revision: "7a61192d",
    owner: "f512cbff44fc16568c8740bdbb6315824f448215",
    workflow: "dc56a33fcd8ebb037eb91b79b01110682682cc11",
  },
  {
    revision: "6e5bac0d",
    owner: "f512cbff44fc16568c8740bdbb6315824f448215",
    workflow: "785a8c3fc03ab95f5969dea3a6d2df8f6190249d",
  },
  {
    revision: "739a3355",
    owner: "f512cbff44fc16568c8740bdbb6315824f448215",
    workflow: "ea86c308fda8c954840009b2fc145fb6eb154cc3",
  },
  {
    revision: "69aeafae",
    owner: "7fb1de96c277e1cf93441edc3f0fc17f4b9f010c",
    workflow: "ea86c308fda8c954840009b2fc145fb6eb154cc3",
  },
  {
    revision: "06f897f5",
    owner: "82e4665d1bdc7f8bb966d3a5d0ed5aecc08e5c46",
    workflow: "ea86c308fda8c954840009b2fc145fb6eb154cc3",
  },
  {
    revision: "164e18ea",
    owner: "82e4665d1bdc7f8bb966d3a5d0ed5aecc08e5c46",
    workflow: "009354c99b99d4953d6846cde5f58d7381adbfbc",
  },
  {
    revision: "9ed5a04a",
    owner: "82e4665d1bdc7f8bb966d3a5d0ed5aecc08e5c46",
    workflow: "aa2bb94f2d87c70a797ac279e6ea1181d7674204",
  },
  {
    revision: "73788ab0",
    owner: "82e4665d1bdc7f8bb966d3a5d0ed5aecc08e5c46",
    workflow: "7119fa50de1c65539d970aa293ae51a7c02f9c9c",
  },
  {
    revision: "7dbfab8c",
    owner: "82e4665d1bdc7f8bb966d3a5d0ed5aecc08e5c46",
    workflow: "a78011d4f50492b6075d86fbd9c405ec2eed7d55",
  },
  {
    revision: "eac43f0c",
    owner: "82e4665d1bdc7f8bb966d3a5d0ed5aecc08e5c46",
    workflow: "e5d6d39895c3c168a951941bfe3a9fae3a5e6004",
  },
  {
    revision: "ebdab59f",
    owner: "82e4665d1bdc7f8bb966d3a5d0ed5aecc08e5c46",
    workflow: "fc1d82263241687ae9f4719d6174e244cbdcd618",
  },
  {
    revision: "2abecd70",
    owner: "82e4665d1bdc7f8bb966d3a5d0ed5aecc08e5c46",
    workflow: "e260a50ccf567135c3a3be6593866c8e2eddc7c8",
  },
  {
    revision: "38740f23",
    owner: "7772cdde1721e8930eac47d058d5c2cc1b9ce1b7",
    workflow: "e260a50ccf567135c3a3be6593866c8e2eddc7c8",
  },
];

function historicalDockerContractTree(contract = historicalDockerContracts.at(-1)!) {
  // Exact immutable blobs of the reviewed pre-permission producer, not flags in
  // the saved receipt. The negative cases replace either of these source blobs.
  return {
    truncated: false,
    tree: [
      {
        path: "scripts/docker-release-artifacts.mjs",
        type: "blob",
        mode: "100755",
        sha: contract.owner,
      },
      {
        path: ".github/workflows/docker-release-prepare.yml",
        type: "blob",
        mode: "100644",
        sha: contract.workflow,
      },
    ],
  };
}

function removePermissionReceipt(
  manifest: Awaited<ReturnType<typeof createPreparedRelease>>["manifest"],
) {
  delete manifest.artifactPlan;
  for (const entry of manifest.architectures) {
    for (const image of entry.images) {
      delete image.artifactPermissions;
    }
  }
}

function createRegistry({
  root,
  manifest,
}: Pick<Awaited<ReturnType<typeof createPreparedRelease>>, "root" | "manifest">) {
  const indexes = new Map<string, { digest: string; manifests: unknown[] }>();
  for (const entry of manifest.architectures) {
    for (const image of entry.images) {
      indexes.set(image.indexDigest, { digest: image.indexDigest, manifests: image.manifests });
    }
  }
  const tags = new Map<string, string>();
  const calls: string[][] = [];
  const execute = vi.fn((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    if (command === "skopeo") {
      const directory = args[3]!.slice(4);
      const descriptor = JSON.parse(readFileSync(path.join(directory, "index.json"), "utf8"))
        .manifests[0];
      tags.set(args[4]!.slice("docker://".length), descriptor.digest);
      return "";
    }
    if (args[2] === "create") {
      const refs = args.filter((arg) => arg.includes("@sha256:"));
      let digest = refs[0]!.split("@")[1]!;
      if (refs.length > 1) {
        const descriptors = refs.flatMap((ref) => indexes.get(ref.split("@")[1]!)!.manifests);
        digest = `sha256:${createHash("sha256").update(JSON.stringify(descriptors)).digest("hex")}`;
        indexes.set(digest, { digest, manifests: descriptors });
      }
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--tag") {
          tags.set(args[index + 1]!, digest);
        }
      }
      return "";
    }
    if (args.includes("--format")) {
      if (args.at(-1)?.includes(".Image")) {
        return JSON.stringify({
          config: { Labels: { "org.opencontainers.image.version": manifest.version } },
        });
      }
      return JSON.stringify({ digest: tags.get(args[3]!) });
    }
    const digest = args[4]!.split("@")[1]!;
    const index = indexes.get(digest);
    if (index) {
      return JSON.stringify({
        schemaVersion: 2,
        mediaType: indexMediaType,
        manifests: index.manifests,
      });
    }
    for (const entry of manifest.architectures) {
      for (const image of entry.images) {
        const descriptor = image.manifests.find(
          (candidate: { digest: string }) => candidate.digest === digest,
        );
        if (descriptor) {
          return readFileSync(
            path.join(
              root,
              "payloads",
              entry.artifact.name,
              image.variant,
              "blobs",
              "sha256",
              digest.slice(7),
            ),
            "utf8",
          );
        }
      }
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  });
  return { execute, calls, tags };
}

async function createCandidateDockerPublication(recovered = false) {
  const fixture = candidatePublicationFixture();
  const root = temporaryDirectory();
  for (const entry of fixture.docker.architectures) {
    const directory = path.join(root, "payloads", entry.artifact.name, "default");
    Object.assign(
      entry.images[0]!,
      createLayout(directory, entry.architecture, {
        labelSha: fixture.q,
        version: fixture.docker.version,
        builtAt: fixture.docker.builtAt,
      }),
    );
    entry.images[0]!.artifactPermissions = dockerArtifactPermissionProof(
      entry.images[0]!.configDigest,
      false,
      fixture.q,
    );
  }
  const bytes = JSON.stringify(fixture.docker, null, 2) + "\n";
  Object.assign(fixture.manifest.publicationArtifacts.docker, {
    preparedManifestSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const originalRun = structuredClone(fixture.parent);
  const currentRun = recovered
    ? { ...originalRun, run_attempt: 2, status: "in_progress", conclusion: null }
    : originalRun;
  const verified = await verifyDockerReleaseProducer(fixture.docker, {
    publisherSha: fixture.p,
    publisherFullRef: fixture.publisherFullRef,
    fullReleaseManifest: fixture.manifest,
    evidenceClient: fixture.client,
    readApi: (endpoint: string) =>
      endpoint.endsWith("/actions/runs/" + fixture.runId)
        ? currentRun
        : endpoint.endsWith("/actions/runs/" + fixture.runId + "/attempts/1")
          ? originalRun
          : fixture.readApi(endpoint),
  });
  return {
    fixture,
    root,
    verified,
    bytes,
    registry: createRegistry({ root, manifest: fixture.docker }),
  };
}

function registryWrites(calls: string[][]) {
  return calls.filter((call) => call[0] === "skopeo" || call[3] === "create");
}

describe("prepared Docker publication", () => {
  it.each(["authenticated historical", "current stripped", "changed frozen bytes"])(
    "uses authenticated receipt recovery in the newer verify CLI: %s",
    async (kind) => {
      const fixture = await createPreparedRelease(false);
      removePermissionReceipt(fixture.manifest);
      const manifestFile = path.join(fixture.root, "manifest.json");
      const frozen = JSON.stringify(fixture.manifest, null, 2) + "\n";
      writeFileSync(manifestFile, frozen);
      const digest = createHash("sha256").update(frozen).digest("hex");
      const tree = historicalDockerContractTree();
      if (kind === "current stripped") {
        tree.tree[0]!.sha = "c".repeat(40);
      }
      if (kind === "changed frozen bytes") {
        writeFileSync(manifestFile, frozen + "\n");
      }
      const responses: Record<string, unknown> = {
        [`repos/${repository}/actions/runs/${runId}`]: fixture.run,
        [`repos/${repository}/actions/jobs/7`]: fixture.job,
        [`repos/${repository}/compare/${toolingSha}...main`]: { status: "ahead" },
        [`repos/${repository}/compare/${toolingSha}...${"c".repeat(40)}`]: { status: "ahead" },
        [`repos/${repository}/git/trees/${toolingSha}?recursive=1`]: tree,
      };
      for (const artifact of fixture.artifacts) {
        responses[
          `repos/${repository}/actions/runs/${runId}/artifacts?name=${artifact.name}&per_page=100`
        ] = { artifacts: [artifact] };
      }
      const responseFile = path.join(fixture.root, "api-responses.json");
      writeJson(responseFile, responses);
      const bin = path.join(fixture.root, "bin");
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, "gh"),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'api' || args[2] !== '--method' || args[3] !== 'GET') throw new Error('Unexpected GitHub command');
const responses = JSON.parse(fs.readFileSync(process.env.DOCKER_RECOVERY_TEST_RESPONSES, 'utf8'));
if (!Object.hasOwn(responses, args[1])) throw new Error('Unexpected API endpoint: ' + args[1]);
process.stdout.write(JSON.stringify(responses[args[1]]));
`,
        { mode: 0o755 },
      );
      const outputFile = path.join(fixture.root, "github-output");
      writeFileSync(outputFile, "");
      const result = spawnSync(
        process.execPath,
        [
          "scripts/docker-release-artifacts.mjs",
          "verify",
          "--manifest",
          manifestFile,
          "--manifest-sha256",
          digest,
          "--artifact-name",
          fixture.manifest.artifactName,
          "--run-id",
          runId,
          "--run-attempt",
          runAttempt,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            DOCKER_RECOVERY_TEST_RESPONSES: responseFile,
            GITHUB_REPOSITORY: repository,
            GITHUB_WORKFLOW_SHA: "c".repeat(40),
            GITHUB_OUTPUT: outputFile,
            RELEASE_SHA: sourceSha,
            RELEASE_TAG: fixture.manifest.tag,
            IMAGE_TAG_SUFFIX: fixture.manifest.imageTagSuffix,
            INCLUDE_BROWSER: "false",
          },
        },
      );
      if (kind === "authenticated historical") {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(outputFile, "utf8")).toBe("artifact_ids=10,11\n");
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          kind === "current stripped"
            ? "authenticated historical producer contract"
            : "digest mismatch",
        );
        expect(readFileSync(outputFile, "utf8")).toBe("");
      }
      expect(readFileSync(manifestFile, "utf8")).toBe(
        kind === "changed frozen bytes" ? frozen + "\n" : frozen,
      );
    },
  );

  it.each(
    historicalDockerContracts.flatMap((contract) =>
      [false, true].map((includeBrowser) => ({ contract, includeBrowser })),
    ),
  )(
    "recovers frozen historical $contract.revision receipts on newer tooling with browser=$includeBrowser",
    async ({ contract, includeBrowser }) => {
      const fixture = await createPreparedRelease(includeBrowser);
      removePermissionReceipt(fixture.manifest);
      fixture.run.status = "completed";
      fixture.run.conclusion = "success";
      Object.assign(fixture.attemptRun, fixture.run);
      fixture.run.run_attempt += 1;
      const receiptPath = path.join(fixture.root, "saved-manifest.json");
      const frozenBytes = JSON.stringify(fixture.manifest, null, 2) + "\n";
      writeFileSync(receiptPath, frozenBytes);
      const frozenDigest = createHash("sha256").update(frozenBytes).digest("hex");
      const originalPayloads = fixture.manifest.architectures.map(
        (entry: { artifact: unknown; images: unknown }) => ({
          artifact: structuredClone(entry.artifact),
          images: structuredClone(entry.images),
        }),
      );
      const readApi = vi.fn((endpoint: string) =>
        endpoint === `repos/${repository}/git/trees/${toolingSha}?recursive=1`
          ? historicalDockerContractTree(contract)
          : fixture.readApi(endpoint),
      );
      const expected = preparedReleaseIdentity(fixture.manifest);
      // Ordinary sealing must never mint a new smoke-only receipt.
      expect(() => validateDockerReleaseManifest(fixture.manifest, expected)).toThrow(
        "source artifact-plan qualification",
      );
      const verified = await verifyPreparedDockerReleaseManifest(
        JSON.parse(readFileSync(receiptPath, "utf8")),
        expected,
        { publisherSha: "c".repeat(40), readApi },
      );
      const registry = createRegistry({ root: fixture.root, manifest: verified.manifest });
      await publishDockerRelease({
        ...verified,
        payloadDirectory: path.join(fixture.root, "payloads"),
        images: ["ghcr.io/openclaw/openclaw"],
        execFileSyncImpl: registry.execute,
        verifyTag: vi.fn(),
      });
      expect(JSON.stringify(verified.manifest, null, 2) + "\n").toBe(frozenBytes);
      expect(readFileSync(receiptPath, "utf8")).toBe(frozenBytes);
      expect(createHash("sha256").update(readFileSync(receiptPath)).digest("hex")).toBe(
        frozenDigest,
      );
      expect(verified.manifest.producer.runAttempt).toBe(runAttempt);
      expect(
        verified.manifest.architectures.map((entry: { artifact: unknown; images: unknown }) => ({
          artifact: entry.artifact,
          images: entry.images,
        })),
      ).toEqual(originalPayloads);
      expect(readApi).toHaveBeenCalledWith(
        `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
      );
      expect(readApi).toHaveBeenCalledWith(
        `repos/${repository}/git/trees/${toolingSha}?recursive=1`,
      );
      for (const entry of verified.manifest.architectures) {
        for (const image of entry.images) {
          const suffix = image.variant === "browser" ? "-browser" : "";
          expect(
            registry.tags.get(
              `ghcr.io/openclaw/openclaw:${verified.manifest.version}${verified.manifest.imageTagSuffix}${suffix}-${entry.architecture}`,
            ),
          ).toBe(image.indexDigest);
        }
      }
    },
  );

  it.each([
    "current owner with both permission fields stripped",
    "changed preparation workflow",
    "mixed historical contracts",
    "truncated source tree",
    "duplicate source blob",
    "symlink owner",
    "missing owner",
    "unauthenticated producer",
    "untrusted tooling ancestry",
    "failed seal",
    "changed artifact digest",
    "missing historical smoke",
    "permission-plan only",
    "permission-proof only",
  ])("rejects historical downgrade with %s", async (failure) => {
    const fixture = await createPreparedRelease(false);
    const original = structuredClone(fixture.manifest);
    removePermissionReceipt(fixture.manifest);
    const tree = historicalDockerContractTree();
    if (failure === "current owner with both permission fields stripped") {
      tree.tree[0]!.sha = "c".repeat(40);
    }
    if (failure === "changed preparation workflow") {
      tree.tree[1]!.sha = "c".repeat(40);
    }
    if (failure === "mixed historical contracts") {
      tree.tree[0]!.sha = historicalDockerContracts[0]!.owner;
    }
    if (failure === "truncated source tree") {
      tree.truncated = true;
    }
    if (failure === "duplicate source blob") {
      tree.tree.push({ ...tree.tree[0]! });
    }
    if (failure === "symlink owner") {
      tree.tree[0]!.mode = "120000";
    }
    if (failure === "missing owner") {
      tree.tree.shift();
    }
    if (failure === "unauthenticated producer") {
      fixture.run.head_repository.full_name = "example/forged";
    }
    if (failure === "failed seal") {
      fixture.job.conclusion = "failure";
    }
    if (failure === "changed artifact digest") {
      fixture.artifacts[1]!.digest = `sha256:${"f".repeat(64)}`;
    }
    if (failure === "missing historical smoke") {
      delete fixture.manifest.architectures[1].images[0].smoke;
    }
    if (failure === "permission-plan only") {
      fixture.manifest.artifactPlan = original.artifactPlan;
    }
    if (failure === "permission-proof only") {
      fixture.manifest.architectures[0].images[0].artifactPermissions =
        original.architectures[0].images[0].artifactPermissions;
    }
    const frozen = JSON.stringify(fixture.manifest);
    const readApi = vi.fn((endpoint: string) =>
      endpoint.includes("/git/trees/")
        ? tree
        : failure === "untrusted tooling ancestry" && endpoint.includes("/compare/")
          ? { status: "behind" }
          : fixture.readApi(endpoint),
    );
    await expect(
      verifyPreparedDockerReleaseManifest(
        fixture.manifest,
        preparedReleaseIdentity(fixture.manifest),
        { publisherSha: "c".repeat(40), readApi },
      ),
    ).rejects.toThrow();
    expect(JSON.stringify(fixture.manifest)).toBe(frozen);
    if (
      [
        "unauthenticated producer",
        "untrusted tooling ancestry",
        "failed seal",
        "changed artifact digest",
      ].includes(failure)
    ) {
      expect(readApi.mock.calls.some(([endpoint]) => endpoint.includes("/git/trees/"))).toBe(false);
    }
  });

  it("keeps modern proof strict on authenticated recovery without a historical lookup", async () => {
    const fixture = await createPreparedRelease(false);
    const readApi = vi.fn(fixture.readApi);
    const expected = preparedReleaseIdentity(fixture.manifest);
    const verified = await verifyPreparedDockerReleaseManifest(fixture.manifest, expected, {
      publisherSha: toolingSha,
      readApi,
    });
    expect(verified.manifest).toBe(fixture.manifest);
    expect(readApi.mock.calls.some(([endpoint]) => endpoint.includes("/git/trees/"))).toBe(false);
    fixture.manifest.architectures[1].images[0].artifactPermissions.cells.pop();
    readApi.mockClear();
    await expect(
      verifyPreparedDockerReleaseManifest(fixture.manifest, expected, {
        publisherSha: toolingSha,
        readApi,
      }),
    ).rejects.toThrow("arbitrary-UID artifact/runtime proof");
    expect(readApi).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "publishes authenticated candidate bytes with original-attempt recovery=%s",
    async (recovered) => {
      const { fixture, root, verified, bytes, registry } =
        await createCandidateDockerPublication(recovered);
      const images = ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"];
      const output = await publishDockerRelease({
        manifest: fixture.docker,
        revalidateAuthority: verified.revalidateAuthority,
        payloadDirectory: path.join(root, "payloads"),
        images,
        execFileSyncImpl: registry.execute,
        verifyTag: vi.fn(),
      });
      expect(JSON.stringify(verified.manifest, null, 2) + "\n").toBe(bytes);
      expect(verified.manifest.producer.runAttempt).toBe("1");
      const version = fixture.docker.version;
      expect([...registry.tags.keys()]).toEqual([
        ...["amd64", "arm64"].flatMap((arch) =>
          images.flatMap((image) => [
            image + ":" + version + "-" + arch,
            image + ":" + version + "-slim-" + arch,
          ]),
        ),
        ...images.flatMap((image) => [image + ":" + version, image + ":" + version + "-slim"]),
      ]);
      expect(registryWrites(registry.calls)).toHaveLength(10);
      expect(output.split("\n")).toEqual(
        ["default", "slim"].map(
          (variant) => variant + "=" + registry.tags.get(images[0] + ":" + version),
        ),
      );
    },
  );

  it.each(["acquisition", "async OCI read", "final tag read"])(
    "blocks candidate publication when authority is revoked during %s",
    async (boundary) => {
      const { fixture, root, verified, registry } = await createCandidateDockerPublication();
      if (boundary === "acquisition") {
        fixture.admission.authority.permission = "read";
      }
      const verifyTag = vi.fn(() => {
        if (boundary === "final tag read") {
          fixture.admission.authority.permission = "read";
        }
      });
      const publication = publishDockerRelease({
        manifest: fixture.docker,
        revalidateAuthority: verified.revalidateAuthority,
        payloadDirectory: path.join(root, "payloads"),
        images: ["ghcr.io/openclaw/openclaw"],
        execFileSyncImpl: registry.execute,
        verifyTag,
      });
      if (boundary === "async OCI read") {
        expect(verifyTag).not.toHaveBeenCalled();
        fixture.admission.authority.permission = "read";
      }
      await expect(publication).rejects.toThrow(/permission|authority|operator/i);
      expect(verifyTag).toHaveBeenCalledOnce();
      expect(registryWrites(registry.calls)).toEqual([]);
    },
  );

  it.each([
    ["copy to slim tag", 1],
    ["registry", 2],
    ["architecture", 4],
    ["multiarch index", 8],
    ["combined registry", 9],
  ] as const)(
    "stops candidate writes across the %s boundary after P moves",
    async (_boundary, completedWrites) => {
      const { fixture, root, verified, registry } = await createCandidateDockerPublication(true);
      let prefix: string[][] = [];
      const execute = (command: string, args: readonly string[]) => {
        const result = registry.execute(command, args);
        const writes = registryWrites(registry.calls);
        if (command === "docker" && args[2] === "inspect" && writes.length === completedWrites) {
          prefix = writes;
          fixture.admission.authority.tagSha = "c".repeat(40);
        }
        return result;
      };
      await expect(
        publishDockerRelease({
          manifest: fixture.docker,
          revalidateAuthority: verified.revalidateAuthority,
          payloadDirectory: path.join(root, "payloads"),
          images: ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"],
          execFileSyncImpl: execute,
          verifyTag: vi.fn(),
        }),
      ).rejects.toThrow(/tag|publisher|admission|authority/i);
      expect(prefix).toHaveLength(completedWrites);
      expect(registryWrites(registry.calls)).toEqual(prefix);
    },
  );

  it.each(["alias preflight", "first alias", "allowed"])(
    "carries publication authority into real channel promotion: %s",
    async (boundary) => {
      const { root, manifest } = await createPreparedRelease(false, "2026.8.1");
      const registry = createRegistry({ root, manifest });
      let revoked = false;
      const execute = (command: string, args: readonly string[]) => {
        const output = registry.execute(command, args);
        if (boundary === "alias preflight" && args.at(-1)?.includes(".Image")) {
          revoked = true;
        }
        if (
          boundary === "first alias" &&
          args[2] === "create" &&
          args.includes("ghcr.io/openclaw/openclaw:latest")
        ) {
          revoked = true;
        }
        return output;
      };
      const publication = publishDockerRelease({
        manifest,
        revalidateAuthority: () => {
          if (revoked) {
            throw new Error("Publication authority revoked");
          }
        },
        payloadDirectory: path.join(root, "payloads"),
        images: ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"],
        execFileSyncImpl: execute,
        verifyTag: vi.fn(),
      });
      if (boundary === "allowed") {
        await publication;
        expect(registryWrites(registry.calls)).toHaveLength(14);
        expect(registry.tags.size).toBe(20);
      } else {
        await expect(publication).rejects.toThrow("Publication authority revoked");
        expect(registryWrites(registry.calls)).toHaveLength(
          boundary === "alias preflight" ? 10 : 11,
        );
        expect(registry.tags.has("ghcr.io/openclaw/openclaw:slim")).toBe(false);
      }
    },
  );

  it.each(["full-release-validation", "full-release-artifacts"])(
    "binds native builds to exact artifacts and the %s seal job",
    async (workflow) => {
      const fixture = await createPreparedRelease();
      fixture.run.path = `.github/workflows/${workflow}.yml`;
      fixture.manifest.producer.workflowRef = `${repository}/${fixture.run.path}@refs/heads/main`;
      const { manifest } = await verifyDockerReleaseProducer(fixture.manifest, {
        publisherSha: toolingSha,
        readApi: fixture.readApi,
      });
      expect(manifest.producer.jobId).toBe("7");
      expect(
        manifest.architectures.map((entry: { architecture: string }) => entry.architecture),
      ).toEqual(["amd64", "arm64"]);
      expect(
        manifest.architectures.flatMap((entry: { images: { variant: string }[] }) =>
          entry.images.map((image) => image.variant),
        ),
      ).toEqual(["default", "browser", "default", "browser"]);
      fixture.run.status = "completed";
      fixture.run.conclusion = "success";
      expect(
        (
          await verifyDockerReleaseProducer(manifest, {
            publisherSha: toolingSha,
            readApi: fixture.readApi,
          })
        ).manifest,
      ).toBe(manifest);
    },
  );

  it.each(["failure", "cancelled", "timed_out"])(
    "reuses its successful preparation when retrying a %s publication attempt",
    async (conclusion) => {
      const fixture = await createPublicationRetry(conclusion);
      expect(
        (await verifyDockerReleaseProducer(fixture.manifest, fixture.publisher)).manifest,
      ).toBe(fixture.manifest);
    },
  );

  it.each([
    "unrelated publisher",
    "stale publisher attempt",
    "different publisher source",
    "failed current parent",
    "changed historical source",
    "wrong historical attempt",
    "changed historical workflow",
    "missing historical preparation",
    "failed seal",
    "replaced artifact",
  ])("rejects a publication retry with %s", async (failure) => {
    const fixture = await createPublicationRetry();
    if (failure === "unrelated publisher") {
      fixture.publisher.publisherRunId = "200";
    }
    if (failure === "stale publisher attempt") {
      fixture.publisher.publisherRunAttempt = runAttempt;
    }
    if (failure === "different publisher source") {
      fixture.publisher.publisherSha = sourceSha;
    }
    if (failure === "failed current parent") {
      fixture.run.status = "completed";
      fixture.run.conclusion = "failure";
    }
    if (failure === "changed historical source") {
      fixture.attemptRun.head_sha = sourceSha;
    }
    if (failure === "wrong historical attempt") {
      fixture.attemptRun.run_attempt += 1;
    }
    if (failure === "changed historical workflow") {
      fixture.attemptRun.path = ".github/workflows/ci.yml";
    }
    if (failure === "missing historical preparation") {
      fixture.attemptRun.referenced_workflows = [];
    }
    if (failure === "failed seal") {
      fixture.job.conclusion = "failure";
    }
    if (failure === "replaced artifact") {
      fixture.artifacts[0]!.id += 100;
    }
    await expect(
      verifyDockerReleaseProducer(fixture.manifest, fixture.publisher),
    ).rejects.toThrow();
  });

  it("retains successful historical preparation for an unrelated publisher", async () => {
    const fixture = await createPublicationRetry("success");
    fixture.publisher.publisherRunId = "200";
    expect((await verifyDockerReleaseProducer(fixture.manifest, fixture.publisher)).manifest).toBe(
      fixture.manifest,
    );
  });

  it.each([
    "unfinished job",
    "failed parent",
    "unfinished historical attempt",
    "different tooling",
    "replaced artifact",
    "wrong workflow",
  ])("rejects %s evidence", async (failure) => {
    const fixture = await createPreparedRelease(false);
    if (failure === "unfinished job") {
      fixture.job.status = "in_progress";
    }
    if (failure === "failed parent") {
      fixture.run.status = "completed";
      fixture.run.conclusion = "failure";
    }
    if (failure === "unfinished historical attempt") {
      fixture.run.run_attempt += 1;
    }
    if (failure === "different tooling") {
      fixture.run.referenced_workflows[0]!.sha = sourceSha;
    }
    if (failure === "replaced artifact") {
      fixture.artifacts[0]!.id += 100;
    }
    if (failure === "wrong workflow") {
      fixture.run.path = ".github/workflows/ci.yml";
    }
    await expect(
      verifyDockerReleaseProducer(fixture.manifest, {
        publisherSha: toolingSha,
        readApi: fixture.readApi,
      }),
    ).rejects.toThrow();
  });

  it("preserves scheduled stable and extended-stable image refresh preparation", async () => {
    const fixture = await createPreparedRelease(false);
    fixture.manifest.producer.workflowRef = `${repository}/.github/workflows/docker-image-refresh.yml@refs/heads/main`;
    fixture.run.path = ".github/workflows/docker-image-refresh.yml";
    fixture.run.event = "schedule";
    expect(
      (
        await verifyDockerReleaseProducer(fixture.manifest, {
          publisherSha: toolingSha,
          readApi: fixture.readApi,
        })
      ).manifest,
    ).toBe(fixture.manifest);
  });

  it("rejects missing provenance and mismatched source labels in actual OCI bytes", async () => {
    for (const options of [{ provenance: false }, { labelSha: toolingSha }]) {
      const directory = temporaryDirectory();
      const image = createLayout(directory, "amd64", options);
      await expect(
        verifyDockerReleaseLayout({
          directory,
          architecture: "amd64",
          sourceSha,
          version: "2026.8.1-beta.2",
          builtAt: "2026-09-01T00:00:00.000Z",
          expectedDigest: image.indexDigest,
        }),
      ).rejects.toThrow(/missing predicate|labels/);
    }
  });

  it("validates every payload before allowing the first registry mutation", async () => {
    const { root, manifest } = await createPreparedRelease();
    const arm = manifest.architectures[1];
    const digest = arm.images[0].configDigest;
    writeFileSync(
      path.join(root, "payloads", arm.artifact.name, "default", "blobs", "sha256", digest.slice(7)),
      "corrupt",
    );
    const execute = vi.fn();
    await expect(
      publishDockerRelease({
        manifest,
        revalidateAuthority: () => {},
        payloadDirectory: path.join(root, "payloads"),
        images: ["ghcr.io/openclaw/openclaw"],
        execFileSyncImpl: execute,
        verifyTag: vi.fn(),
      }),
    ).rejects.toThrow("OCI blob size/type mismatch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("copies preserved indexes to both registries and emits verified immutable mirror inputs", async () => {
    const { root, manifest } = await createPreparedRelease();
    const { execute, calls, tags } = createRegistry({ root, manifest });
    const verifyTag = vi.fn();
    const promote = vi.fn();
    const output = await publishDockerRelease({
      manifest,
      revalidateAuthority: () => {},
      payloadDirectory: path.join(root, "payloads"),
      images: ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"],
      execFileSyncImpl: execute,
      verifyTag,
      promote,
    });
    expect(verifyTag).toHaveBeenCalledExactlyOnceWith(manifest);
    expect(calls.filter((call) => call[0] === "skopeo")).toHaveLength(8);
    expect(
      calls
        .filter((call) => call[0] === "skopeo")
        .every((call) => call[2] === "--all" && call[3] === "--preserve-digests"),
    ).toBe(true);
    expect(tags.size).toBe(18);
    expect([...tags.keys()].every((tag) => tag.includes("2026.8.1-beta.2-r20260901"))).toBe(true);
    expect(output.split("\n")).toEqual(
      ["default", "slim", "browser"].map(
        (variant) =>
          `${variant}=${tags.get(`ghcr.io/openclaw/openclaw:2026.8.1-beta.2-r20260901${variant === "default" ? "" : `-${variant}`}`)}`,
      ),
    );
    expect(promote).not.toHaveBeenCalled();
  });

  it("refuses a copy that cannot preserve its original digest", async () => {
    const { root, manifest } = await createPreparedRelease(false);
    const execute = vi.fn((command: string) =>
      command === "skopeo" ? "" : JSON.stringify({ digest: `sha256:${"f".repeat(64)}` }),
    );
    await expect(
      publishDockerRelease({
        manifest,
        revalidateAuthority: () => {},
        payloadDirectory: path.join(root, "payloads"),
        images: ["ghcr.io/openclaw/openclaw"],
        execFileSyncImpl: execute,
        verifyTag: vi.fn(),
      }),
    ).rejects.toThrow("did not preserve");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["2026.8.1", "v2026.8.1"],
    ["2026.8.1", "v2026.8.1-2"],
    ["2026.8.1-2", "v2026.8.1-2"],
  ] as const)("seals package %s for exactly release %s", async (packageVersion, tag) => {
    const policy = validateDockerReleaseIdentity({ tag, sourceSha, packageVersion });
    expect(policy.channel).toBe("stable");
    expect(policy.version).toBe(tag.slice(1));
    const { manifest } = await createPreparedRelease(false, policy.version);
    const expected = {
      repository,
      sourceSha,
      tag,
      imageTagSuffix: manifest.imageTagSuffix,
      artifactName: manifest.artifactName,
      runId,
      runAttempt,
    };
    expect(validateDockerReleaseManifest(manifest, expected)).toBe(manifest);
    for (const otherTag of ["v2026.8.1", "v2026.8.1-2", "v2026.8.1-3"].filter(
      (candidate) => candidate !== tag,
    )) {
      expect(() => validateDockerReleaseManifest(manifest, { ...expected, tag: otherTag })).toThrow(
        "does not match the release",
      );
    }
  });

  it("refuses historical smoke-only and incomplete arbitrary-UID receipts", async () => {
    const { manifest } = await createPreparedRelease(false);
    const expected = {
      repository,
      sourceSha,
      tag: manifest.tag,
      imageTagSuffix: manifest.imageTagSuffix,
      artifactName: manifest.artifactName,
      runId,
      runAttempt,
    };
    for (const kind of [
      "historical",
      "stale-image",
      "missing-identity",
      "no-read-proof",
      "supplementary-root",
      "missing-core",
      "missing-plugin-assets",
      "legacy-bypass",
      "stale-source",
      "mismatched-checked-source",
    ]) {
      const changed = structuredClone(manifest);
      const image = changed.architectures[1].images[0];
      const proof = image.artifactPermissions;
      if (kind === "historical") {
        delete image.artifactPermissions;
      }
      if (kind === "stale-image") {
        proof.configDigest = `sha256:${"f".repeat(64)}`;
      }
      if (kind === "missing-identity") {
        proof.cells.pop();
      }
      if (kind === "no-read-proof") {
        proof.cells[2].artifact.readFiles = false;
      }
      if (kind === "supplementary-root") {
        proof.cells[2].runtime.groups.push(0);
      }
      if (kind === "missing-core") {
        proof.cells[2].runtime.compressedAssets = 0;
      }
      if (kind === "missing-plugin-assets") {
        proof.cells[2].runtime.pluginAssets = 0;
      }
      if (kind === "legacy-bypass") {
        proof.cells[2].artifact.planState = "legacy-source";
      }
      if (kind === "stale-source") {
        changed.artifactPlan.sourceSha = "c".repeat(40);
      }
      if (kind === "mismatched-checked-source") {
        proof.cells[2].artifact.sourceSha = "c".repeat(40);
      }
      expect(() => validateDockerReleaseManifest(changed, expected), kind).toThrow(
        kind === "stale-source"
          ? "source artifact-plan qualification"
          : "arbitrary-UID artifact/runtime proof",
      );
    }
  });

  it("qualifies historical source explicitly without accepting legacy proof for new source", async () => {
    const { manifest } = await createPreparedRelease(false);
    const expected = {
      repository,
      sourceSha,
      tag: manifest.tag,
      imageTagSuffix: manifest.imageTagSuffix,
      artifactName: manifest.artifactName,
      runId,
      runAttempt,
    };
    manifest.artifactPlan.state = "legacy-source";
    expect(() => validateDockerReleaseManifest(manifest, expected)).toThrow(
      "arbitrary-UID artifact/runtime proof",
    );
    for (const entry of manifest.architectures) {
      for (const image of entry.images) {
        for (const cell of image.artifactPermissions.cells) {
          cell.artifact.planState = "legacy-source";
          cell.runtime.compressedAssets = 0;
        }
      }
    }
    expect(validateDockerReleaseManifest(manifest, expected)).toBe(manifest);
    manifest.artifactPlan.state = "required";
    expect(() => validateDockerReleaseManifest(manifest, expected)).toThrow(
      "arbitrary-UID artifact/runtime proof",
    );
  });

  it("rejects a correction for another package base or an unsupported release train", () => {
    for (const [packageVersion, tag] of [
      ["2026.8.1", "v2026.8.11-2"],
      ["2026.8.1-2", "v2026.8.1-3"],
    ] as const) {
      expect(() => validateDockerReleaseIdentity({ tag, sourceSha, packageVersion })).toThrow(
        "does not match release tag",
      );
    }
    expect(() =>
      validateDockerReleaseIdentity({
        tag: "v2026.8.1-alpha.2",
        sourceSha,
        packageVersion: "2026.8.1-alpha.2",
      }),
    ).toThrow("alpha");
  });

  it.each([
    { workflow: "full-release-validation", fullRunId: runId, fullRunAttempt: runAttempt },
    { workflow: "full-release-artifacts", fullRunId: "200", fullRunAttempt: "3" },
  ])(
    "resolves $workflow Docker evidence from its selected full release",
    async ({ workflow, fullRunId, fullRunAttempt }) => {
      const fixture = await createPreparedRelease(false);
      const { manifest } = fixture;
      fixture.run.path = `.github/workflows/${workflow}.yml`;
      fixture.run.status = "completed";
      fixture.run.conclusion = "success";
      Object.assign(fixture.attemptRun, structuredClone(fixture.run));
      manifest.producer.workflowRef = `${repository}/${fixture.run.path}@refs/heads/main`;
      const prepared = {
        preparedRunId: runId,
        preparedRunAttempt: runAttempt,
        preparedArtifactName: manifest.artifactName,
        preparedManifestSha256: "c".repeat(64),
      };
      const full = {
        runId: fullRunId,
        runAttempt: Number(fullRunAttempt),
        targetSha: sourceSha,
        publicationArtifacts: { docker: prepared },
      };
      const selection = {
        manifest: full,
        sourceSha,
        runId: fullRunId,
        runAttempt: fullRunAttempt,
      };
      const selected = preparedDockerEvidenceFromFullRelease(selection);
      expect(selected).toBe(prepared);
      const expected = {
        repository,
        sourceSha,
        tag: manifest.tag,
        imageTagSuffix: manifest.imageTagSuffix,
        artifactName: selected.preparedArtifactName,
        runId: selected.preparedRunId,
        runAttempt: selected.preparedRunAttempt,
      };
      expect(validateDockerReleaseManifest(manifest, expected)).toBe(manifest);
      expect(
        (
          await verifyDockerReleaseProducer(manifest, {
            publisherSha: toolingSha,
            readApi: fixture.readApi,
          })
        ).manifest,
      ).toBe(manifest);
      expect(preparedDockerEvidenceFromFullRelease({ ...selection, manifest: {} })).toBeNull();
      for (const mismatch of [{ sourceSha: toolingSha }, { runId: "300" }, { runAttempt: "4" }]) {
        expect(() => preparedDockerEvidenceFromFullRelease({ ...selection, ...mismatch })).toThrow(
          "selected full release",
        );
      }
      for (const invalid of [
        { preparedRunId: 100 },
        { preparedRunId: "0" },
        { preparedRunAttempt: 2 },
        { preparedRunAttempt: "0" },
        { preparedRunAttempt: "1" },
        { preparedArtifactName: dockerReleaseArtifactName(sourceSha, "3") },
        { preparedManifestSha256: "invalid" },
      ]) {
        expect(() =>
          preparedDockerEvidenceFromFullRelease({
            ...selection,
            manifest: {
              ...full,
              publicationArtifacts: { docker: { ...prepared, ...invalid } },
            },
          }),
        ).toThrow("incomplete or stale");
      }
      expect(() => validateDockerReleaseManifest(manifest, { ...expected, runId: "300" })).toThrow(
        "producer identity mismatch",
      );
      fixture.run.run_attempt += 1;
      expect(
        (
          await verifyDockerReleaseProducer(manifest, {
            publisherSha: toolingSha,
            readApi: fixture.readApi,
          })
        ).manifest,
      ).toBe(manifest);
      fixture.attemptRun.conclusion = "failure";
      await expect(
        verifyDockerReleaseProducer(manifest, {
          publisherSha: toolingSha,
          readApi: fixture.readApi,
        }),
      ).rejects.toThrow("Historical Docker producer did not qualify");
    },
  );

  it("prepares both native architectures with one release identity and smokes before sealing", () => {
    const prepare = parse(readFileSync(".github/workflows/docker-release-prepare.yml", "utf8"));
    const build = prepare.jobs.build;
    const steps = build.steps as {
      id?: string;
      name?: string;
      uses?: string;
      run?: string;
      if?: string;
      "continue-on-error"?: boolean;
      with?: Record<string, unknown>;
    }[];
    expect(build.strategy.matrix.include).toEqual([
      { architecture: "amd64", runner: "ubuntu-24.04" },
      { architecture: "arm64", runner: "ubuntu-24.04-arm" },
    ]);
    const builders = steps.filter((step) => step.uses?.startsWith("docker/build-push-action@"));
    expect(builders).toHaveLength(2);
    for (const step of builders) {
      expect(step.with).toMatchObject({
        context: "source",
        platforms: "linux/${{ matrix.architecture }}",
        push: false,
        sbom: true,
        provenance: "mode=max",
      });
      expect(String(step.with?.["build-args"]).split("\n")).toEqual(
        expect.arrayContaining([
          "GITHUB_ACTIONS=true",
          "GIT_COMMIT=${{ inputs.release_sha }}",
          "OPENCLAW_BUILD_TIMESTAMP=${{ needs.resolve.outputs.built_at }}",
          "OPENCLAW_DOCKER_BUILD_VERSION=${{ needs.resolve.outputs.version }}",
          "OPENCLAW_EXTENSIONS=diagnostics-otel,codex",
        ]),
      );
      expect(String(step.with?.labels).split("\n")).toEqual(
        expect.arrayContaining([
          "org.opencontainers.image.revision=${{ inputs.release_sha }}",
          "org.opencontainers.image.version=${{ needs.resolve.outputs.version }}",
          "org.opencontainers.image.created=${{ needs.resolve.outputs.built_at }}",
        ]),
      );
    }
    const browser = steps.find((step) => step.id === "build-browser");
    expect(browser?.if).toBe("${{ needs.resolve.outputs.include_browser == 'true' }}");
    expect(String(browser?.with?.["build-args"]).split("\n")).toContain(
      "OPENCLAW_INSTALL_BROWSER=1",
    );
    for (const [variant, buildId] of [
      ["default", "build"],
      ["browser", "build-browser"],
    ]) {
      const relay = steps.find((step) => step.name === `Relay ${variant} image limit warnings`);
      expect(relay?.if).toBe(`\${{ always() && steps.${buildId}.outputs.metadata != '' }}`);
      expect(relay?.run).toContain('["buildx.build.ref"]');
      expect(relay?.["continue-on-error"]).toBe(true);
      expect(relay?.run).toContain('docker buildx history logs --progress plain "$build_ref"');
      expect(relay?.run).toContain("::notice title=Build limit warning relay skipped::");
      expect(relay?.run).toContain("node workflow-source/scripts/relay-build-limit-warnings.mts");
    }
    const smoke = steps.findIndex((step) =>
      step.run?.includes("docker-release-artifacts.mjs prepare"),
    );
    expect(smoke).toBeGreaterThan(-1);
    expect(
      steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@")),
    ).toBeGreaterThan(smoke);
    expect(prepare.jobs.seal.needs).toContain("build");
  });

  it("keeps preparation unable to publish and serializes the single approved writer", () => {
    const prepare = parse(readFileSync(".github/workflows/docker-release-prepare.yml", "utf8"));
    const publish = parse(readFileSync(".github/workflows/docker-release.yml", "utf8"));
    expect(prepare.on.workflow_call.secrets).toBeUndefined();
    expect(prepare.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(prepare.jobs) as {
      permissions?: Record<string, string>;
      environment?: string;
      concurrency?: unknown;
      steps?: { uses?: string; with?: Record<string, unknown> }[];
    }[]) {
      expect(
        Object.values(job.permissions ?? {}).every((permission) => permission === "read"),
      ).toBe(true);
      expect(job.environment).toBeUndefined();
      expect(job.concurrency).toBeUndefined();
      expect(job.steps?.some((step) => step.uses?.startsWith("docker/login-action@"))).toBe(false);
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("docker/build-push-action@")) {
          expect(step.with).toMatchObject({ push: false, sbom: true, provenance: "mode=max" });
        }
      }
    }
    expect(publish.jobs.prepare.uses).toBe("./.github/workflows/docker-release-prepare.yml");
    expect(publish.jobs.prepare.secrets).toBeUndefined();
    expect(publish.concurrency).toBeUndefined();
    const approval = publish.jobs.approve;
    const writer = publish.jobs.publish;
    expect(approval, "approval must not hold the global publication lock").toBeDefined();
    expect(approval.environment).toBe("docker-release");
    expect(approval.permissions).toEqual({});
    expect(approval.concurrency).toBeUndefined();
    expect(JSON.stringify(approval)).not.toContain("secrets.");
    expect(approval.needs).toEqual(["validate_release_identity", "prepare"]);
    expect(writer.environment).toBeUndefined();
    expect(writer.needs).toEqual(["validate_release_identity", "prepare", "approve"]);
    for (const [identity, prepared, approved, cancelled, canApprove, canPublish] of [
      ["success", "success", "success", false, true, true],
      ["success", "skipped", "success", false, true, true],
      ["failure", "success", "success", false, false, false],
      ["success", "failure", "success", false, false, false],
      ["success", "success", "failure", false, true, false],
      ["success", "success", "skipped", false, true, false],
      ["success", "success", "cancelled", false, true, false],
      ["success", "success", "success", true, false, false],
    ] as const) {
      const context = {
        cancelled: () => cancelled,
        needs: {
          validate_release_identity: { result: identity },
          prepare: { result: prepared },
          approve: { result: approved },
        },
      };
      const evaluate = (condition: string) => runInNewContext(condition.slice(3, -2), context);
      expect(evaluate(approval.if)).toBe(canApprove);
      expect(evaluate(writer.if)).toBe(canPublish);
    }
    expect(publish.jobs.publish.concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(
      Object.entries(publish.jobs)
        .filter(
          ([, job]) =>
            (job as { permissions?: { packages?: string } }).permissions?.packages === "write",
        )
        .map(([name]) => name),
    ).toEqual(["publish"]);
  });
});
