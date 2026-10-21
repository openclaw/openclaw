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
} from "../../scripts/docker-release-artifacts.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const repository = "openclaw/openclaw";
const runId = "100";
const runAttempt = "2";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mediaType = "application/vnd.oci.image.manifest.v1+json";
const indexMediaType = "application/vnd.oci.image.index.v1+json";
const defaultVersion = "2026.8.1-beta.2";
const builtAt = "2026-09-01T00:00:00.000Z";
const architectures = ["amd64", "arm64"];
const registries = ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"];
const workflowPath = (name: string) => `.github/workflows/${name}.yml`;
const workflowRef = (name: string) => `${repository}/${workflowPath(name)}@refs/heads/main`;
const readWorkflow = (name: string) => parse(readFileSync(workflowPath(name), "utf8"));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

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
    const digest = hash(bytes);
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
        "org.opencontainers.image.version": options.version ?? defaultVersion,
        "org.opencontainers.image.created": options.builtAt ?? builtAt,
      },
    },
  });
  const manifestBlob = (descriptor: ReturnType<typeof blob>, layers: unknown[]) =>
    blob({
      schemaVersion: 2,
      mediaType,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", ...descriptor },
      layers,
    });
  const image = manifestBlob(config, []);
  const predicates = [
    "https://spdx.dev/Document",
    ...(options.provenance === false ? [] : ["https://slsa.dev/provenance/v1"]),
  ];
  const attestation = manifestBlob(
    blob({}),
    predicates.map((predicateType) =>
      Object.assign(
        blob({ predicateType, subject: [{ digest: { sha256: image.digest.slice(7) } }] }),
        {
          mediaType: "application/vnd.in-toto+json",
          annotations: { "in-toto.io/predicate-type": predicateType },
        },
      ),
    ),
  );
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

