import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClawHubBootstrapArtifactManifest,
  downloadClawHubBootstrapArtifact,
  verifyClawHubPackedArtifactIdentity,
  verifyClawHubBootstrapArtifactManifest,
} from "../../scripts/lib/clawhub-bootstrap-artifact.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const clawhubToolchainSha256 = "c".repeat(64);
const clawhubToolchainVersion = "0.23.1";
const clawhubToolchainIntegrity =
  "sha512-YvUImhsVaM90BUAv3uP7lfABziwR5XL3ch2Owa+GvNxwQ2xzZFmZC0yVjAtQbvep+dDDS16nUGRwKx7jqnTOEA==";
const version = "2026.7.1-beta.3";
const artifactIdentity = {
  artifactName: `clawhub-bootstrap-${targetSha.slice(0, 12)}-123-2`,
  clawhubToolchainIntegrity,
  clawhubToolchainSha256,
  clawhubToolchainVersion,
  repository: "openclaw/openclaw",
  runAttempt: "2",
  runId: "123",
  targetSha,
  workflowSha,
};
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
const packagePath = (root: string, name = "meta") =>
  join(root, "packages", name, `openclaw-${name}-${version}.tgz`);

function fixture() {
  const root = tempDirs.make("openclaw-clawhub-bootstrap-");
  const artifactRoot = join(root, "artifact");
  const matrix = (
    [
      ["meta", "publish", false],
      ["existing", "configure-only", true],
    ] as const
  ).map(([name, bootstrapMode, requiresManualOverride]) => {
    const packageRoot = join(artifactRoot, "packages", name);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(packagePath(artifactRoot, name), `packed ${name}`);
    return {
      packageName: `@openclaw/${name}`,
      version,
      packageDir: `extensions/${name}`,
      publishTag: "beta",
      bootstrapMode,
      family: "",
      requiresManualOverride,
    };
  });
  const matrixPath = join(root, "matrix.json");
  writeJson(matrixPath, matrix);
  return {
    artifactRoot,
    matrixPath,
    manifestPath: join(artifactRoot, "manifest.json"),
  };
}

function common(paths: ReturnType<typeof fixture>) {
  return {
    artifactRoot: paths.artifactRoot,
    plugins: "@openclaw/meta,@openclaw/existing",
    ...artifactIdentity,
  };
}

function createManifest(paths: ReturnType<typeof fixture>) {
  return createClawHubBootstrapArtifactManifest({
    ...common(paths),
    matrixPath: paths.matrixPath,
    outputPath: paths.manifestPath,
  });
}

function verifyManifest(
  paths: ReturnType<typeof fixture>,
  overrides: Partial<ReturnType<typeof common>> = {},
) {
  return verifyClawHubBootstrapArtifactManifest({
    ...common(paths),
    ...overrides,
    manifestPath: paths.manifestPath,
  });
}

