import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  authenticatePreparedNpmArtifact,
  consumePreparedNpmPackage,
  createPreparedNpmRelease,
  downloadPreparedNpmRelease,
  PREPARED_NPM_MANIFEST,
  preparedNpmArtifactName,
  validatePreparedNpmRelease,
  verifyPreparedNpmRegistry,
} from "../../scripts/plugin-npm-prepared-release.mjs";
import { createPluginPublicationArtifact } from "../../scripts/plugin-publication-artifact.mjs";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import {
  packNpmFixture,
  npmRegistryPackument,
  npmWorkflowRun,
  zipNpmFixture as archive,
} from "./plugin-npm-publication-readback.test-support.js";

const producer = {
  repository: "openclaw/openclaw",
  runId: 101,
  runAttempt: 2,
  workflowPath: ".github/workflows/plugin-npm-release.yml",
  workflowEvent: "workflow_dispatch",
  workflowHeadBranch: "main",
  workflowSha: "a".repeat(40),
};
const sourceSha = "b".repeat(40);
const policySha = "c".repeat(64);
const version = "2026.9.2-beta.1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tempRoot = () => tempDirs.make("plugin-npm-prepared-");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("reports validation errors after the authorize CLI loads its cyclic imports", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/plugin-npm-prepared-release.mjs", "authorize", "--artifact", "{}"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "invalid-repository",
        PREPARED_NPM_FRV_RUN_ID: "1",
        PREPARED_NPM_FRV_RUN_ATTEMPT: "1",
        PREPARED_NPM_EVIDENCE_ID: "",
      },
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("repository must use the owner/name form");
  expect(result.stderr).toContain("[plugin-npm-prepared-release] FAILED (exit 1)");
  expect(result.stderr).not.toContain("unsettled top-level await");
});

