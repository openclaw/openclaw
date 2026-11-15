import { describe, expect, it, vi } from "vitest";
import {
  createContainerRegistryReadbackPlan,
  readContainerManifest,
  verifyContainerRegistryReadback,
} from "../../scripts/container-registry-readback.mjs";

const indexType = "application/vnd.oci.image.index.v1+json";
const imageType = "application/vnd.oci.image.manifest.v1+json";
const dockerImages = ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"];
const vercelImage = "vcr.vercel.com/openclaw-foundation/openclaw/openclaw";
const digest = (character: string) => "sha256:" + character.repeat(64);
const imageManifest = () => ({ schemaVersion: 2, mediaType: imageType });
type RegistryRecord = { digest: string; manifest: Record<string, unknown>; ref: string };

const descriptor = (architecture: string, value: string) => ({
  digest: value,
  mediaType: imageType,
  size: 123,
  platform: { architecture, os: architecture === "unknown" ? "unknown" : "linux" },
});

function indexManifest(platforms: Record<string, string>, attestations: boolean) {
  return {
    schemaVersion: 2,
    mediaType: indexType,
    manifests: [
      ...Object.entries(platforms).map(([architecture, value]) => descriptor(architecture, value)),
      ...(attestations ? [descriptor("unknown", digest("f"))] : []),
    ],
  };
}

function registryFixture(version: string) {
  const policy = createContainerRegistryReadbackPlan({
    version,
    includeBrowser: false,
    dockerImages,
    vercelImage,
  }).policy;
  const records = new Map<string, RegistryRecord>();
  const variants = [
    ["default", "", "a", "1", "2"],
    ["slim", "-slim", "b", "3", "4"],
  ] as const;
  for (const image of [...dockerImages, vercelImage]) {
    for (const [aliasKey, suffix, index, amd64, arm64] of variants) {
      const versionRef = image + ":" + version + suffix;
      const platforms = { amd64: digest(amd64), arm64: digest(arm64) };
      const record = (ref: string): RegistryRecord => ({
        digest: digest(index),
        manifest: indexManifest(platforms, image !== vercelImage),
        ref,
      });
      records.set(versionRef, record(versionRef));
      for (const architecture of ["amd64", "arm64"] as const) {
        const ref = versionRef + "-" + architecture;
        records.set(
          ref,
          image === vercelImage
            ? { digest: platforms[architecture], manifest: imageManifest(), ref }
            : {
                digest: digest(architecture === "amd64" ? "5" : "6"),
                manifest: indexManifest({ [architecture]: platforms[architecture] }, true),
                ref,
              },
        );
      }
      for (const alias of policy.movingAliases[aliasKey]) {
        const ref = image + ":" + alias;
        records.set(ref, record(ref));
      }
    }
  }
  const reads: string[] = [];
  return {
    reads,
    records,
    readManifest: async (ref: string) => {
      reads.push(ref);
      const record = records.get(ref);
      if (!record) {
        throw new Error(ref + ": registry manifest returned HTTP 404.");
      }
      return record;
    },
  };
}

const stableParams = {
  version: "2026.10.6",
  includeBrowser: false,
  dockerImages,
  vercelImage,
};

describe("container registry post-publish readback", () => {
  it("delegates authenticated registry reads to bounded Docker buildx inspection", async () => {
    const ref = vercelImage + ":2026.10.6";
    const delay = vi.fn(async () => {});
    const execFileSyncImpl = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("registry is still converging");
      })
      .mockReturnValueOnce(JSON.stringify({ digest: digest("a"), mediaType: imageType }))
      .mockReturnValueOnce(JSON.stringify(imageManifest()));

    await expect(readContainerManifest(ref, { delay, execFileSyncImpl })).resolves.toMatchObject({
      digest: digest("a"),
      manifest: imageManifest(),
      ref,
    });
    expect(delay).toHaveBeenCalledWith(1_000);
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"],
      expect.objectContaining({
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      }),
    );
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      3,
      "docker",
      ["buildx", "imagetools", "inspect", ref, "--raw"],
      expect.any(Object),
    );
  });
  it.each([
    {
      ref: "docker.io/openclaw/openclaw:2026.10.6-slim-arm64",
      expected: ": registry manifest returned HTTP 404.",
      mutate: (fixture: ReturnType<typeof registryFixture>, ref: string) =>
        fixture.records.delete(ref),
    },
    {
      ref: "ghcr.io/openclaw/openclaw:latest",
      expected: " resolved to " + digest("e"),
      mutate: (fixture: ReturnType<typeof registryFixture>, ref: string) =>
        fixture.records.set(ref, { ...fixture.records.get(ref)!, digest: digest("e") }),
    },
    {
      ref: vercelImage + ":2026.10.6-slim",
      expected: ": registry manifest returned HTTP 404.",
      mutate: (fixture: ReturnType<typeof registryFixture>, ref: string) =>
        fixture.records.delete(ref),
    },
  ])("rejects missing or stale $ref", async ({ ref, expected, mutate }) => {
    const fixture = registryFixture(stableParams.version);
    mutate(fixture, ref);
    await expect(
      verifyContainerRegistryReadback(stableParams, { readManifest: fixture.readManifest }),
    ).rejects.toThrow(ref + expected);
  });

  it("rejects Vercel platform descriptor drift beyond the digest", async () => {
    const fixture = registryFixture(stableParams.version);
    const ref = vercelImage + ":" + stableParams.version;
    const policy = createContainerRegistryReadbackPlan(stableParams).policy;
    const defaultRefs = [
      ref,
      ...policy.movingAliases.default.map((alias) => vercelImage + ":" + alias),
    ];
    for (const candidateRef of defaultRefs) {
      const record = fixture.records.get(candidateRef)!;
      const manifests = record.manifest.manifests as Array<Record<string, unknown>>;
      manifests[0] = { ...manifests[0], size: 456 };
    }

    await expect(
      verifyContainerRegistryReadback(stableParams, { readManifest: fixture.readManifest }),
    ).rejects.toThrow(ref + " descriptor set differs from the expected immutable ref.");
  });

  it("accepts equivalent platform metadata with a different property order", async () => {
    const fixture = registryFixture(stableParams.version);
    for (const [candidateRef, record] of fixture.records) {
      if (!candidateRef.startsWith(vercelImage + ":")) {
        continue;
      }
      const manifests = record.manifest.manifests as Array<Record<string, unknown>> | undefined;
      for (const manifestDescriptor of manifests ?? []) {
        const platform = manifestDescriptor.platform as { architecture: string; os: string };
        manifestDescriptor.platform = { os: platform.os, architecture: platform.architecture };
      }
    }

    await expect(
      verifyContainerRegistryReadback(stableParams, { readManifest: fixture.readManifest }),
    ).resolves.toMatchObject({ registryCount: 3 });
  });

  it("keeps beta publication at zero moving aliases", async () => {
    const fixture = registryFixture("2026.10.7-beta.1");
    const result = await verifyContainerRegistryReadback(
      { ...stableParams, version: "2026.10.7-beta.1" },
      { readManifest: fixture.readManifest },
    );
    expect(result).toMatchObject({ channel: "beta", refCount: 18, registryCount: 3 });
    expect(fixture.reads.every((ref) => ref.includes("2026.10.7-beta.1"))).toBe(true);
  });
});
