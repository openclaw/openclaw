import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyPublishedClawHubArtifacts } from "../../scripts/verify-clawhub-published-artifact.mjs";

const tempDirs: string[] = [];

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
      requestedPlugins: ["@openclaw/meta"],
      entries: [
        {
          packageName: "@openclaw/meta",
          version: "2026.7.1-beta.3",
          packageDir: "extensions/meta",
          publishTag: "beta",
          bootstrapMode: mode,
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

function artifactResponse(artifact: Uint8Array, body: BodyInit = artifact) {
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
  it("uses bounded streaming reads with an active attempt timeout", () => {
    const source = readFileSync("scripts/verify-clawhub-published-artifact.mjs", "utf8");
    expect(source).not.toContain(".arrayBuffer(");
    expect(source).toContain("response.body.getReader()");
    expect(source).toContain("readBoundedBytes(response, url, MAX_JSON_BYTES)");
    expect(source).toContain("readBoundedBytes(response, url, MAX_ARTIFACT_BYTES)");
    expect(source).toContain("AbortSignal.timeout(timeoutMs)");
  });

  it("requires exact bytes and complete artifact metadata", async () => {
    const artifact = new TextEncoder().encode("exact tgz bytes");
    const evidence = await verifyPublishedClawHubArtifacts({
      artifactDigest: "c".repeat(64),
      artifactId: "456",
      manifestPath: writeManifest("publish", artifact),
      registry: "https://clawhub.example",
      terminalRunAttempt: "2",
      retryOptions: { fetchImpl: registryFetch(artifact), attempts: 1, delayMs: 1 },
    });
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      producerRunAttempt: "1",
      terminalRunAttempt: "2",
      artifactName: "clawhub-bootstrap-aaaaaaaaaaaa-123-1",
      requestedPlugins: ["@openclaw/meta"],
      verificationMode: "postpublish",
      packages: [
        {
          packageName: "@openclaw/meta",
          registrySha256: identity(artifact).sha256,
          registrySize: artifact.byteLength,
          npmIntegrity: identity(artifact).npmIntegrity,
          npmShasum: identity(artifact).npmShasum,
          artifactMetadata: {
            kind: "npm-pack",
            packageName: "@openclaw/meta",
            version: "2026.7.1-beta.3",
          },
        },
      ],
    });
  });

  it("proves configure-only registry bytes before trusted-publisher mutation", async () => {
    const artifact = new TextEncoder().encode("historical exact bytes");
    const fetchImpl = registryFetch(artifact);
    const evidence = await verifyPublishedClawHubArtifacts({
      manifestPath: writeManifest("configure-only", artifact),
      mode: "configure-only-preflight",
      registry: "https://clawhub.example",
      terminalRunAttempt: "1",
      retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
    });
    expect(evidence.packages[0]).toMatchObject({
      bootstrapMode: "configure-only",
      expectedSha256: identity(artifact).sha256,
      registrySha256: identity(artifact).sha256,
    });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/trusted-publisher"))).toBe(
      false,
    );
  });

  it("rejects a missing configure-only tag before artifact or publisher requests", async () => {
    const artifact = new TextEncoder().encode("historical exact bytes");
    const fetchImpl = vi.fn(async () =>
      Response.json({
        package: { tags: { beta: "2026.7.1-beta.2" } },
      }),
    );

    await expect(
      verifyPublishedClawHubArtifacts({
        manifestPath: writeManifest("configure-only", artifact),
        mode: "configure-only-preflight",
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow(
      "@openclaw/meta@2026.7.1-beta.3 ClawHub artifact did not stabilize after 1 attempts; last failure @openclaw/meta ClawHub tag beta mismatch",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/artifact"))).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/trusted-publisher"))).toBe(
      false,
    );
  });

  it("retries invalid JSON, body read failures, and eventual byte convergence", async () => {
    const expected = new TextEncoder().encode("expected");
    const wrong = new TextEncoder().encode("wrong");
    let detailCalls = 0;
    let artifactCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("/artifact") && !url.endsWith("/trusted-publisher")) {
        detailCalls += 1;
        if (detailCalls === 1) {
          return new Response("{invalid");
        }
        return Response.json({ package: { tags: { beta: "2026.7.1-beta.3" } } });
      }
      if (url.endsWith("/trusted-publisher")) {
        return Response.json({
          trustedPublisher: {
            repository: "openclaw/openclaw",
            workflowFilename: "plugin-clawhub-release.yml",
            environment: null,
          },
        });
      }
      if (url.endsWith("/artifact")) {
        return metadataResponse(expected);
      }
      artifactCalls += 1;
      if (artifactCalls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("truncated body"));
            },
          }),
        );
      }
      if (artifactCalls === 2) {
        return artifactResponse(expected, wrong);
      }
      return artifactResponse(expected);
    });
    const sleep = vi.fn(async () => {});
    await expect(
      verifyPublishedClawHubArtifacts({
        manifestPath: writeManifest("publish", expected),
        registry: "https://clawhub.example",
        terminalRunAttempt: "1",
        retryOptions: { fetchImpl, attempts: 4, delayMs: 1, sleep },
      }),
    ).resolves.toMatchObject({ packages: [{ registrySha256: identity(expected).sha256 }] });
    expect(sleep).toHaveBeenCalledTimes(3);
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
  });
});