function digest(bytes: Buffer, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

function plugin(extensionId: string, alreadyPublished = false) {
  return {
    extensionId,
    packageDir: `extensions/${extensionId}`,
    packageName: `@openclaw/${extensionId}`,
    version,
    channel: "beta",
    publishTag: "beta",
    installNpmSpec: `@openclaw/${extensionId}`,
    alreadyPublished,
  };
}

const workflowRun = (completed = false) =>
  npmWorkflowRun(producer.runId, producer.runAttempt, completed);

function metadata(id: number, name: string, bytes: Buffer = Buffer.from("artifact")) {
  return {
    id,
    name,
    digest: `sha256:${digest(bytes)}`,
    size_in_bytes: bytes.length,
    expired: false,
    workflow_run: { id: producer.runId, head_sha: producer.workflowSha },
  };
}

const expected = {
  sourceSha,
  workflowSha: producer.workflowSha,
  repository: producer.repository,
  npmDistTag: "default",
  selectionMode: "all-publishable",
  plugins: "",
  publisherPolicySha256: policySha,
};

function preparation(
  packageFields: Partial<
    Pick<ReturnType<typeof plugin>, "version" | "channel" | "publishTag">
  > = {},
  route = "npm-oidc",
  npmDistTag = "default",
) {
  const matrix = [
    { ...plugin("demo"), ...packageFields },
    { ...plugin("existing", true), ...packageFields },
  ] as const;
  const artifact = (entry: ReturnType<typeof plugin>, id: number) =>
    metadata(
      id,
      `plugin-npm-package-${entry.extensionId}-${entry.version}-${route}-${producer.runId}-${producer.runAttempt}`,
    );
  const artifacts = [artifact(matrix[0], 1), artifact(matrix[1], 2)] satisfies [
    ReturnType<typeof metadata>,
    ReturnType<typeof metadata>,
  ];
  return {
    ...expected,
    npmDistTag,
    producer,
    matrix,
    artifacts,
    workflowRun: workflowRun(),
    workflowJobs: {
      total_count: matrix.length,
      jobs: matrix.map((entry) => ({
        name: `Preflight plugin npm package (${entry.packageName})`,
        run_id: producer.runId,
        run_attempt: producer.runAttempt,
        head_sha: producer.workflowSha,
        status: "completed",
        conclusion: "success",
      })),
    },
  };
}

function candidatePreparation() {
  const qualification = candidatePublicationFixture();
  const qProducer = {
    ...producer,
    workflowSha: qualification.q,
    workflowHeadBranch: qualification.branch,
  };
  const artifact = {
    ...qProducer,
    artifactId: 9001,
    artifactName: preparedNpmArtifactName(qualification.q, qProducer),
    artifactDigest: `sha256:${"d".repeat(64)}`,
    artifactSizeBytes: 1024,
  };
  Object.assign(qualification.manifest.publicationArtifacts, { pluginNpm: artifact });
  const qPolicy = "name: Q plugin policy\n# immutable Q bytes, never executed by P\n";
  const policyReads: string[] = [];
  const evidenceClient = {
    ...qualification.client,
    getWorkflowSource(sha: string, path?: string) {
      if (path === producer.workflowPath) {
        policyReads.push(sha);
        if (sha !== qualification.q) {
          throw new Error("The consumer requested P policy for Q artifacts");
        }
        return qPolicy;
      }
      return qualification.client.getWorkflowSource();
    },
  };
  const params = {
    repository: qualification.repository,
    sourceSha: qualification.q,
    workflowSha: qualification.p,
    workflowFullRef: qualification.publisherFullRef,
    artifact: structuredClone(artifact),
    fullReleaseValidationRunId: qualification.runId,
    fullReleaseValidationRunAttempt: 1,
    releaseTag: `v${qualification.source.projection?.version}`,
    selectionMode: "all-publishable",
    plugins: "",
    npmDistTag: "default",
    evidenceClient,
  };
  return { qualification, params, qPolicy, policyReads };
}

it("authenticates Q != P and reads the exact Q policy through the FRV admission owner", async () => {
  const { qualification, params, qPolicy, policyReads } = candidatePreparation();
  expect(qualification.q).not.toBe(qualification.p);
  const admitted = await authenticatePreparedNpmArtifact(params);
  expect(admitted.artifact).toEqual(params.artifact);
  expect(admitted.workflowSha).toBe(qualification.q);
  expect(admitted.publisherPolicySha256).toBe(digest(Buffer.from(qPolicy)));
  expect(policyReads).toEqual([qualification.q]);
  if (!admitted.revalidateAuthority) {
    throw new Error("Missing live candidate authority");
  }
  const revalidate = admitted.revalidateAuthority;
  await revalidate();
  qualification.admission.authority.permission = "read";
  expect(() => revalidate()).toThrow();
});

it.each([
  "producer",
  "digest",
  "producer-attempt",
  "parent-attempt",
  "parent",
  "selection",
  "channel",
  "revoked",
  "missing-parent",
])("rejects Q adoption with %s mismatch before reading its publisher policy", async (fault) => {
  const { qualification, params, policyReads } = candidatePreparation();
  if (fault === "producer") {
    params.artifact.workflowSha = qualification.p;
  }
  if (fault === "digest") {
    params.artifact.artifactDigest = `sha256:${"e".repeat(64)}`;
  }
  if (fault === "producer-attempt") {
    params.artifact.runAttempt += 1;
  }
  if (fault === "parent-attempt") {
    params.fullReleaseValidationRunAttempt = 2;
  }
  if (fault === "parent") {
    params.fullReleaseValidationRunId = "9002";
  }
  if (fault === "selection") {
    params.selectionMode = "selected";
  }
  if (fault === "channel") {
    params.npmDistTag = "extended-stable";
  }
  if (fault === "revoked") {
    qualification.admission.authority.permission = "read";
  }
  if (fault === "missing-parent") {
    params.fullReleaseValidationRunId = "";
    params.fullReleaseValidationRunAttempt = 0;
  }
  await expect(authenticatePreparedNpmArtifact(params)).rejects.toThrow();
  expect(policyReads).toEqual([]);
});

function sourcePackage(root: string, entry: ReturnType<typeof plugin>) {
  const { packageDir } = writePublishablePluginFixture(root, {
    extensionId: entry.extensionId,
    version: entry.version,
    publishTo: "npm",
  });
  const file = join(packageDir, "package.json");
  return { bytes: readFileSync(file), file };
}

function sourcePreparation() {
  const input = preparation();
  const sourceRoot = tempRoot();
  for (const entry of input.matrix) {
    sourcePackage(sourceRoot, entry);
  }
  return { sourceRoot, manifest: createPreparedNpmRelease(input) };
}

function descriptor(artifact: ReturnType<typeof metadata>) {
  return {
    ...producer,
    artifactId: artifact.id,
    artifactName: artifact.name,
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.size_in_bytes,
  };
}

function artifactFetch(artifact: ReturnType<typeof metadata>, bytes: Buffer) {
  return async (input: string) => {
    if (input.endsWith(`/artifacts/${artifact.id}/zip`)) {
      return new Response(new Uint8Array(bytes));
    }
    if (input.endsWith(`/artifacts/${artifact.id}`)) {
      return Response.json(artifact);
    }
    if (input.endsWith(`/runs/${producer.runId}/attempts/${producer.runAttempt}`)) {
      return Response.json(workflowRun(true));
    }
    throw new Error(`Unexpected request: ${input}`);
  };
}

async function packedPluginFixture() {
  const root = tempRoot();
  const entry = plugin("demo");
  const source = sourcePackage(root, entry);
  const evidence = join(root, "evidence");
  const tarballName = "openclaw-demo.tgz";
  const tarballPath = join(evidence, tarballName);
  await packNpmFixture(join(root, "archive"), tarballPath, {
    "package.json": source.bytes,
    "openclaw.plugin.json": JSON.stringify({ id: "demo" }),
    "README.md": "Prepared plugin package.\n",
    "dist/index.js": "export default {};\n",
  });
  return { root, entry, source, evidence, tarballName, tarballPath };
}

it("loads and consumes the original Q bytes using authenticated Q expectations at P", async () => {
  const { qualification, params, qPolicy } = candidatePreparation();
  const { root, entry, source, evidence, tarballName, tarballPath } = await packedPluginFixture();
  sourcePackage(root, plugin("existing", true));
  const qProducer = { ...producer, workflowHeadBranch: qualification.branch };
  const input = preparation();
  input.sourceSha = qualification.q;
  input.producer = qProducer;
  input.publisherPolicySha256 = digest(Buffer.from(qPolicy));
  input.workflowRun.head_branch = qualification.branch;
  const packageName = input.artifacts[0].name;
  const created = createPluginPublicationArtifact({
    artifactDir: evidence,
    artifactName: packageName,
    ...entry,
    route: "npm-oidc",
    targetSha: qualification.q,
    sourcePackageJsonSha256: digest(source.bytes),
    publicationReason: "Stable npm registry preflight selected npm-oidc.",
    publisherPolicy: {
      policyId: "plugin-npm-release-workflow",
      schema: "openclaw.plugin-npm-publisher-policy/v1",
      sha256: input.publisherPolicySha256,
    },
  });
  const packageBytes = await archive({
    [tarballName]: readFileSync(tarballPath),
    "plugin-publication-manifest.json": readFileSync(created.manifestPath),
  });
  input.artifacts[0] = metadata(1, packageName, packageBytes);
  const manifest = createPreparedNpmRelease(input);
  const manifestBytes = await archive({ [PREPARED_NPM_MANIFEST]: manifest });
  const manifestArtifact = metadata(
    10,
    preparedNpmArtifactName(qualification.q, qProducer),
    manifestBytes,
  );
  const qDescriptor = { ...descriptor(manifestArtifact), workflowHeadBranch: qualification.branch };
  Object.assign(qualification.manifest.publicationArtifacts, { pluginNpm: qDescriptor });
  params.artifact = qDescriptor;
  const authenticated = await authenticatePreparedNpmArtifact(params);
  const fetchImpl = async (url: string) => {
    if (url.endsWith(`/runs/${producer.runId}/attempts/${producer.runAttempt}`)) {
      return Response.json({ ...workflowRun(true), head_branch: qualification.branch });
    }
    if (url.includes("/artifacts/10")) {
      return artifactFetch(manifestArtifact, manifestBytes)(url);
    }
    return artifactFetch(input.artifacts[0], packageBytes)(url);
  };
  const context = {
    ...params,
    ...authenticated,
    sourceRoot: root,
    token: "synthetic-token",
    fetchImpl,
  };
  const loaded = await downloadPreparedNpmRelease({
    ...context,
    archivePath: join(root, "q-prepared.zip"),
  });
  expect(loaded.producer.workflowSha).toBe(qualification.q);
  expect(loaded.producer.workflowSha).not.toBe(qualification.p);
  const consumed = await consumePreparedNpmPackage({
    ...context,
    package: loaded.packages[0],
    sourcePackageJson: source.file,
    cacheDir: join(root, "q-downloads"),
    outputDir: join(root, "q-consumed"),
  });
  expect(consumed.tarballSha256).toBe(digest(readFileSync(tarballPath)));
  await expect(
    downloadPreparedNpmRelease({
      ...context,
      publisherPolicySha256: "e".repeat(64),
      archivePath: join(root, "bad-policy.zip"),
    }),
  ).rejects.toThrow("approved source, tooling, selection, or channel");
  if (!authenticated.revalidateAuthority) {
    throw new Error("Missing live candidate authority");
  }
  await authenticated.revalidateAuthority();
});

it("seals regular stable bootstrap without granting publication authority", () => {
  const packageFields = { version: "2026.9.32", channel: "stable", publishTag: "latest" };
  const input = preparation(packageFields, "npm-token-bootstrap");
  const manifest = createPreparedNpmRelease(input);
  expect(manifest.packages).toHaveLength(input.matrix.length);
  for (const entry of manifest.packages) {
    expect(entry).toMatchObject({ ...packageFields, route: "npm-token-bootstrap" });
  }
  expect(validatePreparedNpmRelease(manifest, expected).packages).toEqual(manifest.packages);
});

it("rejects bootstrap preparation for explicit extended-stable", () => {
  const npmDistTag = "extended-stable";
  const packageFields = { version: "2026.9.33", channel: "stable", publishTag: npmDistTag };
  expect(() =>
    createPreparedNpmRelease(preparation(packageFields, "npm-token-bootstrap", npmDistTag)),
  ).toThrow("Prepared npm token bootstrap");
  const manifest = createPreparedNpmRelease(preparation(packageFields, "npm-oidc", npmDistTag));
  for (const entry of manifest.packages) {
    entry.route = "npm-token-bootstrap";
    entry.artifact.artifactName = `plugin-npm-package-${entry.extensionId}-${entry.version}-npm-token-bootstrap-${producer.runId}-${producer.runAttempt}`;
  }
  expect(() => validatePreparedNpmRelease(manifest, { ...expected, npmDistTag })).toThrow(
    "Prepared npm token bootstrap",
  );
});

it.each(["prior-attempt", "conflicting-artifact"])(
  "refuses to seal %s instead of falling back to an older success",
  (fault) => {
    const input = preparation();
    if (fault === "prior-attempt") {
      input.artifacts[0].name = input.artifacts[0].name.replace(/-2$/u, "-1");
    }
    if (fault === "conflicting-artifact") {
      input.artifacts.push({ ...input.artifacts[0], id: 99 });
    }
    expect(() => createPreparedNpmRelease(input)).toThrow();
  },
);

it("compares the complete frozen-source roster and rejects a valid subset", () => {
  const { sourceRoot, manifest } = sourcePreparation();
  const validation = { ...expected, sourceRoot };
  expect(validatePreparedNpmRelease(manifest, validation).packages).toHaveLength(2);
  manifest.packages.pop();
  expect(() => validatePreparedNpmRelease(manifest, validation)).toThrow(
    "complete selected frozen-source roster",
  );
});

it("rejects another prepared sourceSha", () => {
  const manifest = createPreparedNpmRelease(preparation());
  expect(() =>
    validatePreparedNpmRelease(manifest, { ...expected, sourceSha: "different" }),
  ).toThrow();
});

it("admits only the exact successful preparation artifact and source inventory", async () => {
  const { sourceRoot, manifest } = sourcePreparation();
  const bytes = await archive({ [PREPARED_NPM_MANIFEST]: manifest });
  const artifact = metadata(10, preparedNpmArtifactName(sourceSha, producer), bytes);
  const approvedArtifact = descriptor(artifact);
  const download = {
    ...expected,
    sourceRoot,
    artifact: approvedArtifact,
    token: "synthetic-token",
    fetchImpl: artifactFetch(artifact, bytes),
  };
  const admitted = await downloadPreparedNpmRelease({
    ...download,
    archivePath: join(sourceRoot, "prepared.zip"),
  });
  expect(admitted.packages).toEqual(manifest.packages);
  await expect(
    downloadPreparedNpmRelease({
      ...download,
      artifact: { ...approvedArtifact, runAttempt: 1 },
    }),
  ).rejects.toThrow("approved producer");
});

it("consumes the original qualified package in another run without a source install or pack", async () => {
  const { root, entry, source, evidence, tarballName, tarballPath } = await packedPluginFixture();
  const artifactName = `plugin-npm-package-demo-${version}-npm-oidc-${producer.runId}-${producer.runAttempt}`;
  const created = createPluginPublicationArtifact({
    artifactDir: evidence,
    artifactName,
    ...entry,
    route: "npm-oidc",
    targetSha: sourceSha,
    sourcePackageJsonSha256: digest(source.bytes),
    publicationReason: "Stable npm registry preflight selected npm-oidc.",
    publisherPolicy: {
      policyId: "plugin-npm-release-workflow",
      schema: "openclaw.plugin-npm-publisher-policy/v1",
      sha256: policySha,
    },
  });
  const bytes = await archive({
    [tarballName]: readFileSync(tarballPath),
    "plugin-publication-manifest.json": readFileSync(created.manifestPath),
  });
  const artifact = metadata(11, artifactName, bytes);
  const result = await consumePreparedNpmPackage({
    ...expected,
    token: "synthetic-token",
    package: {
      ...entry,
      route: "npm-oidc",
      artifact: descriptor(artifact),
    },
    sourcePackageJson: source.file,
    cacheDir: join(root, "downloads"),
    outputDir: join(root, "verified"),
    fetchImpl: artifactFetch(artifact, bytes),
  });
  expect(readFileSync(result.tarballPath)).toEqual(readFileSync(tarballPath));
  expect(result.producerRunId).toBe(producer.runId);
  expect(result.producerRunAttempt).toBe(producer.runAttempt);
});
function registryFixture() {
  const bytes = Buffer.from("exact qualified bytes");
  const tarballPath = join(tempRoot(), "qualified.tgz");
  writeFileSync(tarballPath, bytes);
  const name = "@openclaw/demo";
  const packument = npmRegistryPackument(name, version, bytes);
  const params = {
    packageName: name,
    version,
    publishTags: ["beta"],
    route: "npm-oidc",
    tarballPath,
    allowMissing: true,
  };
  const reads = { tarball: 0 };
  const responses = {
    registry: (_read: number) => Response.json(packument),
    tarball: (_read: number) => new Response(new Uint8Array(bytes)),
  };
  let registryRequests = 0;
  const fetchImpl = async (url: string) => {
    return url.endsWith(".tgz")
      ? responses.tarball(++reads.tarball)
      : responses.registry(++registryRequests);
  };
  const verify = (overrides: Partial<typeof params> = {}) =>
    verifyPreparedNpmRegistry({ ...params, fetchImpl, ...overrides });
  return { packument, reads, responses, verify };
}

it("accepts an authoritative missing version as publication work", async () => {
  const { packument, responses, verify } = registryFixture();
  responses.registry = () => Response.json({ ...packument, versions: {} });
  expect(await verify()).toEqual({ alreadyPublished: false });
});

it("waits for package propagation before verifying exact bytes", async () => {
  vi.useFakeTimers();
  const { packument, responses, reads, verify } = registryFixture();
  responses.registry = (read) =>
    read <= 18 ? new Response(null, { status: 404 }) : Response.json(packument);
  const verified = expect(verify({ allowMissing: false })).resolves.toEqual({
    alreadyPublished: true,
  });
  await vi.advanceTimersByTimeAsync(180_000);
  await verified;
  expect(reads.tarball).toBe(1);
});

it("rejects a zero readback timeout", async () => {
  vi.stubEnv("OPENCLAW_NPM_READBACK_TIMEOUT_MS", "0");
  const { verify } = registryFixture();
  await expect(verify({ allowMissing: false })).rejects.toThrow("OPENCLAW_NPM_READBACK_TIMEOUT_MS");
});

it("refuses to bootstrap a removed OIDC package", async () => {
  const { responses, reads, verify } = registryFixture();
  responses.registry = () => new Response("missing", { status: 404 });
  await expect(verify({ allowMissing: true })).rejects.toThrow();
  expect(reads.tarball).toBe(0);
});
