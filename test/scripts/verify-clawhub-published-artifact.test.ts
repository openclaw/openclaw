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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  verifyPublishedClawHubArtifacts,
  verifyPublishedClawHubPackage,
} from "../../scripts/verify-clawhub-published-artifact.mjs";

const tempDirs: string[] = [];
const clawhubToolchainSha256 = "d".repeat(64);
const clawhubToolchainVersion = "0.23.1";
const clawhubToolchainIntegrity =
  "sha512-YvUImhsVaM90BUAv3uP7lfABziwR5XL3ch2Owa+GvNxwQ2xzZFmZC0yVjAtQbvep+dDDS16nUGRwKx7jqnTOEA==";

function immutableBinding() {
  return {
    artifactDigest: "c".repeat(64),
    artifactId: "456",
    clawhubToolchainIntegrity,
    clawhubToolchainSha256,
    clawhubToolchainVersion,
  };
}

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

function writeExpectedArtifact(artifact: Uint8Array) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-oidc-readback-"));
  tempDirs.push(root);
  const artifactDir = join(root, "artifact");
  mkdirSync(artifactDir);
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

function metadataResponse(artifact: Uint8Array, body?: BodyInit) {
  const artifactIdentity = identity(artifact);
  return new Response(
    body ??
      JSON.stringify({
        package: { name: "@openclaw/meta" },
        version: "2026.7.1-beta.3",
        artifact: {
          kind: "npm-pack",
          sha256: artifactIdentity.sha256,
          size: artifactIdentity.size,
          npmIntegrity: artifactIdentity.npmIntegrity,
          npmShasum: artifactIdentity.npmShasum,
        },
      }),
    { headers: { "content-type": "application/json" } },
  );
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
    return Response.json({
      package: { tags: { beta: "2026.7.1-beta.3" } },
    });
  });
}

