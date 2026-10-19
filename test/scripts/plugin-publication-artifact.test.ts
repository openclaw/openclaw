import { createHash } from "node:crypto";
/* oxlint-disable typescript/no-base-to-string -- fetch mocks normalize standard RequestInfo inputs exactly as the production fetch boundary does. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadExactActionsArtifactArchive } from "../../scripts/lib/actions-artifact-archive.mjs";
import {
  createPluginPublicationArtifact,
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  verifyPluginPublicationArtifact,
} from "../../scripts/plugin-publication-artifact.mjs";

const TARGET_SHA = "1".repeat(40);
const WORKFLOW_SHA = "2".repeat(40);
const ARTIFACT_ID = 12345;
const RUN_ID = 67890;
const RUN_ATTEMPT = 2;
const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/plugin-npm-release.yml";
const ARTIFACT_NAME = "plugin-npm-package-meta-2026.7.1-beta.3";
const PACKAGE_NAME = "@openclaw/meta-provider";
const PRODUCER_JOB_NAME = `Preflight plugin npm package (${PACKAGE_NAME})`;
const PACKAGE_VERSION = "2026.7.1-beta.3";
const PACKAGE_DIR = "extensions/meta";
const TARBALL_NAME = "openclaw-meta-provider-2026.7.1-beta.3.tgz";
const MANUAL_OVERRIDE_REASON =
  "OpenClaw Release Publish run 12345 approved token release for v2026.7.1-beta.3";
const PUBLICATION_REASON = "First npm publication for the approved beta3 Meta package.";
const PUBLISHER_POLICY = {
  policyId: "2026.7.1-beta.3",
  schema: "openclaw.plugin-npm-publisher-policy/v1",
  sha256: "6a40c33756ff1016744bb929660c1d9bf271cd478b0b9811fa8e2d8f1f775e95",
};
const WORKFLOW_BINDING = {
  repository: REPOSITORY,
  workflowEvent: "workflow_dispatch",
  workflowHeadBranch: "main",
  workflowPath: WORKFLOW_PATH,
  workflowSha: WORKFLOW_SHA,
};

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-publication-artifact-"));
  tempDirs.push(dir);
  return dir;
}

function stagingFixture(markerName = "marker") {
  const root = tempDir();
  const artifactDir = path.join(root, "artifact");
  mkdirSync(artifactDir, { recursive: true });
  return {
    root,
    artifactDir,
    markerPath: path.join(root, markerName),
    tarballPath: path.join(artifactDir, TARBALL_NAME),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`Tar field is too long: ${value}`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const raw = value.toString(8).padStart(length - 2, "0");
  if (raw.length !== length - 2) {
    throw new Error(`Tar number is too large: ${value}`);
  }
  writeTarString(header, offset, length, `${raw} \0`);
}

function checksumTarHeader(header: Buffer) {
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  writeTarOctal(header, 148, 8, sum);
}

type TarEntry = {
  content?: Buffer | string;
  format?: "ustar" | "v7";
  linkPath?: string;
  path: string;
  prefix?: string;
  type?: "0" | "2" | "3" | "5" | "K" | "L" | "g" | "x";
};

function tarEntry(entry: TarEntry): Buffer {
  const type = entry.type ?? "0";
  const content = Buffer.isBuffer(entry.content)
    ? entry.content
    : Buffer.from(entry.content ?? "", "utf8");
  const header = Buffer.alloc(512);
  for (const [offset, length, value] of [
    [0, 100, entry.path],
    [157, 100, entry.linkPath ?? ""],
    [257, 6, entry.format === "v7" ? "" : "ustar\0"],
    [263, 2, entry.format === "v7" ? "" : "00"],
    [345, 155, entry.prefix ?? ""],
  ] as const) {
    writeTarString(header, offset, length, value);
  }
  writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.length);
  writeTarOctal(header, 136, 12, 0);
  header[156] = type.charCodeAt(0);
  writeTarOctal(header, 329, 8, 0);
  writeTarOctal(header, 337, 8, 0);
  checksumTarHeader(header);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function mutateTarEntryHeader(
  entry: Buffer,
  mutate: (header: Buffer) => void,
  options: { preserveChecksumBytes?: boolean } = {},
): Buffer {
  const result = Buffer.from(entry);
  const header = result.subarray(0, 512);
  mutate(header);
  if (!options.preserveChecksumBytes) {
    checksumTarHeader(header);
  }
  return result;
}

function createTarball(entries: TarEntry[]): Buffer {
  return createTarballFromParts(entries.map(tarEntry));
}

function createTarballFromParts(parts: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

function packageEntries(markerPath: string, overrides: Record<string, unknown> = {}): TarEntry[] {
  return [{ path: "package/", type: "5" }, manifestEntry(markerPath, {}, overrides)];
}

function manifestEntry(
  marker: string,
  fields: Partial<TarEntry> = {},
  overrides: Record<string, unknown> = {},
): TarEntry {
  return { path: "package/package.json", content: metaPackageJson(marker, overrides), ...fields };
}

function stageTarball(build: (markerPath: string) => Buffer) {
  const fixture = stagingFixture();
  writeFileSync(fixture.tarballPath, build(fixture.markerPath));
  return fixture;
}

function expectTarballError(artifactDir: string, message?: RegExp, overrides = {}) {
  expect(() => createPluginPublicationArtifact(publicationParams(artifactDir, overrides))).toThrow(
    message,
  );
}

function consumerTarEntries(file: string) {
  const entries: Array<{ path: string; size: number; type: string }> = [];
  tar.t({
    file,
    onReadEntry: (entry) => entries.push({ path: entry.path, size: entry.size, type: entry.type }),
    onwarn: () => undefined,
    sync: true,
  });
  return entries;
}

function paxRecord(key: string, value: string): Buffer {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  while (true) {
    const record = `${length} ${payload}`;
    const actualLength = Buffer.byteLength(record);
    if (actualLength === length) {
      return Buffer.from(record, "utf8");
    }
    length = actualLength;
  }
}

type ZipFile = {
  bytes: Buffer;
  compression?: 0 | 8;
  compressedBytes?: Buffer;
  declaredExpandedSize?: number;
  descriptor?: boolean;
  descriptorCrc?: number;
  flags?: number;
  gapAfter?: Buffer;
  localCrc?: number;
  localNameBytes?: Buffer;
  name: string;
  nameBytes?: Buffer;
};

function zipValues(record: Buffer, width: 2 | 4, offset: number, ...values: number[]) {
  values.forEach((value, index) => {
    if (width === 2) {
      record.writeUInt16LE(value, offset + index * width);
    } else {
      record.writeUInt32LE(value, offset + index * width);
    }
  });
  return record;
}

function createZip(files: ZipFile[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = file.nameBytes ?? Buffer.from(file.name, "utf8");
    const localName = file.localNameBytes ?? name;
    const compression = file.compression ?? 0;
    const compressed =
      file.compressedBytes ?? (compression === 8 ? deflateRawSync(file.bytes) : file.bytes);
    const expandedSize = file.declaredExpandedSize ?? file.bytes.length;
    const checksum = crc32(file.bytes);
    const flags = file.flags ?? (file.descriptor ? 0x0008 : 0);
    const local = Buffer.alloc(30);
    zipValues(local, 4, 0, 0x04034b50);
    zipValues(local, 2, 4, 20, flags, compression);
    zipValues(
      local,
      4,
      14,
      file.localCrc ?? (file.descriptor ? 0 : checksum),
      file.descriptor ? 0 : compressed.length,
      file.descriptor ? 0 : expandedSize,
    );
    zipValues(local, 2, 26, localName.length);
    const descriptor = file.descriptor
      ? zipValues(
          Buffer.alloc(16),
          4,
          0,
          0x08074b50,
          file.descriptorCrc ?? checksum,
          compressed.length,
          expandedSize,
        )
      : Buffer.alloc(0);
    const gap = file.gapAfter ?? Buffer.alloc(0);
    localParts.push(local, localName, compressed, descriptor, gap);

    const central = Buffer.alloc(46);
    zipValues(central, 4, 0, 0x02014b50);
    zipValues(central, 2, 4, 0x0314, 20, flags, compression);
    zipValues(central, 4, 16, checksum, compressed.length, expandedSize);
    zipValues(central, 2, 28, name.length);
    zipValues(central, 4, 38, (0o100600 * 0x10000) >>> 0, localOffset);
    centralParts.push(central, name);
    localOffset +=
      local.length + localName.length + compressed.length + descriptor.length + gap.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  zipValues(end, 4, 0, 0x06054b50);
  zipValues(end, 2, 8, files.length, files.length);
  zipValues(end, 4, 12, centralDirectory.length, localOffset);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function inspectTestZip(
  zip: Buffer,
  overrides: { maxCompressedEntryBytes?: (name: string) => number } = {},
) {
  return inspectActionsArtifactZipWithPolicy(zip, {
    minEntries: 1,
    maxEntries: 8,
    maxArchiveBytes: 1024 * 1024,
    maxExpandedBytes: 1024 * 1024,
    allowPath: () => true,
    maxCompressedEntryBytes: () => 1024 * 1024,
    maxEntryBytes: () => 1024 * 1024,
    ...overrides,
  });
}

function expectZipError(files: ZipFile[], message: RegExp) {
  expect(() => inspectTestZip(createZip(files))).toThrow(message);
}

function zipFile(name: string, bytes: Buffer | string, options: Partial<ZipFile> = {}): ZipFile {
  return { name, bytes: typeof bytes === "string" ? Buffer.from(bytes) : bytes, ...options };
}

function expectZipFileError(name: string, options: Partial<ZipFile>, message: RegExp) {
  expectZipError([zipFile(name, "x", options)], message);
}

function lifecycleScript(markerPath: string, content: string) {
  return `node -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, '${content}')"`;
}

function metaPackageJson(markerPath: string, overrides: Record<string, unknown> = {}): string {
  const manifest = {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    type: "module",
    scripts: {
      preinstall: lifecycleScript(markerPath, "bad"),
      postinstall: lifecycleScript(markerPath, "bad"),
    },
    openclaw: { release: { publishToClawHub: true, publishToNpm: true } },
    ...overrides,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function publicationParams(artifactDir: string, overrides: Record<string, unknown> = {}) {
  const route = typeof overrides.route === "string" ? overrides.route : "npm-token-bootstrap";
  const npmPolicy = route.startsWith("npm-")
    ? {
        publicationReason: PUBLICATION_REASON,
        publisherPolicy: PUBLISHER_POLICY,
      }
    : {};
  return {
    artifactDir,
    artifactName: ARTIFACT_NAME,
    packageDir: PACKAGE_DIR,
    packageName: PACKAGE_NAME,
    publishTag: "beta",
    route,
    sourcePackageJsonSha256: "3".repeat(64),
    targetSha: TARGET_SHA,
    version: PACKAGE_VERSION,
    ...npmPolicy,
    ...overrides,
  };
}

function createFixture(
  options: {
    packageJson?: string;
    publicationOverrides?: Record<string, unknown>;
  } = {},
) {
  const { root, artifactDir, markerPath, tarballPath } = stagingFixture("lifecycle-ran");
  const outputDir = path.join(root, "verified");
  const packageJson = options.packageJson ?? metaPackageJson(markerPath);
  const tarball = createTarball([
    { path: "package/", type: "5" },
    { content: packageJson, path: "package/package.json" },
    { content: '{"id":"meta"}\n', path: "package/openclaw.plugin.json" },
    { content: "export default {};\n", path: "package/index.js" },
  ]);
  writeFileSync(tarballPath, tarball);
  const created = createPluginPublicationArtifact(
    publicationParams(artifactDir, options.publicationOverrides),
  );
  const manifestBytes = readFileSync(created.manifestPath);
  const zip = createZip([
    { bytes: tarball, name: TARBALL_NAME },
    { bytes: manifestBytes, name: "plugin-publication-manifest.json" },
  ]);
  const zipPath = path.join(root, "artifact.zip");
  const metadataPath = path.join(root, "artifact.json");
  const workflowRunPath = path.join(root, "run.json");
  const workflowJobsPath = path.join(root, "jobs.json");
  writeFileSync(zipPath, zip);
  writeArtifactMetadata(metadataPath, zip);
  writeJson(workflowRunPath, workflowRunMetadata());
  writeJson(workflowJobsPath, workflowJobsMetadata());
  return {
    artifactDir,
    created,
    markerPath,
    metadataPath,
    outputDir,
    publicationOverrides: options.publicationOverrides,
    root,
    tarball,
    workflowRunPath,
    workflowJobsPath,
    zip,
    zipPath,
  };
}

function artifactMetadataFor(zip: Buffer) {
  return {
    id: ARTIFACT_ID,
    name: ARTIFACT_NAME,
    expired: false,
    digest: `sha256:${sha256(zip)}`,
    size_in_bytes: zip.length,
    workflow_run: { id: RUN_ID, head_sha: WORKFLOW_SHA },
  };
}

function workflowRunMetadata(
  runAttempt = RUN_ATTEMPT,
  status = "completed",
  conclusion: string | null = "success",
) {
  return {
    id: RUN_ID,
    run_attempt: runAttempt,
    head_sha: WORKFLOW_SHA,
    head_branch: "main",
    event: "workflow_dispatch",
    path: WORKFLOW_PATH,
    status,
    conclusion,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
  };
}

function workflowJobsMetadata(
  name = PRODUCER_JOB_NAME,
  attempt = RUN_ATTEMPT,
  conclusion = "success",
) {
  const identity = { run_id: RUN_ID, head_sha: WORKFLOW_SHA, status: "completed" };
  return { total_count: 1, jobs: [{ ...identity, name, run_attempt: attempt, conclusion }] };
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function writeArtifactMetadata(metadataPath: string, zip: Buffer): void {
  writeJson(metadataPath, artifactMetadataFor(zip));
}

function createDownloadFixture(
  runAttempt = RUN_ATTEMPT,
  options: { contentLength?: boolean; expires?: boolean } = {},
) {
  const zip = createZip([{ bytes: Buffer.from("proof"), name: "proof.txt" }]);
  const expiry = options.expires === false ? {} : { artifactExpiresAt: "2099-01-01T00:00:00Z" };
  const expected = {
    artifactDigest: `sha256:${sha256(zip)}`,
    ...expiry,
    artifactId: ARTIFACT_ID,
    artifactName: ARTIFACT_NAME,
    artifactSizeBytes: zip.length,
    ...WORKFLOW_BINDING,
    runStatePolicy: "completed-success",
    runAttempt,
    runId: RUN_ID,
  };
  const artifactMetadata = {
    ...artifactMetadataFor(zip),
    ...(expiry.artifactExpiresAt ? { expires_at: expiry.artifactExpiresAt } : {}),
  };
  const workflowRun = workflowRunMetadata(runAttempt);
  const bodies = new Map<string, unknown>([
    [`/actions/artifacts/${ARTIFACT_ID}`, artifactMetadata],
    [`/actions/runs/${RUN_ID}/attempts/${runAttempt}`, workflowRun],
  ]);
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    for (const [suffix, body] of bodies) {
      if (url.endsWith(suffix)) {
        return Response.json(body);
      }
    }
    if (url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
      return new Response(
        new Uint8Array(zip),
        options.contentLength
          ? { status: 200, headers: { "content-length": String(zip.length) } }
          : undefined,
      );
    }
    return new Response("unexpected", { status: 404 });
  };
  return { zip, expected, artifactMetadata, workflowRun, fetchImpl, bodies };
}

function downloadFixture(
  fixture: ReturnType<typeof createDownloadFixture>,
  overrides: Partial<Parameters<typeof downloadActionsArtifactArchive>[0]> = {},
) {
  return downloadActionsArtifactArchive({
    expected: fixture.expected,
    fetchImpl: fixture.fetchImpl,
    retryDelayMs: 1,
    token: "test-token",
    ...overrides,
  });
}

function replaceArtifactZip(fixture: ReturnType<typeof createFixture>, files: ZipFile[]): void {
  const zip = createZip(files);
  fixture.zip = zip;
  writeFileSync(fixture.zipPath, zip);
  writeArtifactMetadata(fixture.metadataPath, zip);
}

function verifyFixture(
  fixture: ReturnType<typeof createFixture>,
  overrides: Record<string, unknown> = {},
) {
  return verifyPluginPublicationArtifact({
    ...publicationParams(fixture.artifactDir, fixture.publicationOverrides),
    artifactDigest: `sha256:${sha256(fixture.zip)}`,
    artifactId: ARTIFACT_ID,
    artifactMetadataPath: fixture.metadataPath,
    artifactSizeBytes: fixture.zip.length,
    artifactZipPath: fixture.zipPath,
    outputDir: fixture.outputDir,
    producerRunAttempt: RUN_ATTEMPT,
    producerRunId: RUN_ID,
    ...WORKFLOW_BINDING,
    workflowRunMetadataPath: fixture.workflowRunPath,
    ...overrides,
  });
}

function expectVerifyError(
  fixture: ReturnType<typeof createFixture>,
  message?: string | RegExp,
  overrides = {},
) {
  expect(() => verifyFixture(fixture, overrides)).toThrow(message);
}

it.each(["npm-readback"])("retains historical alpha artifact readback through %s", (route) => {
  const packageJson = JSON.parse(metaPackageJson("unused-marker"));
  packageJson.version = "2026.7.1-alpha.3";
  expect(() =>
    createFixture({
      packageJson: JSON.stringify(packageJson),
      publicationOverrides: { route, version: packageJson.version, publishTag: "alpha" },
    }),
  ).not.toThrow();
});

describe("plugin publication artifact", () => {
  it("derives the closed npm auth capability and binds placeholder-recovery policy", () => {
    const fixture = createFixture({
      publicationOverrides: {
        route: "npm-token-placeholder-recovery",
      },
    });
    const verified = verifyFixture(fixture);

    expect(verified.manifest.publication).toEqual({
      authMode: "token-bootstrap",
      capability: "placeholder-recovery",
      publisherPolicy: PUBLISHER_POLICY,
      reason: PUBLICATION_REASON,
      route: "npm-token-placeholder-recovery",
      tag: "beta",
    });
    expectVerifyError(fixture, "auth mode must be token-bootstrap", { authMode: "release-token" });
    expectVerifyError(fixture, "capability must be placeholder-recovery", {
      capability: "first-publication",
    });
  });

  it("binds exact tarball size and canonical inventory", () => {
    const fixture = createFixture();
    const expectedInventory = JSON.parse(readFileSync(fixture.created.manifestPath, "utf8"))
      .artifact.inventory;
    expect(
      verifyFixture(fixture, {
        expectedInventory,
        expectedTarballSha256: sha256(fixture.tarball),
        expectedTarballSizeBytes: fixture.tarball.length,
      }),
    ).toMatchObject({
      tarballInventory: expectedInventory,
      tarballSha256: sha256(fixture.tarball),
      tarballSizeBytes: fixture.tarball.length,
    });
    expect(existsSync(fixture.markerPath)).toBe(false);

    const wrongSizeFixture = createFixture();
    expectVerifyError(wrongSizeFixture, "tarball size does not match", {
      expectedTarballSizeBytes: wrongSizeFixture.tarball.length + 1,
    });

    const wrongInventoryFixture = createFixture();
    expectVerifyError(wrongInventoryFixture, "tarball inventory does not match", {
      expectedInventory: expectedInventory.slice(0, -1),
    });
  });

  it("requires a fresh non-symlink output directory", () => {
    const existingFixture = createFixture();
    mkdirSync(existingFixture.outputDir);
    expectVerifyError(existingFixture, "must not already exist");

    const symlinkFixture = createFixture();
    const symlinkTarget = path.join(symlinkFixture.root, "output-target");
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, symlinkFixture.outputDir);
    expectVerifyError(symlinkFixture, "must not already exist");
  });

  it("binds the exact ClawHub token-release manual override reason", () => {
    const fixture = createFixture({
      publicationOverrides: {
        manualOverrideReason: MANUAL_OVERRIDE_REASON,
        requiresManualOverride: true,
        route: "clawhub-token-release",
      },
    });
    const verified = verifyFixture(fixture);

    expect(verified.manifest.publication).toMatchObject({
      manualOverrideReason: MANUAL_OVERRIDE_REASON,
      requiresManualOverride: true,
      route: "clawhub-token-release",
    });
    expectVerifyError(fixture, /does not canonically bind/u, {
      manualOverrideReason:
        "OpenClaw Release Publish run 12345 approved token release for v2026.7.1-beta.4",
    });
  });

  it("rejects invalid npm policy and npm controls on a ClawHub route", () => {
    const fixture = createFixture();
    for (const controls of [
      { publicationReason: "" },
      { publicationReason: "invalid\nreason" },
      { publisherPolicy: undefined },
      { publisherPolicy: { ...PUBLISHER_POLICY, sha256: "A".repeat(64) } },
      { publisherPolicy: { ...PUBLISHER_POLICY, extra: true } },
      { requiresManualOverride: true, route: "clawhub-token-release" },
    ]) {
      expectVerifyError(fixture, undefined, controls);
    }
  });

  it("rejects every mutable artifact identity dimension", () => {
    const fixture = createFixture();
    const mismatches: Array<[string, Record<string, unknown>]> = [
      ["artifact id", { artifactId: ARTIFACT_ID + 1 }],
      ["artifact name", { artifactName: "plugin-npm-package-other-2026.7.1-beta.3" }],
      ["artifact digest", { artifactDigest: `sha256:${"f".repeat(64)}` }],
      ["artifact size", { artifactSizeBytes: fixture.zip.length + 1 }],
      ["workflow run id", { producerRunId: RUN_ID + 1 }],
      ["workflow run attempt", { producerRunAttempt: RUN_ATTEMPT + 1 }],
      ["repository", { repository: "openclaw/not-openclaw" }],
      ["workflow SHA", { workflowSha: "3".repeat(40) }],
      ["workflow path", { workflowPath: ".github/workflows/other.yml" }],
      ["workflow event", { workflowEvent: "workflow_call" }],
      ["workflow head branch", { workflowHeadBranch: "release/2026.7.1" }],
      ["target SHA", { targetSha: "4".repeat(40) }],
      ["package name", { packageName: "@openclaw/not-meta" }],
      ["package dir", { packageDir: "extensions/not-meta" }],
      ["package version", { version: "2026.7.1-beta.2" }],
      ["publication route", { route: "npm-oidc" }],
      ["publish tag", { publishTag: "alpha" }],
    ];
    for (const [label, overrides] of mismatches) {
      expect(() => verifyFixture(fixture, overrides), label).toThrow();
    }
  });

  it("rejects a publication artifact bound to a different target package.json", () => {
    expect(() =>
      verifyFixture(createFixture(), { sourcePackageJsonSha256: "4".repeat(64) }),
    ).toThrow("source package.json SHA-256 does not match the approved target source");
  });

  it("binds authoritative workflow status, conclusion, and head repository", () => {
    for (const overrides of [
      { status: "in_progress" },
      { conclusion: "cancelled" },
      { head_repository: { full_name: "openclaw/not-openclaw" } },
    ]) {
      const fixture = createFixture();
      const run = JSON.parse(readFileSync(fixture.workflowRunPath, "utf8"));
      writeJson(fixture.workflowRunPath, { ...run, ...overrides });
      expectVerifyError(fixture, /workflow run does not match the immutable publication tuple/u);
    }
  });

  it.each([
    { status: "queued", conclusion: null },
    { status: "completed", conclusion: "failure" },
  ])(
    "accepts a $status/$conclusion current attempt with an exact successful producer",
    ({ status, conclusion }) => {
      const fixture = createFixture();
      const workflowRun = workflowRunMetadata(RUN_ATTEMPT, status, conclusion);
      writeJson(fixture.workflowRunPath, workflowRun);
      const controls = {
        consumerRunAttempt: RUN_ATTEMPT,
        producerJobName: PRODUCER_JOB_NAME,
        runStatePolicy: "same-run-producer-success",
        workflowJobsMetadataPath: fixture.workflowJobsPath,
      };
      expect(verifyFixture(fixture, controls)).toMatchObject({
        producerRunAttempt: RUN_ATTEMPT,
        producerRunId: RUN_ID,
      });

      if (status === "completed") {
        workflowRun.conclusion = "cancelled";
        writeJson(fixture.workflowRunPath, workflowRun);
        expectVerifyError(
          fixture,
          "Current producer workflow attempt must still be active or sealed.",
          controls,
        );
      }
    },
  );

  it.each([false, true])(
    "retries exact artifact transfer (extended deadline: %s)",
    async (extended) => {
      const fixture = createDownloadFixture(RUN_ATTEMPT, { contentLength: true });
      const callCounts = { archive: 0, artifact: 0, run: 0 };
      const urls: string[] = [];
      if (extended) {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      }
      const fetchImpl = async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        const endpoint = url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)
          ? "archive"
          : url.endsWith(`/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`)
            ? "run"
            : url.endsWith(`/actions/artifacts/${ARTIFACT_ID}`)
              ? "artifact"
              : undefined;
        if (!endpoint || (extended && endpoint === "run")) {
          return new Response("unexpected", { status: 404 });
        }
        callCounts[endpoint] += 1;
        if (extended && endpoint === "artifact" && callCounts.artifact === 1) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "300" } });
        }
        if (!extended && callCounts[endpoint] === 1) {
          return endpoint === "run"
            ? new Response("{", { status: 200 })
            : new Response("retry", { status: endpoint === "artifact" ? 503 : 502 });
        }
        return fixture.fetchImpl(input);
      };
      try {
        const result = extended
          ? downloadExactActionsArtifactArchive({
              deadlineMs: Date.now() + 480_000,
              expected: fixture.expected,
              fetchImpl,
              retryAttempts: 2,
              retryDelayMs: 1,
              token: "test-token",
            })
          : downloadFixture(fixture, { fetchImpl, maxArchiveBytes: 1024 * 1024, retryAttempts: 3 });
        const assertion = result.then((value) => {
          expect(value.archiveBytes).toEqual(fixture.zip);
        });
        if (extended) {
          await vi.advanceTimersByTimeAsync(300_000);
        }
        await assertion;
        expect(callCounts).toEqual({
          archive: extended ? 1 : 2,
          artifact: 2,
          run: extended ? 0 : 2,
        });
        if (!extended) {
          expect(urls).toContain(
            `https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`,
          );
        }
      } finally {
        if (extended) {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      }
    },
  );

  it.each([403])("does not retry permanent HTTP %i artifact failures", async (status) => {
    const fixture = createDownloadFixture();
    let requests = 0;
    await expect(
      downloadFixture(fixture, {
        fetchImpl: async () => {
          requests += 1;
          return new Response("unavailable", { status });
        },
      }),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(requests).toBe(1);
  });

  it("does not retry before Retry-After when it exceeds the shared deadline", async () => {
    const fixture = createDownloadFixture();
    let requests = 0;
    await expect(
      downloadFixture(fixture, {
        deadlineMs: Date.now() + 500,
        fetchImpl: async (input: string | URL | Request) => {
          requests += 1;
          return requests === 1
            ? new Response("rate limited", { status: 429, headers: { "retry-after": "60" } })
            : fixture.fetchImpl(input);
        },
      }),
    ).rejects.toThrow(/deadline/u);
    expect(requests).toBe(1);
  });

  it.each([false, true])(
    "rejects corrupt archive bytes (already retained: %s)",
    async (retained) => {
      const fixture = createDownloadFixture();
      const archivePath = path.join(tempDir(), "retained.zip");
      const corrupt = Buffer.from(fixture.zip);
      corrupt.writeUInt32LE(0, 0);
      if (retained) {
        writeFileSync(archivePath, corrupt);
      }
      let archiveRequests = 0;
      await expect(
        downloadFixture(fixture, {
          archivePath,
          fetchImpl: async (input: string | URL | Request) => {
            if (String(input).endsWith("/zip")) {
              archiveRequests += 1;
              if (!retained) {
                return new Response(new Uint8Array(corrupt));
              }
            }
            return fixture.fetchImpl(input);
          },
        }),
      ).rejects.toThrow(/digest/u);
      expect(archiveRequests).toBe(retained ? 0 : 1);
      if (retained) {
        expect(readFileSync(archivePath)).toEqual(corrupt);
      } else {
        expect(existsSync(archivePath)).toBe(false);
      }
    },
  );

  it("recovers HTTP transfers and reuses only verified bytes after revalidating the producer", async () => {
    const fixture = createDownloadFixture();
    const archivePath = path.join(tempDir(), "retained.zip");
    let artifactRequests = 0;
    let archiveRequests = 0;
    let retryAt = 0;
    const server = createServer((request, response) => {
      if (request.url?.endsWith(`/actions/artifacts/${ARTIFACT_ID}`)) {
        artifactRequests += 1;
        if (artifactRequests === 1) {
          retryAt = Date.now() + 1000;
          response.writeHead(429, { "retry-after": "1" }).end("rate limited");
        } else if (Date.now() < retryAt) {
          response.writeHead(400).end("retried before Retry-After");
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(fixture.artifactMetadata));
        }
      } else if (request.url?.endsWith(`/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(fixture.workflowRun));
      } else if (request.url?.endsWith("/zip")) {
        archiveRequests += 1;
        response.writeHead(302, { location: `/payload-${archiveRequests}` }).end();
      } else if (request.url?.startsWith("/payload-")) {
        response.writeHead(200, { "content-length": String(fixture.zip.length) });
        if (archiveRequests === 1) {
          response.write(fixture.zip.subarray(0, 16));
          setImmediate(() => response.destroy());
        } else {
          response.end(fixture.zip);
        }
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP artifact fixture did not bind a TCP port.");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const download = () =>
        downloadFixture(fixture, {
          archivePath,
          fetchImpl: (input: string | URL | Request, init?: RequestInit) =>
            fetch(new URL(new URL(String(input)).pathname, origin), init),
        });
      await download();
      expect(readFileSync(archivePath)).toEqual(fixture.zip);
      await download();
      expect(archiveRequests).toBe(2);
      fixture.workflowRun.conclusion = "cancelled";
      await expect(download()).rejects.toThrow("immutable publication tuple");
      expect(archiveRequests).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reuses only an exact successful producer job from the current or a prior attempt", async () => {
    const producerJobName = "Pack immutable ClawHub bootstrap artifacts";

    async function downloadForAttempts(
      producerAttempt: number,
      consumerAttempt: number,
      producerConclusion = "success",
    ) {
      const fixture = createDownloadFixture(producerAttempt, {
        contentLength: true,
        expires: false,
      });
      Object.assign(fixture.workflowRun, {
        status: producerAttempt === consumerAttempt ? "in_progress" : "completed",
        conclusion: producerAttempt === consumerAttempt ? null : "failure",
      });
      fixture.bodies.set(
        `/actions/runs/${RUN_ID}/attempts/${producerAttempt}/jobs?per_page=100`,
        workflowJobsMetadata(producerJobName, producerAttempt, producerConclusion),
      );

      return downloadFixture(fixture, {
        expected: {
          ...fixture.expected,
          consumerRunAttempt: consumerAttempt,
          producerJobName,
          runStatePolicy: "same-run-producer-success",
        },
        maxArchiveBytes: 1024 * 1024,
        retryAttempts: 1,
      });
    }

    await expect(downloadForAttempts(2, 2)).resolves.toMatchObject({
      workflowJobs: { total_count: 1 },
    });
    await expect(downloadForAttempts(1, 2)).resolves.toMatchObject({
      workflowRun: { conclusion: "failure", status: "completed" },
    });
    await expect(downloadForAttempts(1, 2, "failure")).rejects.toThrow(
      "Actions artifact producer job did not complete successfully.",
    );
    await expect(downloadForAttempts(3, 2)).rejects.toThrow(
      "Producer workflow run attempt must not be newer than the consumer attempt.",
    );
  });

  it("rejects ZIP traversal, additional files, and byte tampering", () => {
    const fixture = createFixture();
    const manifest = readFileSync(fixture.created.manifestPath);
    const malformedArtifacts: Array<[RegExp, ZipFile[]]> = [
      [
        /Unsafe ZIP entry path/u,
        [
          zipFile(TARBALL_NAME, fixture.tarball),
          zipFile("../plugin-publication-manifest.json", manifest),
        ],
      ],
      [
        /must contain between 2 and 2 exact files/u,
        [
          zipFile(TARBALL_NAME, fixture.tarball),
          zipFile("plugin-publication-manifest.json", manifest),
          zipFile("extra.txt", "unexpected"),
        ],
      ],
    ];
    for (const [expected, files] of malformedArtifacts) {
      replaceArtifactZip(fixture, files);
      expectVerifyError(fixture, expected);
    }

    const tamperFixture = createFixture();
    const tampered = Buffer.from(tamperFixture.zip);
    tampered[35] = tampered.readUInt8(35) ^ 0xff;
    writeFileSync(tamperFixture.zipPath, tampered);
    expectVerifyError(tamperFixture, /digest/u);
  });

  it("rejects changed ZIP payload bytes with matching header checksums", () => {
    const zip = createZip([{ bytes: Buffer.from("payload"), name: "payload.txt" }]);
    const dataOffset = 30 + Buffer.byteLength("payload.txt");
    // Keep both header CRCs unchanged so corruption reaches the payload check.
    zip[dataOffset] = zip.readUInt8(dataOffset) ^ 0xff;

    expect(() => inspectTestZip(zip)).toThrow(/checksum mismatch for payload\.txt/u);
  });

  it("accepts canonical signed data descriptors and rejects noncanonical ZIP structure", () => {
    const canonical = createZip([
      zipFile("descriptor.txt", "descriptor", { compression: 8, descriptor: true }),
    ]);
    expect(inspectTestZip(canonical).get("descriptor.txt")?.toString()).toBe("descriptor");

    expect(() => inspectTestZip(Buffer.concat([canonical, Buffer.from("trailing")]))).toThrow(
      /exact terminal end-of-central-directory/u,
    );
    expectZipFileError("gap.txt", { gapAfter: Buffer.from([0]) }, /gap or overlap/u);
    expectZipFileError("crc.txt", { localCrc: 0 }, /local sizes or CRC/u);
    expectZipFileError(
      "descriptor.txt",
      { descriptor: true, descriptorCrc: 0 },
      /data descriptor/u,
    );
  });

  it("rejects unsupported flags, invalid names, aliases, and trailing deflate bytes", () => {
    for (const flags of [0x0040, 0x2000]) {
      expectZipFileError("flags.txt", { flags }, /Unsupported Actions artifact ZIP flags/u);
    }

    expectZipFileError("m\u00e9ta.txt", {}, /must set the UTF-8 language flag/u);
    expect(
      inspectTestZip(createZip([zipFile("m\u00e9ta.txt", "x", { flags: 0x0800 })])).has(
        "m\u00e9ta.txt",
      ),
    ).toBe(true);
    expectZipFileError(
      "invalid.txt",
      { flags: 0x0800, nameBytes: Buffer.from([0xff]) },
      /not valid UTF-8/u,
    );
    expectZipFileError(
      "central.txt",
      { localNameBytes: Buffer.from("other.txt") },
      /local and central names differ/u,
    );
    expectZipError([zipFile("Case.txt", "a"), zipFile("case.txt", "b")], /duplicate, or aliased/u);

    const content = Buffer.from("deflate");
    expectZipError(
      [
        zipFile("deflate.txt", content, {
          compressedBytes: Buffer.concat([deflateRawSync(content), Buffer.from([0, 1])]),
          compression: 8,
        }),
      ],
      /entry expansion exceeds/u,
    );
    expect(() =>
      inspectTestZip(createZip([zipFile("cap.txt", "compressed")]), {
        maxCompressedEntryBytes: () => 1,
      }),
    ).toThrow(/entry is too large/u);
  });

  it("caps publication JSON and tarball members before ZIP expansion", () => {
    const fixture = createFixture();
    const manifest = readFileSync(fixture.created.manifestPath);
    const oversizedManifest = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
    for (const declaredExpandedSize of [undefined, 1]) {
      replaceArtifactZip(fixture, [
        zipFile(TARBALL_NAME, fixture.tarball),
        zipFile("plugin-publication-manifest.json", oversizedManifest, {
          compression: 8,
          declaredExpandedSize,
        }),
      ]);
      expectVerifyError(
        fixture,
        declaredExpandedSize === undefined
          ? /entry is too large: plugin-publication-manifest\.json/u
          : /entry expansion exceeds its allowed range: plugin-publication-manifest\.json/u,
      );
    }
    replaceArtifactZip(fixture, [
      zipFile(TARBALL_NAME, fixture.tarball, {
        compression: 8,
        declaredExpandedSize: 256 * 1024 * 1024 + 1,
      }),
      zipFile("plugin-publication-manifest.json", manifest),
    ]);
    expectVerifyError(
      fixture,
      new RegExp(`entry is too large: ${TARBALL_NAME.replaceAll(".", "\\.")}`, "u"),
    );
  });

  it("caps the number of tar headers before retaining their inventory", () => {
    const { artifactDir } = stageTarball((markerPath) =>
      createTarball([
        ...packageEntries(markerPath),
        ...Array.from({ length: 20_000 }, (_, index) => ({
          path: `package/file-${index.toString().padStart(5, "0")}`,
        })),
      ]),
    );
    expectTarballError(artifactDir, /exceeds the 20000 entry limit/u);
  });

  it("rejects concatenated gzip members before trusting combined tar inventory", () => {
    const { artifactDir } = stageTarball((markerPath) => {
      const firstMember = gzipSync(
        Buffer.concat([
          ...packageEntries(markerPath).map(tarEntry),
          tarEntry({ content: '{"id":"meta"}\n', path: "package/openclaw.plugin.json" }),
        ]),
      );
      const secondMember = createTarball([
        { content: "hidden from the pinned ClawHub reader\n", path: "package/second-member.txt" },
      ]);
      return Buffer.concat([firstMember, secondMember]);
    });
    expectTarballError(artifactDir, /must contain exactly one gzip member/u);
  });

  it("rejects a hidden duplicate package.json after a single zero tar block", () => {
    const { artifactDir, markerPath } = stageTarball((marker) =>
      createTarballFromParts([
        ...packageEntries(marker).map(tarEntry),
        Buffer.alloc(512),
        tarEntry({
          content: metaPackageJson(marker, {
            scripts: { postinstall: lifecycleScript(marker, "hidden") },
          }),
          path: "package/package.json",
        }),
      ]),
    );
    expectTarballError(
      artifactDir,
      /must end with two zero blocks and contain no trailing entries/u,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each([
    ["nonzero directory size", {}, "x", /Directory tar entry "package\/" must have size zero/u],
    [
      "trailing slash",
      { path: "package/package.json/" },
      undefined,
      /Non-directory tar entry must not end with a slash/u,
    ],
    [
      "whitespace prefix",
      { path: "package.json", prefix: " package" },
      undefined,
      /tar entry prefix changes under the pinned ClawHub path normalization/u,
    ],
    [
      "V7 prefix",
      { path: "package.json", prefix: "package", format: "v7" },
      undefined,
      /canonical POSIX USTAR headers/u,
    ],
  ] as const)("rejects tar manifest ambiguity: %s", (kind, fields, content, message) => {
    const { artifactDir, markerPath, tarballPath } = stageTarball((marker) => {
      const smuggled = kind === "whitespace prefix";
      return createTarball([
        { path: "package/", type: "5", content },
        manifestEntry(
          marker,
          fields,
          smuggled ? { scripts: { postinstall: lifecycleScript(marker, "smuggled") } } : {},
        ),
        ...(smuggled ? [manifestEntry(marker)] : []),
      ]);
    });
    if (kind === "trailing slash") {
      expect(consumerTarEntries(tarballPath).at(-1)).toMatchObject({
        path: "package/package.json/",
        size: 0,
        type: "Directory",
      });
    } else if (kind === "V7 prefix") {
      const paths = consumerTarEntries(tarballPath).map((entry) => entry.path);
      expect(paths).toContain("package.json");
      expect(paths).not.toContain("package/package.json");
    }
    expectTarballError(artifactDir, message);
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each([
    {
      label: "regular-file link path",
      mutate(header: Buffer) {
        writeTarString(header, 157, 100, "package/alias");
      },
      message: /Plugin tar entries must not carry link targets/u,
    },
    {
      label: "hidden link-path padding",
      mutate(header: Buffer) {
        header.fill(0, 157, 257);
        Buffer.from("\0\nhidden-link", "utf8").copy(header, 157);
      },
      message: /tar entry link path has non-zero bytes after its NUL terminator/u,
    },
    {
      label: "unterminated checksum",
      mutate(header: Buffer) {
        const checksum = Number.parseInt(header.subarray(148, 156).toString("ascii").trim(), 8);
        writeTarString(header, 148, 8, checksum.toString(8).padStart(8, "0"));
      },
      preserveChecksumBytes: true,
      message: /tar checksum is not canonically encoded/u,
    },
    {
      label: "invalid base-256 mode",
      mutate(header: Buffer) {
        header.fill(0, 100, 108);
        header[100] = 0x81;
      },
      message: /tar entry mode must not use base-256 encoding/u,
    },
  ])("rejects $label headers that make npm consume a nested manifest", (testCase) => {
    const { artifactDir, markerPath, tarballPath } = stagingFixture();

    const nestedManifest = tarEntry({
      content: metaPackageJson(markerPath, {
        scripts: { postinstall: lifecycleScript(markerPath, "smuggled") },
        tag: "latest",
      }),
      path: "package/package.json",
    });
    const decoy = mutateTarEntryHeader(
      tarEntry({
        content: nestedManifest,
        path: "package/decoy",
      }),
      testCase.mutate,
      { preserveChecksumBytes: testCase.preserveChecksumBytes },
    );
    writeFileSync(
      tarballPath,
      createTarballFromParts([...packageEntries(markerPath).map(tarEntry), decoy]),
    );

    const consumerPaths = consumerTarEntries(tarballPath).map((entry) => entry.path);
    expect(consumerPaths.filter((entryPath) => entryPath === "package/package.json")).toHaveLength(
      2,
    );
    expectTarballError(artifactDir, testCase.message);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("rejects canonical PAX metadata for every plugin publication route", () => {
    const { artifactDir, markerPath, tarballPath } = stagingFixture();
    const longPath = `package/${"nested/".repeat(18)}index.js`;
    const content = Buffer.from("export {};\n", "utf8");
    const tarball = createTarball([
      ...packageEntries(markerPath),
      {
        content: Buffer.concat([
          paxRecord("path", longPath),
          paxRecord("size", String(content.length)),
        ]),
        path: "PaxHeader",
        type: "x",
      },
      { content, path: "package/placeholder.js" },
    ]);
    writeFileSync(tarballPath, tarball);
    for (const controls of [
      { route: "npm-token-bootstrap" },
      { route: "clawhub-token-release" },
      { bootstrapMode: "publish", route: "clawhub-token-bootstrap" },
      { route: "clawhub-readback" },
    ]) {
      expectTarballError(artifactDir, /PAX and GNU tar metadata are not supported/u, controls);
    }
  });

  it("rejects beta npm artifacts bound to latest or extended-stable", () => {
    const fixture = createFixture();
    expectTarballError(fixture.artifactDir, /does not match release channel beta/u, {
      publishTag: "latest",
    });
    expectTarballError(fixture.artifactDir, /Extended-stable npm publication requires/u, {
      publishTag: "extended-stable",
    });
  });

  it.each([
    { overrides: { tag: "latest" }, message: /must not override the approved publication tag/u },
    {
      overrides: { publishConfig: { tag: "beta" } },
      message: /must not override publication through publishConfig/u,
    },
  ])("rejects packed publication overrides: $overrides", ({ overrides, message }) => {
    expect(() =>
      createFixture({
        packageJson: metaPackageJson(path.join(tempDir(), "marker"), overrides),
      }),
    ).toThrow(message);
  });

  it("rejects traversal, links, and special entries inside the plugin tarball", () => {
    for (const badEntry of [
      { content: "bad", path: "package/../escape" },
      { linkPath: "package/package.json", path: "package/alias", type: "2" as const },
      { path: "package/device", type: "3" as const },
    ]) {
      const { artifactDir, markerPath } = stageTarball((marker) =>
        createTarball([...packageEntries(marker), badEntry]),
      );
      expectTarballError(artifactDir);
      expect(existsSync(markerPath)).toBe(false);
    }
  });

  it.each([
    [{ openclaw: { release: { publishToClawHub: false, publishToNpm: true } } }, {}],
    [{ openclaw: { release: { publishToClawHub: true, publishToNpm: false } } }, {}],
    [{ name: "@openclaw/not-meta" }, { packageName: "@openclaw/not-meta" }],
    [{}, { packageDir: "extensions/not-meta" }],
  ])("requires exact Meta identity and publication flags (%#)", (manifest, params) => {
    const { artifactDir } = stageTarball((marker) =>
      createTarball([
        ...packageEntries(marker, manifest),
        { content: '{"id":"meta"}\n', path: "package/openclaw.plugin.json" },
      ]),
    );
    expectTarballError(
      artifactDir,
      /Meta publication requires extensions\/meta with npm and ClawHub enabled/u,
      params,
    );
  });
});
