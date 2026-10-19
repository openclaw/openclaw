import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  consumePreparedNpmPackage,
  createPreparedNpmRelease,
  downloadPreparedNpmRelease,
  PREPARED_NPM_MANIFEST,
  preparedNpmArtifactName,
  validatePreparedNpmRelease,
  verifyPreparedNpmRegistry,
  verifyPublishedNpmRegistry,
} from "../../scripts/plugin-npm-prepared-release.mjs";
import { createPluginPublicationArtifact } from "../../scripts/plugin-publication-artifact.mjs";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  packNpmFixture,
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
  const job = (entry: ReturnType<typeof plugin>) => ({
    name: `Preflight plugin npm package (${entry.packageName})`,
    run_id: producer.runId,
    run_attempt: producer.runAttempt,
    head_sha: producer.workflowSha,
    status: "completed",
    conclusion: "success",
  });
  const workflowJobs = {
    total_count: matrix.length,
    jobs: matrix.map(job),
  };
  return {
    ...expected,
    npmDistTag,
    producer,
    matrix,
    artifacts,
    workflowRun: workflowRun(),
    workflowJobs,
  };
}

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

it("rejects retired alpha preparation", () => {
  expect(() =>
    createPreparedNpmRelease(
      preparation({ version: "2026.9.3-alpha.1", channel: "alpha", publishTag: "alpha" }),
    ),
  ).toThrow("Alpha releases are retired");
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
function registryFixture(bytes = Buffer.from("exact qualified bytes")) {
  const tarballPath = join(tempRoot(), "qualified.tgz");
  writeFileSync(tarballPath, bytes);
  const name = "@openclaw/demo";
  const packument = {
    name,
    "dist-tags": { beta: version },
    versions: {
      [version]: {
        name,
        version,
        dist: {
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          shasum: digest(bytes, "sha1"),
          tarball: "https://registry.npmjs.org/@openclaw/demo/-/demo.tgz",
        },
      },
    },
  };
  const params = {
    packageName: name,
    version,
    publishTags: ["beta"],
    route: "npm-oidc",
    tarballPath,
    allowMissing: true,
  };
  const reads = { registry: 0, tarball: 0 };
  const responses = {
    registry: (_read: number) => {
      reads.registry += 1;
      return Response.json(packument);
    },
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
  return { bytes, packument, params, reads, responses, fetchImpl, verify };
}

it("refuses an incomparable selector on a version this run did not publish", async () => {
  const { packument, params, fetchImpl } = registryFixture(
    readFileSync((await packedPluginFixture()).tarballPath),
  );
  packument["dist-tags"].beta = "not-a-version";
  await expect(verifyPublishedNpmRegistry({ ...params, fetchImpl })).rejects.toThrow(
    "beta differs from the prepared version; use authorized tag repair.",
  );
});

it("accepts an authoritative missing version as publication work, not a malformed response", async () => {
  const { packument, responses, verify } = registryFixture();
  responses.registry = () => Response.json({ ...packument, versions: {} });
  expect(await verify()).toEqual({ alreadyPublished: false });
  responses.registry = () => Response.json({});
  await expect(verify()).rejects.toThrow("authoritative package inventory");
});

it("recovers a transient canonical tarball readback without another publication", async () => {
  const { bytes, responses, reads, verify } = registryFixture();
  responses.tarball = (read) =>
    read === 1 ? new Response("unavailable", { status: 503 }) : new Response(bytes);
  expect(await verify()).toEqual({ alreadyPublished: true });
  expect(reads.tarball).toBe(2);
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

it("bounds pending verification with the default timeout", async () => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_NPM_READBACK_TIMEOUT_MS", undefined);
  const budget = 900_000;
  const { responses, packument, verify } = registryFixture();
  const reads: number[] = [];
  const started = Date.now();
  responses.registry = () => {
    reads.push(Date.now() - started);
    return Response.json({ ...packument, versions: {} });
  };
  const rejected = expect(verify({ allowMissing: false })).rejects.toThrow(
    "verification pending. Retry readback, not publication.",
  );
  await vi.advanceTimersByTimeAsync(budget);
  await rejected;
  expect(reads).toEqual(
    Array.from({ length: Math.ceil(budget / 10_000) }, (_, index) => index * 10_000),
  );
});

it("rejects a zero readback timeout", async () => {
  vi.stubEnv("OPENCLAW_NPM_READBACK_TIMEOUT_MS", "0");
  const { verify } = registryFixture();
  await expect(verify({ allowMissing: false })).rejects.toThrow("OPENCLAW_NPM_READBACK_TIMEOUT_MS");
});

it.each(["integrity", "bytes", "selector", "removed-oidc-package"])(
  "refuses %s without authorizing a publish or changing a tag",
  async (fault) => {
    const { packument, responses, reads, verify } = registryFixture();
    if (fault === "integrity") {
      packument.versions[version].dist.shasum = "0".repeat(40);
    }
    if (fault === "selector") {
      packument["dist-tags"].beta = "2026.9.2-beta.2";
    }
    if (fault === "removed-oidc-package") {
      responses.registry = () => new Response("missing", { status: 404 });
    }
    if (fault === "bytes") {
      responses.tarball = () => new Response("changed bytes");
    }
    await expect(verify({ allowMissing: fault === "removed-oidc-package" })).rejects.toThrow();
    expect(reads.registry).toBe(fault === "removed-oidc-package" ? 0 : 1);
    expect(reads.tarball).toBe(fault === "bytes" || fault === "selector" ? 1 : 0);
  },
);