describe("ClawHub published artifact verification", () => {
  it("verifies exact artifact bytes without claiming the publication authentication", async () => {
    const artifact = new TextEncoder().encode("exact oidc tgz bytes");
    const fetchImpl = registryFetch(artifact);
    const evidence = await verifyPublishedClawHubPackage({
      expectedArtifactDir: writeExpectedArtifact(artifact),
      packageName: "@openclaw/meta",
      packageVersion: "2026.7.1-beta.3",
      publishTag: "beta",
      registry: "https://clawhub.example",
      retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      verificationMode: "artifact-postpublish",
      publicationAuthentication: "not-verified",
      expectedArtifact: identity(artifact),
      package: {
        packageName: "@openclaw/meta",
        registrySha256: identity(artifact).sha256,
        registrySize: artifact.byteLength,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rejects ambiguous or symlinked normal OIDC artifacts before registry access", async () => {
    const artifact = new TextEncoder().encode("exact oidc tgz bytes");
    const fetchImpl = registryFetch(artifact);
    const ambiguous = writeExpectedArtifact(artifact);
    writeFileSync(join(ambiguous, "second.tgz"), artifact);
    await expect(
      verifyPublishedClawHubPackage({
        expectedArtifactDir: ambiguous,
        packageName: "@openclaw/meta",
        packageVersion: "2026.7.1-beta.3",
        publishTag: "beta",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("exactly one root .tgz regular file");

    const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-oidc-symlink-"));
    tempDirs.push(root);
    const artifactDir = join(root, "artifact");
    const target = join(root, "target.tgz");
    mkdirSync(artifactDir);
    writeFileSync(target, artifact);
    symlinkSync(target, join(artifactDir, "linked.tgz"));
    await expect(
      verifyPublishedClawHubPackage({
        expectedArtifactDir: artifactDir,
        packageName: "@openclaw/meta",
        packageVersion: "2026.7.1-beta.3",
        publishTag: "beta",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("exactly one root .tgz regular file");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a missing configure-only tag before artifact or publisher requests", async () => {
    const artifact = new TextEncoder().encode("historical exact bytes");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        package: { tags: { beta: "2026.7.1-beta.2" } },
      }),
    );

    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("@openclaw/meta ClawHub tag beta mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/artifact"))).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/trusted-publisher"))).toBe(
      false,
    );
  });

  it.each([
    ["invalid JSON", "detail", () => new Response("{invalid"), "invalid JSON"],
    ["permanent HTTP", "detail", () => new Response(null, { status: 501 }), "HTTP 501"],
    [
      "conflicting tag",
      "detail",
      () => Response.json({ package: { tags: { beta: "2026.7.1-beta.2" } } }),
      "tag beta mismatch",
    ],
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
    [
      "conflicting bytes",
      "download",
      () => artifactResponse(new TextEncoder().encode("wrong")),
      "artifact sha256 mismatch",
    ],
    [
      "conflicting metadata",
      "metadata",
      () => metadataResponse(new TextEncoder().encode("wrong")),
      "artifact sha256 mismatch",
    ],
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
    [
      "permanent TLS",
      "detail",
      () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" }),
        });
      },
      "fetch failed",
    ],
    [
      "unknown transport failure",
      "detail",
      () => {
        throw new Error("unknown failure");
      },
      "unknown failure",
    ],
  ] as const)(
    "does not retry %s before a later valid response",
    async (_label, stage, failure, message) => {
      const artifact = new TextEncoder().encode("expected");
      const healthy = registryFetch(artifact);
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
          return failure(artifact);
        }
        return healthy(input);
      });
      const sleep = vi.fn(async () => {});
      await expect(
        verifyPublishedClawHubPackage({
          expectedArtifactDir: writeExpectedArtifact(artifact),
          packageName: "@openclaw/meta",
          packageVersion: "2026.7.1-beta.3",
          publishTag: "beta",
          registry: "https://clawhub.example",
          retryOptions: { fetchImpl, attempts: 3, delayMs: 1, sleep },
        }),
      ).rejects.toThrow(message);
      expect(sleep).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(
        stage === "detail" ? 1 : stage === "publisher" ? 2 : 4,
      );
    },
  );

  it.each(["reset", "body reset", "visibility", "rate limit"])(
    "recovers a transient %s without publishing",
    async (failure) => {
      const artifact = new TextEncoder().encode("expected");
      const healthy = registryFetch(artifact);
      let failed = false;
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        if (!failed && (failure !== "body reset" || String(input).endsWith("/artifact/download"))) {
          failed = true;
          if (failure === "reset") {
            throw new TypeError("fetch failed", {
              cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
            });
          }
          if (failure === "body reset") {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(
                    new TypeError("terminated", {
                      cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
                    }),
                  );
                },
              }),
            );
          }
          return new Response(null, {
            status: failure === "visibility" ? 404 : 429,
            headers: { "retry-after": "2" },
          });
        }
        return healthy(input);
      });
      const sleep = vi.fn(async () => {});
      await expect(
        verifyPublishedClawHubArtifacts({
          ...immutableBinding(),
          manifestPath: writeManifest("publish", artifact),
          registry: "https://clawhub.example",
          terminalRunAttempt: "1",
          retryOptions: { fetchImpl, attempts: 2, delayMs: 1, sleep },
        }),
      ).resolves.toMatchObject({ packages: [{ registrySha256: identity(artifact).sha256 }] });
      expect(sleep).toHaveBeenCalledExactlyOnceWith(
        failure === "visibility" || failure === "rate limit" ? 2000 : 1,
      );
      expect(
        fetchImpl.mock.calls.every(([input]) =>
          String(input).startsWith("https://clawhub.example/api/v1/packages/"),
        ),
      ).toBe(true);
    },
  );

  it("stops rather than retrying before an excessive server delay", async () => {
    const artifact = new TextEncoder().encode("expected");
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 429, headers: { "retry-after": "61" } }),
    );
    const sleep = vi.fn(async () => {});
    await expect(
      verifyPublishedClawHubPackage({
        expectedArtifactDir: writeExpectedArtifact(artifact),
        packageName: "@openclaw/meta",
        packageVersion: "2026.7.1-beta.3",
        publishTag: "beta",
        registry: "https://clawhub.example",
        retryOptions: { fetchImpl, attempts: 2, delayMs: 1, sleep },
      }),
    ).rejects.toThrow("HTTP 429");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps the attempt timeout active through a stalled body", async () => {
    const artifact = new TextEncoder().encode("expected");
    let artifactCalls = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/artifact")) {
          return metadataResponse(artifact);
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
          return artifactResponse(artifact);
        }
        if (!url.includes("/artifact")) {
          return Response.json({
            package: { tags: { beta: "2026.7.1-beta.3" } },
          });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    );

    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 2, delayMs: 1, timeoutMs: 10 },
      }),
    ).resolves.toMatchObject({ packages: [{ registrySize: artifact.byteLength }] });
    expect(artifactCalls).toBe(2);
  });

  it("cancels retryable response bodies and never sleeps after the final attempt", async () => {
    const artifact = new TextEncoder().encode("expected");
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
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 2, delayMs: 1, sleep },
      }),
    ).rejects.toThrow("did not stabilize after 2 attempts");
    expect(canceled).toEqual(["retry", "retry"]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("fails immediately on permanent HTTP errors and explicit size limits", async () => {
    const artifact = new TextEncoder().encode("expected");
    const permanentFetch = vi.fn(async () => new Response("denied", { status: 403 }));
    const permanentSleep = vi.fn(async () => {});
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: {
          fetchImpl: permanentFetch,
          attempts: 3,
          delayMs: 1,
          sleep: permanentSleep,
        },
      }),
    ).rejects.toThrow("returned HTTP 403");
    expect(permanentFetch).toHaveBeenCalledTimes(1);
    expect(permanentSleep).not.toHaveBeenCalled();

    const oversizedFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/artifact")) {
        return new Response("{}", {
          headers: { "content-length": String(1024 * 1024 + 1) },
        });
      }
      return Response.json({
        package: { tags: { beta: "2026.7.1-beta.3" } },
      });
    });
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl: oversizedFetch, attempts: 3, delayMs: 1 },
      }),
    ).rejects.toThrow("exceeded 1048576 bytes");
    expect(oversizedFetch).toHaveBeenCalledTimes(2);

    const oversizedArtifactFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/artifact/download")) {
        return new Response(null, {
          headers: { "content-length": String(130 * 1024 * 1024 + 1) },
        });
      }
      if (url.endsWith("/artifact")) {
        return metadataResponse(artifact);
      }
      return Response.json({
        package: { tags: { beta: "2026.7.1-beta.3" } },
      });
    });
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl: oversizedArtifactFetch, attempts: 3, delayMs: 1 },
      }),
    ).rejects.toThrow("exceeded 136314880 bytes");
  });

  it("requires a terminal attempt at or after the immutable producer attempt", async () => {
    const artifact = new TextEncoder().encode("expected");
    const baseOptions = {
      ...immutableBinding(),
      manifestPath: writeManifest("configure-only", artifact),
      mode: "configure-only-preflight",
      registry: "https://clawhub.example",
      retryOptions: { fetchImpl: registryFetch(artifact), attempts: 1, delayMs: 1 },
    };

    await expect(verifyPublishedClawHubArtifacts(baseOptions)).rejects.toThrow(
      "terminalRunAttempt must be an integer",
    );
    await expect(
      verifyPublishedClawHubArtifacts({ ...baseOptions, terminalRunAttempt: "0" }),
    ).rejects.toThrow("terminalRunAttempt must be an integer");
    await expect(
      verifyPublishedClawHubArtifacts({
        ...baseOptions,
        manifestPath: writeManifest("configure-only", artifact, "2"),
        terminalRunAttempt: "1",
      }),
    ).rejects.toThrow("greater than or equal to the producer run attempt");

    for (const invalid of ["1junk", "1.5", "1e2"]) {
      await expect(
        verifyPublishedClawHubArtifacts({
          ...baseOptions,
          terminalRunAttempt: invalid,
        }),
      ).rejects.toThrow("terminalRunAttempt must be an integer");
    }
    await expect(
      verifyPublishedClawHubArtifacts({
        ...baseOptions,
        artifactId: "1junk",
        terminalRunAttempt: "1",
      }),
    ).rejects.toThrow("artifactId must be an integer");
    await expect(
      verifyPublishedClawHubArtifacts({
        ...baseOptions,
        artifactDigest: "A".repeat(64),
        terminalRunAttempt: "1",
      }),
    ).rejects.toThrow("artifactDigest is invalid");
  });

  it("requires the locked ClawHub toolchain identity in the validated manifest", async () => {
    const artifact = new TextEncoder().encode("expected");
    const manifestPath = writeManifest("configure-only", artifact);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.clawhubToolchainSha256 = "A".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl: registryFetch(artifact), attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("manifest.clawhubToolchainSha256 is invalid");

    manifest.clawhubToolchainSha256 = clawhubToolchainSha256;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        clawhubToolchainSha256: "e".repeat(64),
        manifestPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl: registryFetch(artifact), attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("clawhubToolchainSha256 mismatch");
  });

  it("rejects noncanonical, oversized, and symlinked manifests before registry access", async () => {
    const artifact = new TextEncoder().encode("expected");
    const fetchImpl = registryFetch(artifact);
    const manifestPath = writeManifest("configure-only", artifact);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, unexpected: true }));
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("keys are invalid");

    const oversizedPath = writeManifest("configure-only", artifact);
    truncateSync(oversizedPath, 2 * 1024 * 1024 + 1);
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: oversizedPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("size is outside the allowed range: 2097153");

    const targetPath = writeManifest("configure-only", artifact);
    const symlinkPath = `${targetPath}.link`;
    symlinkSync(targetPath, symlinkPath);
    await expect(
      verifyPublishedClawHubArtifacts({
        ...immutableBinding(),
        manifestPath: symlinkPath,
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("must be a regular file");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
