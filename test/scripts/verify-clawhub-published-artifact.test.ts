import { createHash } from "node:crypto";
/* oxlint-disable typescript/no-base-to-string -- fetch mocks normalize standard RequestInfo inputs for registry URL assertions. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  verifyPublishedClawHubArtifacts,
  verifyPublishedClawHubPackage,
} from "../../scripts/verify-clawhub-published-artifact.mjs";

const tempDirs: string[] = [];
const bytes = new TextEncoder().encode("expected");
const wrongBytes = new TextEncoder().encode("wrong");
const digestMismatch = "artifact sha256 mismatch";
const clawhubToolchainSha256 = "d".repeat(64);
const clawhubToolchainVersion = "0.23.1";
const clawhubToolchainIntegrity =
  "sha512-YvUImhsVaM90BUAv3uP7lfABziwR5XL3ch2Owa+GvNxwQ2xzZFmZC0yVjAtQbvep+dDDS16nUGRwKx7jqnTOEA==";

const packageCoordinates = {
  packageName: "@openclaw/meta",
  packageVersion: "2026.7.1-beta.3",
  publishTag: "beta",
};

const manifestDefaults = {
  artifactDigest: "c".repeat(64),
  artifactId: "456",
  clawhubToolchainIntegrity,
  clawhubToolchainSha256,
  clawhubToolchainVersion,
  mode: "configure-only-preflight",
  registry: "https://clawhub.example",
  terminalRunAttempt: "1",
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identity(artifact: Uint8Array) {
  return {
    sha256: createHash("sha256").update(artifact).digest("hex"),
    size: artifact.byteLength,
    npmIntegrity: `sha512-${createHash("sha512").update(artifact).digest("base64")}`,
    npmShasum: createHash("sha1").update(artifact).digest("hex"),
  };
}

function writeManifest(mode: "publish" | "configure-only", artifact: Uint8Array, runAttempt = "1") {
  const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-readback-"));
  tempDirs.push(root);
  const path = join(root, "manifest.json");
  const artifactIdentity = identity(artifact);
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      repository: "openclaw/openclaw",
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
      runId: "123",
      runAttempt,
      artifactName: `clawhub-bootstrap-aaaaaaaaaaaa-123-${runAttempt}`,
      clawhubToolchainIntegrity,
      clawhubToolchainSha256,
      clawhubToolchainVersion,
      requestedPlugins: ["@openclaw/meta"],
      entries: [
        {
          packageName: "@openclaw/meta",
          version: "2026.7.1-beta.3",
          packageDir: "extensions/meta",
          publishTag: "beta",
          bootstrapMode: mode,
          family: "",
          requiresManualOverride: mode === "configure-only",
          artifactPath: "packages/meta/openclaw-meta-2026.7.1-beta.3.tgz",
          sha256: artifactIdentity.sha256,
          size: artifactIdentity.size,
        },
      ],
    }),
  );
  return path;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RetryOptions = {
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

function verifyManifest(
  fetchImpl: Fetch,
  overrides: Partial<typeof manifestDefaults> & { manifestPath?: string } = {},
  retryOptions: RetryOptions = {},
) {
  return verifyPublishedClawHubArtifacts({
    ...manifestDefaults,
    manifestPath: overrides.manifestPath ?? writeManifest("configure-only", bytes),
    ...overrides,
    retryOptions: { fetchImpl, attempts: 1, delayMs: 1, ...retryOptions },
  });
}

function verifyPackage(
  expectedArtifactDir: string,
  retryOptions: RetryOptions & { fetchImpl: Fetch },
) {
  return verifyPublishedClawHubPackage({
    ...packageCoordinates,
    expectedArtifactDir,
    retryOptions,
    registry: "https://clawhub.example",
  });
}

function writeExpectedArtifact(artifact: Uint8Array) {
  const artifactDir = mkdtempSync(join(tmpdir(), "openclaw-clawhub-oidc-readback-"));
  tempDirs.push(artifactDir);
  writeFileSync(join(artifactDir, "openclaw-meta-2026.7.1-beta.3.tgz"), artifact);
  return artifactDir;
}

function artifactResponse(artifact: Uint8Array, body: BodyInit = artifact as unknown as BodyInit) {
  const artifactIdentity = identity(artifact);
  return new Response(body, {
    headers: {
      "content-length": String(artifact.byteLength),
      "x-clawhub-artifact-sha256": artifactIdentity.sha256,
      "x-clawhub-npm-integrity": artifactIdentity.npmIntegrity,
      "x-clawhub-npm-shasum": artifactIdentity.npmShasum,
    },
  });
}

function metadataResponse(artifact: Uint8Array) {
  return Response.json({
    package: { name: "@openclaw/meta" },
    version: "2026.7.1-beta.3",
    artifact: { kind: "npm-pack", ...identity(artifact) },
  });
}

function registryFetch(artifact: Uint8Array) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/trusted-publisher")) {
      return Response.json({
        trustedPublisher: {
          provider: "github-actions",
          repository: "openclaw/openclaw",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: null,
        },
      });
    }
    if (url.endsWith("/artifact/download")) {
      return artifactResponse(artifact);
    }
    if (url.endsWith("/artifact")) {
      return metadataResponse(artifact);
    }
    return Response.json({ package: { tags: { beta: "2026.7.1-beta.3" } } });
  });
}

it("verifies exact artifact bytes without claiming the publication authentication", async () => {
  const fetchImpl = registryFetch(bytes);
  const evidence = await verifyPackage(writeExpectedArtifact(bytes), {
    fetchImpl,
    attempts: 1,
    delayMs: 1,
  });

  expect(evidence).toMatchObject({
    schemaVersion: 1,
    verificationMode: "artifact-postpublish",
    publicationAuthentication: "not-verified",
    expectedArtifact: identity(bytes),
    package: {
      packageName: "@openclaw/meta",
      registrySha256: identity(bytes).sha256,
      registrySize: bytes.byteLength,
    },
  });
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

it("rejects ambiguous or symlinked normal OIDC artifacts before registry access", async () => {
  const fetchImpl = registryFetch(bytes);
  const ambiguous = writeExpectedArtifact(bytes);
  writeFileSync(join(ambiguous, "second.tgz"), bytes);
  await expect(verifyPackage(ambiguous, { fetchImpl, attempts: 1, delayMs: 1 })).rejects.toThrow(
    "exactly one root .tgz regular file",
  );

  const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-oidc-symlink-"));
  tempDirs.push(root);
  const artifactDir = join(root, "artifact");
  const target = join(root, "target.tgz");
  mkdirSync(artifactDir);
  writeFileSync(target, bytes);
  symlinkSync(target, join(artifactDir, "linked.tgz"));
  await expect(verifyPackage(artifactDir, { fetchImpl, attempts: 1, delayMs: 1 })).rejects.toThrow(
    "exactly one root .tgz regular file",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("rejects a missing configure-only tag before artifact or publisher requests", async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
    Response.json({ package: { tags: { beta: "2026.7.1-beta.2" } } }),
  );

  await expect(
    verifyManifest(fetchImpl, { manifestPath: writeManifest("configure-only", bytes) }),
  ).rejects.toThrow("@openclaw/meta ClawHub tag beta mismatch");
  expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
    "https://clawhub.example/api/v1/packages/%40openclaw%2Fmeta",
  ]);
});

it.each([
  ["invalid UTF-8", "detail", () => new Response(new Uint8Array([0xff])), "invalid JSON"],
  [
    "missing artifact object",
    "metadata",
    () => Response.json({ package: { name: "@openclaw/meta" } }),
    "missing or invalid",
  ],
  [
    "conflicting publisher",
    "publisher",
    () => Response.json({ trustedPublisher: { provider: "other" } }),
    "provider mismatch",
  ],
  ["conflicting bytes", "download", () => artifactResponse(wrongBytes), digestMismatch],
  ["conflicting metadata", "metadata", () => metadataResponse(wrongBytes), digestMismatch],
  [
    "conflicting header",
    "download",
    (artifact: Uint8Array) => {
      const response = artifactResponse(artifact);
      response.headers.set("x-clawhub-artifact-sha256", "0".repeat(64));
      return response;
    },
    "header mismatch",
  ],
  ["absent body", "detail", () => new Response(null), "no response body"],
] as const)(
  "does not retry %s before a later valid response",
  async (_label, stage, failure, message) => {
    const healthy = registryFetch(bytes);
    let failed = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const current = url.endsWith("/artifact/download")
        ? "download"
        : url.endsWith("/artifact")
          ? "metadata"
          : url.endsWith("/trusted-publisher")
            ? "publisher"
            : "detail";
      if (!failed && current === stage) {
        failed = true;
        return failure(bytes);
      }
      return healthy(input);
    });
    const sleep = vi.fn(async () => {});
    await expect(
      verifyPackage(writeExpectedArtifact(bytes), { fetchImpl, attempts: 3, delayMs: 1, sleep }),
    ).rejects.toThrow(message);
    expect(sleep).not.toHaveBeenCalled();
    // Metadata validation follows the artifact download.
    expect(fetchImpl).toHaveBeenCalledTimes(stage === "detail" ? 1 : stage === "publisher" ? 2 : 4);
  },
);

it("recovers a transient reset without publishing", async () => {
  const healthy = registryFetch(bytes);
  let failed = false;
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    if (!failed) {
      failed = true;
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      });
    }
    return healthy(input);
  });
  const sleep = vi.fn(async () => {});
  await expect(
    verifyManifest(
      fetchImpl,
      { manifestPath: writeManifest("publish", bytes), mode: "postpublish" },
      { attempts: 2, sleep },
    ),
  ).resolves.toMatchObject({ packages: [{ registrySha256: identity(bytes).sha256 }] });
  expect(sleep).toHaveBeenCalledExactlyOnceWith(1);
  expect(
    fetchImpl.mock.calls.every(([input]) =>
      String(input).startsWith("https://clawhub.example/api/v1/packages/"),
    ),
  ).toBe(true);
});

it("stops rather than retrying before an excessive server delay", async () => {
  const fetchImpl = vi.fn(
    async () => new Response(null, { status: 429, headers: { "retry-after": "61" } }),
  );
  const sleep = vi.fn(async () => {});
  await expect(
    verifyPackage(writeExpectedArtifact(bytes), { fetchImpl, attempts: 2, delayMs: 1, sleep }),
  ).rejects.toThrow("HTTP 429");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

it("keeps the attempt timeout active through a stalled body", async () => {
  let artifactCalls = 0;
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/artifact")) {
        return metadataResponse(bytes);
      }
      if (url.endsWith("/artifact/download")) {
        artifactCalls += 1;
        if (artifactCalls === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
          );
        }
        return artifactResponse(bytes);
      }
      if (!url.includes("/artifact")) {
        return Response.json({ package: { tags: { beta: "2026.7.1-beta.3" } } });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  );

  await expect(
    verifyManifest(fetchImpl, {}, { attempts: 2, timeoutMs: 10 }),
  ).resolves.toMatchObject({ packages: [{ registrySize: bytes.byteLength }] });
  expect(artifactCalls).toBe(2);
});

it("cancels retryable response bodies and never sleeps after the final attempt", async () => {
  const canceled: string[] = [];
  const sleep = vi.fn(async () => {});
  const fetchImpl = vi.fn(async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled.push("retry");
        },
      }),
      { status: 503 },
    );
  });
  await expect(verifyManifest(fetchImpl, {}, { attempts: 2, sleep })).rejects.toThrow(
    "did not stabilize after 2 attempts",
  );
  expect(canceled).toEqual(["retry", "retry"]);
  expect(sleep).toHaveBeenCalledTimes(1);
});

it.each([
  ["HTTP", "", 0, "returned HTTP 403", 1],
  ["metadata", "/artifact", 1048576, "exceeded 1048576 bytes", 2],
  ["artifact", "/artifact/download", 136314880, "exceeded 136314880 bytes", undefined],
] as const)(
  "fails immediately on permanent %s errors",
  async (kind, endpoint, limit, error, calls) => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (kind === "HTTP") {
        return new Response("denied", { status: 403 });
      }
      const url = String(input);
      if (url.endsWith(endpoint)) {
        return new Response(kind === "metadata" ? "{}" : null, {
          headers: { "content-length": String(limit + 1) },
        });
      }
      if (url.endsWith("/artifact")) {
        return metadataResponse(bytes);
      }
      return Response.json({ package: { tags: { beta: "2026.7.1-beta.3" } } });
    });
    await expect(verifyManifest(fetchImpl, {}, { attempts: 3, sleep })).rejects.toThrow(error);
    if (calls !== undefined) {
      expect(fetchImpl).toHaveBeenCalledTimes(calls);
    }
    expect(sleep).not.toHaveBeenCalled();
  },
);

it.each([
  ...[undefined, "0", "1junk", "1.5", "1e2"].map(
    (terminalRunAttempt) =>
      [{ terminalRunAttempt }, "terminalRunAttempt must be an integer"] as const,
  ),
  [{ artifactId: "1junk" }, "artifactId must be an integer"],
  [{ artifactDigest: "A".repeat(64) }, "artifactDigest is invalid"],
] satisfies ReadonlyArray<readonly [Partial<typeof manifestDefaults>, string]>)(
  "rejects invalid immutable binding %j",
  async (overrides, error) => {
    await expect(verifyManifest(registryFetch(bytes), overrides)).rejects.toThrow(error);
  },
);

it("requires a terminal attempt at or after the immutable producer attempt", async () => {
  await expect(
    verifyManifest(registryFetch(bytes), {
      manifestPath: writeManifest("configure-only", bytes, "2"),
    }),
  ).rejects.toThrow("greater than or equal to the producer run attempt");
});

it.each([
  ["A".repeat(64), clawhubToolchainSha256, "manifest.clawhubToolchainSha256 is invalid"],
  [clawhubToolchainSha256, "e".repeat(64), "clawhubToolchainSha256 mismatch"],
])("requires locked toolchain identity %s/%s", async (manifestSha, expectedSha, error) => {
  const manifestPath = writeManifest("configure-only", bytes);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, clawhubToolchainSha256: manifestSha }));
  await expect(
    verifyManifest(registryFetch(bytes), {
      manifestPath,
      clawhubToolchainSha256: expectedSha,
    }),
  ).rejects.toThrow(error);
});

it("rejects noncanonical, oversized, and symlinked manifests before registry access", async () => {
  const fetchImpl = registryFetch(bytes);
  const manifestPath = writeManifest("configure-only", bytes);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, unexpected: true }));
  await expect(verifyManifest(fetchImpl, { manifestPath })).rejects.toThrow("keys are invalid");

  const oversizedPath = writeManifest("configure-only", bytes);
  truncateSync(oversizedPath, 2 * 1024 * 1024 + 1);
  await expect(verifyManifest(fetchImpl, { manifestPath: oversizedPath })).rejects.toThrow(
    "size is outside the allowed range: 2097153",
  );

  const targetPath = writeManifest("configure-only", bytes);
  const symlinkPath = `${targetPath}.link`;
  symlinkSync(targetPath, symlinkPath);
  await expect(verifyManifest(fetchImpl, { manifestPath: symlinkPath })).rejects.toThrow(
    "must be a regular file",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});
