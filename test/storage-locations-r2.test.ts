import { expect, it, vi } from "vitest";
import { r2StorageProvider } from "../extensions/cloudflare/api.js";
import { openStorageLocation } from "../src/storage/locations.js";
import "../src/test-utils/prepare-compiled-subprocesses.js";

const { s3ModulePath, send } = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../extensions/cloudflare/package.json", import.meta.url));
  return {
    s3ModulePath: require.resolve("@aws-sdk/client-s3"),
    send: vi.fn<(command: { constructor: { name: string } }) => Promise<unknown>>(),
  };
});

vi.mock(s3ModulePath, async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  S3Client: class {
    send = send;
    destroy() {}
  },
}));

it.for([false, true])(
  "fences multipart publication when authority is lost (cleanup fails: %s)",
  async (cleanupFails, { onTestFinished }) => {
    const locationId = "11111111-1111-4111-8111-111111111111";
    const marker = JSON.stringify({ version: 1, locationId, createdAt: 0, encryption: "none" });
    const markerBytes = Buffer.byteLength(marker);
    const commands: string[] = [];
    send.mockImplementation(async ({ constructor: { name } }) => {
      commands.push(name);
      if (name === "HeadObjectCommand") {
        return { ETag: '"marker"', ContentLength: markerBytes };
      }
      if (name === "GetObjectCommand") {
        return {
          ETag: '"marker"',
          ContentRange: `bytes 0-${markerBytes - 1}/${markerBytes}`,
          Body: {
            transformToWebStream: () => new Blob([marker]).stream(),
          },
        };
      }
      if (name === "CreateMultipartUploadCommand") {
        return { UploadId: "staged-backup" };
      }
      if (name === "UploadPartCommand") {
        return { ETag: "uploaded-part" };
      }
      if (name === "AbortMultipartUploadCommand") {
        if (cleanupFails) {
          throw new Error("synthetic-private-cleanup-detail");
        }
      }
      return {};
    });
    const archiveLocation = {
      provider: "r2",
      settings: {
        accountId: "0".repeat(32),
        bucket: "test-bucket",
        accessKeyId: { source: "env", provider: "default", id: "R2_KEY" },
        secretAccessKey: { source: "env", provider: "default", id: "R2_SECRET" },
      },
      encryption: "none",
    } as const;
    const location = await openStorageLocation({
      name: "archive",
      config: { storage: { locations: { archive: archiveLocation } } },
      env: { R2_KEY: "synthetic-test-key", R2_SECRET: "synthetic-test-secret" },
      registry: {
        storageProviders: new Map([
          ["r2", { pluginId: "cloudflare", source: "test", provider: r2StorageProvider }],
        ]),
      },
    });
    onTestFinished(() => location.close());
    let owner = "installation-a";
    async function* archive() {
      yield Buffer.alloc(64 * 1024 * 1024);
      owner = "installation-b";
    }
    const failure = await location
      .putObject("backup.tar.gz", archive(), {
        precondition: async () => {
          if (owner !== "installation-a") {
            throw new Error("Backup namespace belongs to another OpenClaw installation.");
          }
        },
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("belongs to another OpenClaw installation");
    if (cleanupFails) {
      expect(String(failure)).toContain(
        "Multipart cleanup also failed; remove incomplete uploads in bucket test-bucket.",
      );
    }
    expect(String(failure)).not.toContain("synthetic-private-cleanup-detail");
    expect(commands).toContain("UploadPartCommand");
    expect(commands).toContain("AbortMultipartUploadCommand");
    expect(commands).not.toContain("CompleteMultipartUploadCommand");
    expect(commands).not.toContain("PutObjectCommand");
  },
);