function writeTarField(header: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength > length) {
    throw new Error(`tar field exceeds ${length} bytes`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number) {
  writeTarField(header, offset, length, `${value.toString(8).padStart(length - 2, "0")} \0`);
}

function tarEntry(
  name: string,
  prefix: string,
  contents: string | Uint8Array,
  type: "0" | "5" = "0",
) {
  const bytes = Buffer.from(contents);
  const header = Buffer.alloc(512);
  writeTarField(header, 0, 100, name);
  writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeTarOctal(header, 124, 12, bytes.byteLength);
  writeTarOctal(header, 136, 12, 0);
  for (const offset of [108, 116, 329, 337]) {
    writeTarOctal(header, offset, 8, 0);
  }
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeTarField(header, 257, 6, "ustar\0");
  writeTarField(header, 263, 2, "00");
  writeTarField(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarOctal(header, 148, 8, checksum);
  const padding = Buffer.alloc((512 - (bytes.byteLength % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

type PackEntry = { name: string; prefix?: string; contents: string | Uint8Array; type?: "0" | "5" };
function writePackBytes(bytes: Buffer) {
  const root = tempDirs.make("openclaw-clawhub-packed-");
  const artifactPath = join(root, "package.tgz");
  writeFileSync(artifactPath, bytes);
  return { artifactPath, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function writeClawPack(entries: PackEntry[]) {
  return writePackBytes(
    gzipSync(
      Buffer.concat([
        ...entries.map((entry) =>
          tarEntry(entry.name, entry.prefix ?? "", entry.contents, entry.type),
        ),
        Buffer.alloc(1024),
      ]),
    ),
  );
}

it.each([{ version: "2026.7.1-alpha.3" }, { publishTag: "alpha" }])(
  "rejects retired alpha bootstrap %j",
  async (override) => {
    const paths = fixture();
    const matrix = JSON.parse(readFileSync(paths.matrixPath, "utf8"));
    Object.assign(matrix[0], override);
    writeJson(paths.matrixPath, matrix);
    await expect(createManifest(paths)).rejects.toThrow("Alpha releases are retired;");
  },
);

describe("ClawHub bootstrap artifact manifest", () => {
  it("binds the exact package set and packed file identity", async () => {
    const paths = fixture();
    const created = await createManifest(paths);
    for (const [name, size] of [
      ["meta", 11],
      ["existing", 15],
    ] as const) {
      const entry = created.entries.find((item) => item.packageName === `@openclaw/${name}`);
      expect(entry).toMatchObject({
        artifactPath: `packages/${name}/openclaw-${name}-2026.7.1-beta.3.tgz`,
        size,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    }
    expect(created).toMatchObject({
      clawhubToolchainIntegrity,
      clawhubToolchainSha256,
      clawhubToolchainVersion,
    });

    await expect(verifyManifest(paths)).resolves.toEqual(created);
  });

  it("rejects changed bytes and extra artifact files", async () => {
    const paths = fixture();
    await createManifest(paths);
    writeFileSync(packagePath(paths.artifactRoot), "changed");
    await expect(verifyManifest(paths)).rejects.toThrow("packed artifact hash or size mismatch");

    writeFileSync(packagePath(paths.artifactRoot), "packed meta");
    writeFileSync(join(paths.artifactRoot, "unexpected.txt"), "unexpected");
    await expect(verifyManifest(paths)).rejects.toThrow("artifact inventory mismatch");
  });

  it("uses one exact fatal-UTF8 manifest schema for local and archive consumers", async () => {
    const paths = fixture();
    const created = await createManifest(paths);

    writeFileSync(paths.manifestPath, Buffer.from([0xff]));
    await expect(verifyManifest(paths)).rejects.toThrow("not valid UTF-8 JSON");

    writeJson(paths.manifestPath, created);
    await expect(verifyManifest(paths, { clawhubToolchainSha256: "d".repeat(64) })).rejects.toThrow(
      "clawhubToolchainSha256 mismatch",
    );

    writeJson(paths.manifestPath, { ...created, entries: [null, ...created.entries.slice(1)] });
    await expect(verifyManifest(paths)).rejects.toThrow("manifest.entries[0] must be an object");
  });

  it("rejects preexisting and symlinked download output roots before fetching", async () => {
    const paths = fixture();
    const downloadOptions = {
      workflowHeadBranch: "main",
      workflowRef: "refs/heads/main",
      artifactDigest: "d".repeat(64),
      artifactId: "456",
      artifactSize: "1",
      ...artifactIdentity,
      consumerRunAttempt: "2",
      producerJobName: "Pack immutable ClawHub bootstrap artifacts",
      token: "test-token",
      fetchImpl: (() => {
        throw new Error("fetch must not run");
      }) as typeof fetch,
    };
    const download = (outputRoot: string, overrides: Partial<typeof downloadOptions> = {}) =>
      downloadClawHubBootstrapArtifact({ ...downloadOptions, outputRoot, ...overrides });

    const existingRoot = join(paths.artifactRoot, "existing-output");
    mkdirSync(existingRoot);
    await expect(download(existingRoot)).rejects.toThrow("output directory must not already exist");
    await expect(
      download(existingRoot, {
        workflowHeadBranch: `release-publish/${workflowSha.slice(0, 12)}-123`,
        workflowRef: `refs/tags/release-publish/${workflowSha.slice(0, 12)}-123`,
      }),
    ).rejects.toThrow("output directory must not already exist");

    const symlinkTarget = join(paths.artifactRoot, "symlink-target");
    const symlinkRoot = join(paths.artifactRoot, "symlink-output");
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, symlinkRoot);
    await expect(download(symlinkRoot)).rejects.toThrow("output directory must not already exist");

    await expect(
      download(join(paths.artifactRoot, "unused-output"), {
        workflowHeadBranch: `release-publish/${workflowSha.slice(0, 12)}-123`,
        workflowRef: `refs/heads/release-publish/${workflowSha.slice(0, 12)}-123`,
      }),
    ).rejects.toThrow("workflowRef must be main or the SHA-pinned release-publish tag");
  });
});

describe("ClawHub packed artifact identity", () => {
  const expectedIdentity = {
    expectedDir: "extensions/meta",
    expectedName: "@openclaw/meta-provider",
    expectedVersion: version,
  };
  function verifyPack(
    pack: Pick<ReturnType<typeof writeClawPack>, "artifactPath" | "sha256" | "bytes">,
  ) {
    return verifyClawHubPackedArtifactIdentity({
      artifactPath: pack.artifactPath,
      expectedSha256: pack.sha256,
      expectedSize: String(pack.bytes.byteLength),
      ...expectedIdentity,
    });
  }

  it("accepts one canonical package identity and plugin manifest", async () => {
    const pack = writeClawPack([
      {
        name: "package.json",
        prefix: "package",
        contents: JSON.stringify({
          name: expectedIdentity.expectedName,
          version,
          openclaw: { release: { publishToClawHub: true, publishToNpm: true } },
        }),
      },
      {
        name: "openclaw.plugin.json",
        prefix: "package",
        contents: JSON.stringify({ id: "meta" }),
      },
    ]);

    await expect(verifyPack(pack)).resolves.toMatchObject({
      packageName: "@openclaw/meta-provider",
      packageVersion: "2026.7.1-beta.3",
      sha256: pack.sha256,
      size: pack.bytes.byteLength,
    });
  });

  it("rejects a compressed artifact above the ClawHub package limit before reading it", async () => {
    const root = tempDirs.make("openclaw-clawhub-packed-limit-");
    const artifactPath = join(root, "oversized.tgz");
    writeFileSync(artifactPath, "");
    truncateSync(artifactPath, 120 * 1024 * 1024 + 1);

    await expect(
      verifyClawHubPackedArtifactIdentity({
        artifactPath,
        expectedSha256: "a".repeat(64),
        expectedSize: "1",
        ...expectedIdentity,
      }),
    ).rejects.toThrow("exceeds 125829120 bytes");
  });

  it("bounds expanded tar bytes", async () => {
    const pack = writePackBytes(gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)));
    await expect(verifyPack(pack)).rejects.toThrow("expands beyond 67108864 bytes");
  });

  it.each([
    {
      limit: "individual file payloads",
      entries: () => [{ name: "package/large.bin", contents: Buffer.alloc(50 * 1024 * 1024 + 1) }],
      error: "entry package/large.bin exceeds 52428800 bytes",
    },
    {
      limit: "total file payload bytes",
      entries: () =>
        Array.from({ length: 6 }, (_, index) => ({
          name: `package/chunk-${index}.bin`,
          contents: Buffer.alloc(9 * 1024 * 1024),
        })),
      error: "file payload exceeds 52428800 bytes",
    },
    {
      limit: "the total number of TAR entries",
      entries: () => [
        ...Array.from({ length: 10_000 }, (_, index) => ({
          name: `package/dir-${index}/`,
          contents: "",
          type: "5" as const,
        })),
        { name: "package/package.json", contents: "{}", type: "0" as const },
      ],
      error: "exceeds the 10000 entry limit",
    },
  ])("bounds $limit", async ({ entries, error }) => {
    await expect(verifyPack(writeClawPack(entries()))).rejects.toThrow(error);
  });
});
