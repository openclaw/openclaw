import { describe, expect, it, vi } from "vitest";
import {
  collectDockerAttestationErrors,
  imageRefForDigest,
  inspectRaw,
  parseArgs,
  parsePlatform,
} from "../../scripts/verify-docker-attestations.mjs";

const imageDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const attestationDigest = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const imageRef = "ghcr.io/openclaw/openclaw:test";

function createIndex() {
  return {
    manifests: [
      {
        digest: imageDigest,
        platform: { architecture: "amd64", os: "linux" },
      },
      {
        digest: attestationDigest,
        annotations: {
          "vnd.docker.reference.digest": imageDigest,
          "vnd.docker.reference.type": "attestation-manifest",
        },
        platform: { architecture: "unknown", os: "unknown" },
      },
    ],
  };
}

function createAttestation(
  predicates = ["https://spdx.dev/Document", "https://slsa.dev/provenance/v1"],
) {
  return {
    artifactType: "application/vnd.docker.attestation.manifest.v1+json",
    layers: predicates.map((predicate) => ({
      annotations: { "in-toto.io/predicate-type": predicate },
    })),
  };
}

function errorsFor(index = createIndex(), attestation = createAttestation()) {
  return collectDockerAttestationErrors({
    imageRef,
    index,
    requiredPlatforms: [parsePlatform("linux/amd64")],
    inspectAttestation: () => attestation,
  });
}

describe("verify-docker-attestations", () => {
  it("bounds docker manifest inspection calls", () => {
    const execFileSyncImpl = vi.fn(() => "{}");
    expect(inspectRaw(imageRef, { execFileSyncImpl })).toBe("{}");
    expect(execFileSyncImpl.mock.calls).toStrictEqual([
      [
        "docker",
        ["buildx", "imagetools", "inspect", "--raw", imageRef],
        {
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: 20 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        },
      ],
    ]);
  });

  it("parses required platforms and image refs", () => {
    expect(
      parseArgs(["--platform", "linux/amd64", "--platform", "linux/arm64", "ghcr.io/openclaw/app"]),
    ).toEqual({
      help: false,
      imageRefs: ["ghcr.io/openclaw/app"],
      requiredPlatforms: [
        { architecture: "amd64", os: "linux", variant: undefined },
        { architecture: "arm64", os: "linux", variant: undefined },
      ],
    });
  });

  it("rejects missing platform option values", () => {
    expect(() => parseArgs(["--platform"])).toThrow("--platform requires a value");
    expect(() => parseArgs(["--platform", "-h"])).toThrow("--platform requires a value");
    expect(() => parseArgs(["--platform", "--help"])).toThrow("--platform requires a value");
    expect(() => parseArgs(["--platform", ""])).toThrow("--platform requires a value");
  });

  it("resolves digest refs from tagged image refs", () => {
    expect(imageRefForDigest("ghcr.io/openclaw/openclaw:2026.4.26", imageDigest)).toBe(
      `ghcr.io/openclaw/openclaw@${imageDigest}`,
    );
    expect(imageRefForDigest("localhost:5000/openclaw:main", imageDigest)).toBe(
      `localhost:5000/openclaw@${imageDigest}`,
    );
  });

  it("reports unexpected attestation artifact types", () => {
    expect(
      errorsFor(createIndex(), {
        ...createAttestation(),
        artifactType: "application/vnd.unknown",
      }),
    ).toEqual([
      `ghcr.io/openclaw/openclaw:test: linux/amd64 attestation ${attestationDigest} has unexpected artifactType "application/vnd.unknown"`,
    ]);
  });

  it("reports missing attestation manifests", () => {
    const index = createIndex();
    index.manifests = index.manifests.slice(0, 1);

    expect(errorsFor(index)).toEqual([
      "ghcr.io/openclaw/openclaw:test: missing attestation manifest for linux/amd64",
    ]);
  });

  it("reports missing SBOM or provenance predicates", () => {
    expect(errorsFor(createIndex(), createAttestation(["https://spdx.dev/Document"]))).toEqual([
      "ghcr.io/openclaw/openclaw:test: linux/amd64 missing predicate https://slsa.dev/provenance/v1",
    ]);
  });
});