async function createPreparedRelease(
  includeBrowser = true,
  releaseVersion = defaultVersion,
  recovery?: { artifactAttempt: string; architectureAttempts: [string, string] },
) {
  const root = temporaryDirectory();
  const artifactName = dockerReleaseArtifactName(
    sourceSha,
    recovery?.artifactAttempt ?? runAttempt,
  );
  const context = {
    schemaVersion: 1,
    repository,
    sourceSha,
    toolingSha,
    tag: `v${releaseVersion}`,
    version: releaseVersion,
    imageTagSuffix: "-r20260901",
    builtAt,
    includeBrowser,
    producer: {
      runId,
      runAttempt,
      workflowRef: workflowRef("full-release-validation"),
      workflowSha: toolingSha,
      preparationWorkflowRef: workflowRef("docker-release-prepare"),
    },
  };
  const artifacts = architectures.map((architecture, index) => ({
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
  const architectureJobs = architectures.map((architecture, index) => ({
    ...job,
    id: 20 + index,
    run_attempt: Number(recovery?.architectureAttempts[index] ?? runAttempt),
    name: `Prepare Docker / Prepare Docker images (${architecture})`,
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/${20 + index}`,
  }));
  const run = {
    id: Number(runId),
    run_attempt: Number(runAttempt),
    path: workflowPath("full-release-validation"),
    head_branch: "main",
    head_sha: toolingSha,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null as string | null,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    referenced_workflows: [
      {
        path: `${repository}/${workflowPath("docker-release-prepare")}@${toolingSha}`,
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
    const architectureJob = architectureJobs.find((candidate) =>
      endpoint.endsWith(`/actions/jobs/${candidate.id}`),
    );
    if (architectureJob) {
      return architectureJob;
    }
    if (endpoint.includes("/jobs?")) {
      const attempt = Number(endpoint.match(/\/attempts\/([0-9]+)\//u)?.[1]);
      const attemptJobs = architectureJobs.filter((candidate) => candidate.run_attempt === attempt);
      const jobs = [
        ...(job.run_attempt === attempt ? [job] : []),
        ...attemptJobs,
        {
          ...job,
          id: 8,
          check_run_url: `https://api.github.com/repos/${repository}/check-runs/8`,
        },
      ];
      return {
        jobs,
        total_count: jobs.length,
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
  for (const [architectureIndex, architecture] of architectures.entries()) {
    const images = [];
    for (const variant of includeBrowser ? ["default", "browser"] : ["default"]) {
      const directory = path.join(root, "payloads", `${artifactName}-${architecture}`, variant);
      const image = createLayout(directory, architecture, { version: releaseVersion });
      const verified = await verifyDockerReleaseLayout({
        ...context,
        directory,
        architecture,
        expectedDigest: image.indexDigest,
      });
      images.push({ variant, ...verified, smoke: "success", attestations: "success" });
    }
    writeJson(path.join(root, "metadata", `${architecture}.json`), {
      ...context,
      producer: {
        ...context.producer,
        runAttempt: recovery?.architectureAttempts[architectureIndex] ?? runAttempt,
      },
      architecture,
      images,
    });
  }
  const manifest = sealDockerRelease({
    metadataDirectory: path.join(root, "metadata"),
    context,
    artifactName,
    checkRunId: "7",
    readApi,
  });
  return { root, manifest, run, attemptRun, job, architectureJobs, artifacts, readApi };
}

async function createPublicationRetry(conclusion = "failure") {
  const fixture = await createPreparedRelease(false);
  const workflow = workflowPath("openclaw-release-publish");
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

function createRegistry({
  root,
  manifest,
  revalidateAuthority = () => {},
}: PreparedRelease & { revalidateAuthority?: () => void }) {
  const indexes = new Map<string, { digest: string; manifests: unknown[] }>();
  const blobFiles = new Map<string, string>();
  for (const entry of manifest.architectures) {
    for (const image of entry.images) {
      const directory = path.join(root, "payloads", entry.artifact.name, image.variant);
      indexes.set(image.indexDigest, { digest: image.indexDigest, manifests: image.manifests });
      for (const descriptor of image.manifests) {
        blobFiles.set(
          descriptor.digest,
          path.join(directory, "blobs", "sha256", descriptor.digest.slice(7)),
        );
      }
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
        digest = `sha256:${hash(JSON.stringify(descriptors))}`;
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
    const file = blobFiles.get(digest);
    if (file) {
      return readFileSync(file, "utf8");
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  });
  return {
    execute,
    calls,
    tags,
    publish: (overrides: Parameters<typeof publishPrepared>[2] = {}) =>
      publishPrepared(root, manifest, {
        execFileSyncImpl: execute,
        revalidateAuthority,
        ...overrides,
      }),
  };
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
  }
  const bytes = JSON.stringify(fixture.docker, null, 2) + "\n";
  Object.assign(fixture.manifest.publicationArtifacts.docker, {
    preparedManifestSha256: hash(bytes),
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
    registry: createRegistry({
      root,
      manifest: fixture.docker,
      revalidateAuthority: verified.revalidateAuthority,
    }),
  };
}

function registryWrites(calls: string[][]) {
  return calls.filter((call) => call[0] === "skopeo" || call[3] === "create");
}

type PreparedRelease = Pick<Awaited<ReturnType<typeof createPreparedRelease>>, "root" | "manifest">;
type PublicationRetry = Awaited<ReturnType<typeof createPublicationRetry>>;
function publishPrepared(
  root: string,
  manifest: PreparedRelease["manifest"],
  overrides: Partial<Parameters<typeof publishDockerRelease>[0]> = {},
) {
  return publishDockerRelease({
    manifest,
    revalidateAuthority: () => {},
    payloadDirectory: path.join(root, "payloads"),
    images: ["ghcr.io/openclaw/openclaw"],
    verifyTag: vi.fn(),
    ...overrides,
  });
}

function verifyPrepared(fixture: Awaited<ReturnType<typeof createPreparedRelease>>) {
  return verifyDockerReleaseProducer(fixture.manifest, {
    publisherSha: toolingSha,
    readApi: fixture.readApi,
  });
}

function expectedIdentity(manifest: PreparedRelease["manifest"]) {
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

function expectLines(value: unknown, lines: string[]) {
  expect(String(value).split("\n")).toEqual(expect.arrayContaining(lines));
}

describe("prepared Docker publication", () => {
  it("adopts successful architecture producers across a failed-job retry", async () => {
    const fixture = await createPreparedRelease(false, defaultVersion, {
      artifactAttempt: "1",
      architectureAttempts: ["1", "2"],
    });
    expect(fixture.manifest.artifactName).toBe(dockerReleaseArtifactName(sourceSha, "1"));
    expect(fixture.manifest.producer.runAttempt).toBe("2");
    expect(
      fixture.manifest.architectures.map(
        (entry: { producer: { runAttempt: string } }) => entry.producer.runAttempt,
      ),
    ).toEqual(["1", "2"]);
    expect((await verifyPrepared(fixture)).manifest).toBe(fixture.manifest);
  });

  it.each([
    [
      "another parent",
      (metadata: { producer: { runId: string } }) => (metadata.producer.runId = "999"),
    ],
    [
      "another tooling revision",
      (metadata: { producer: { workflowSha: string } }) =>
        (metadata.producer.workflowSha = sourceSha),
    ],
    [
      "future attempt",
      (metadata: { producer: { runAttempt: string } }) => (metadata.producer.runAttempt = "3"),
    ],
  ])("rejects %s architecture metadata before adoption", async (_label, mutate) => {
    const fixture = await createPreparedRelease(false);
    const metadataPath = path.join(fixture.root, "metadata", "amd64.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const context = structuredClone(metadata);
    delete context.architecture;
    delete context.images;
    mutate(metadata);
    writeJson(metadataPath, metadata);
    expect(() =>
      sealDockerRelease({
        metadataDirectory: path.join(fixture.root, "metadata"),
        context,
        artifactName: fixture.manifest.artifactName,
        checkRunId: "7",
        readApi: fixture.readApi,
      }),
    ).toThrow(/producer mismatch/u);
  });

  it("rejects a replaced architecture job before artifact acquisition", async () => {
    const fixture = await createPreparedRelease(false);
    fixture.architectureJobs[0]!.run_attempt += 1;
    await expect(verifyPrepared(fixture)).rejects.toThrow(/amd64 preparation job/u);
  });

  it("publishes authenticated candidate bytes", async () => {
    const { fixture, verified, bytes, registry } = await createCandidateDockerPublication();
    const images = registries;
    const output = await registry.publish({ images });
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
  });

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
      const publication = publishPrepared(root, fixture.docker, {
        revalidateAuthority: verified.revalidateAuthority,
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
    ["combined registry", 9],
  ] as const)(
    "stops candidate writes across the %s boundary after P moves",
    async (_boundary, completedWrites) => {
      const { fixture, registry } = await createCandidateDockerPublication(true);
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
        registry.publish({ images: registries, execFileSyncImpl: execute }),
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
      const publication = registry.publish({
        revalidateAuthority: () => {
          if (revoked) {
            throw new Error("Publication authority revoked");
          }
        },
        images: registries,
        execFileSyncImpl: execute,
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

  it("reuses its successful preparation when retrying a timed-out publication attempt", async () => {
    const fixture = await createPublicationRetry("timed_out");
    expect((await verifyDockerReleaseProducer(fixture.manifest, fixture.publisher)).manifest).toBe(
      fixture.manifest,
    );
  });

  it.each<[string, (fixture: PublicationRetry) => void]>([
    ["unrelated publisher", (f) => (f.publisher.publisherRunId = "200")],
    [
      "failed current parent",
      (f) => Object.assign(f.run, { status: "completed", conclusion: "failure" }),
    ],
    ["changed historical source", (f) => (f.attemptRun.head_sha = sourceSha)],
    ["changed historical workflow", (f) => (f.attemptRun.path = workflowPath("ci"))],
    ["missing historical preparation", (f) => (f.attemptRun.referenced_workflows = [])],
    ["failed seal", (f) => (f.job.conclusion = "failure")],
    ["replaced artifact", (f) => (f.artifacts[0]!.id += 100)],
  ])("rejects a publication retry with %s", async (_failure, mutate) => {
    const fixture = await createPublicationRetry();
    mutate(fixture);
    await expect(
      verifyDockerReleaseProducer(fixture.manifest, fixture.publisher),
    ).rejects.toThrow();
  });

  it("preserves scheduled stable and extended-stable image refresh preparation", async () => {
    const fixture = await createPreparedRelease(false);
    fixture.manifest.producer.workflowRef = workflowRef("docker-image-refresh");
    fixture.run.path = workflowPath("docker-image-refresh");
    fixture.run.event = "schedule";
    expect((await verifyPrepared(fixture)).manifest).toBe(fixture.manifest);
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
          version: defaultVersion,
          builtAt,
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
    await expect(publishPrepared(root, manifest, { execFileSyncImpl: execute })).rejects.toThrow(
      "OCI blob size/type mismatch",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("copies preserved indexes to both registries and emits verified immutable mirror inputs", async () => {
    const { root, manifest } = await createPreparedRelease();
    const { publish, calls, tags } = createRegistry({ root, manifest });
    const verifyTag = vi.fn();
    const promote = vi.fn();
    const output = await publish({
      images: registries,
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
    await expect(publishPrepared(root, manifest, { execFileSyncImpl: execute })).rejects.toThrow(
      "did not preserve",
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("seals package 2026.8.1 for exactly release v2026.8.1-2", async () => {
    const packageVersion = "2026.8.1";
    const tag = "v2026.8.1-2";
    const policy = validateDockerReleaseIdentity({ tag, sourceSha, packageVersion });
    expect(policy).toMatchObject({ channel: "stable", version: tag.slice(1) });
    const { manifest } = await createPreparedRelease(false, policy.version);
    const expected = { ...expectedIdentity(manifest), tag };
    expect(validateDockerReleaseManifest(manifest, expected)).toBe(manifest);
    for (const otherTag of ["v2026.8.1", "v2026.8.1-3"]) {
      expect(() => validateDockerReleaseManifest(manifest, { ...expected, tag: otherTag })).toThrow(
        "does not match the release",
      );
    }
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

  it("resolves Docker evidence from its selected full release", async () => {
    const fixture = await createPreparedRelease(false);
    const { manifest } = fixture;
    fixture.run.path = workflowPath("full-release-validation");
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
      runId,
      runAttempt: Number(runAttempt),
      targetSha: sourceSha,
      publicationArtifacts: { docker: prepared },
    };
    const selection = { manifest: full, sourceSha, runId, runAttempt };
    const selected = preparedDockerEvidenceFromFullRelease(selection);
    expect(selected).toBe(prepared);
    const expected = {
      ...expectedIdentity(manifest),
      artifactName: selected.preparedArtifactName,
      runId: selected.preparedRunId,
      runAttempt: selected.preparedRunAttempt,
    };
    expect(validateDockerReleaseManifest(manifest, expected)).toBe(manifest);
    expect((await verifyPrepared(fixture)).manifest).toBe(manifest);
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
      { preparedArtifactName: dockerReleaseArtifactName(toolingSha, "3") },
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
    expect((await verifyPrepared(fixture)).manifest).toBe(manifest);
    fixture.attemptRun.conclusion = "failure";
    await expect(verifyPrepared(fixture)).rejects.toThrow(
      "Historical Docker producer did not qualify",
    );
  });

  it("prepares both native architectures with one release identity and smokes before sealing", () => {
    const prepare = readWorkflow("docker-release-prepare");
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
      expectLines(step.with?.["build-args"], [
        "GITHUB_ACTIONS=true",
        "GIT_COMMIT=${{ inputs.release_sha }}",
        "OPENCLAW_BUILD_TIMESTAMP=${{ needs.resolve.outputs.built_at }}",
        "OPENCLAW_DOCKER_BUILD_VERSION=${{ needs.resolve.outputs.version }}",
        "OPENCLAW_EXTENSIONS=diagnostics-otel,codex",
      ]);
      expectLines(step.with?.labels, [
        "org.opencontainers.image.revision=${{ inputs.release_sha }}",
        "org.opencontainers.image.version=${{ needs.resolve.outputs.version }}",
        "org.opencontainers.image.created=${{ needs.resolve.outputs.built_at }}",
      ]);
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
      expect(relay).toMatchObject({
        if: `\${{ always() && steps.${buildId}.outputs.metadata != '' }}`,
        "continue-on-error": true,
      });
      for (const command of [
        '["buildx.build.ref"]',
        'docker buildx history logs --progress plain "$build_ref"',
        "::notice title=Build limit warning relay skipped::",
        "node workflow-source/scripts/relay-build-limit-warnings.mts",
      ]) {
        expect(relay?.run).toContain(command);
      }
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
    const prepare = readWorkflow("docker-release-prepare");
    const publish = readWorkflow("docker-release");
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
      expect([job.environment, job.concurrency]).toEqual([undefined, undefined]);
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
    expect(approval.needs).toEqual(["validate_release_identity", "prepare"]);
    expect(approval.concurrency).toBeUndefined();
    expect(approval.permissions).toEqual({});
    expect(JSON.stringify(approval)).not.toContain("secrets.");
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
    expect(writer.concurrency).toEqual({
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
