import { describe, expect, it, vi } from "vitest";
import { r2StorageProvider } from "../extensions/cloudflare/api.js";
import { openStorageLocation } from "../src/storage/locations.js";
import "../src/test-utils/prepare-compiled-subprocesses.js";

const { s3ModulePath, send } = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../extensions/cloudflare/package.json", import.meta.url));
  return {
    s3ModulePath: require.resolve("@aws-sdk/client-s3"),
    send: vi.fn<
      (command: {
        constructor: { name: string };
        input: { Key?: string; UploadId?: string };
      }) => Promise<unknown>
    >(),
  };
});

vi.mock(s3ModulePath, async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  S3Client: class {
    send = send;
    destroy() {}
  },
}));

describe("R2 storage publication", () => {
  it.each([false, true])(
    "fences multipart publication when authority is lost (cleanup fails: %s)",
    async (cleanupFails) => {
      const marker = JSON.stringify({
        version: 1,
        locationId: "11111111-1111-4111-8111-111111111111",
        createdAt: 0,
        encryption: "none",
      });
      const commands: string[] = [];
      const activeUploads = new Set<string>();
      send.mockImplementation(async (command) => {
        const name = command.constructor.name;
        commands.push(name);
        if (name === "GetObjectCommand") {
          return {
            Body: {
              transformToWebStream: () =>
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(Buffer.from(marker));
                    controller.close();
                  },
                }),
            },
          };
        }
        if (name === "CreateMultipartUploadCommand") {
          activeUploads.add("staged-backup");
          return { UploadId: "staged-backup" };
        }
        if (name === "UploadPartCommand") {
          return { ETag: "uploaded-part" };
        }
        if (name === "AbortMultipartUploadCommand") {
          if (cleanupFails) {
            throw new Error("synthetic-private-cleanup-detail");
          }
          activeUploads.delete(command.input.UploadId ?? "");
        }
        return {};
      });
      const location = await openStorageLocation({
        name: "archive",
        config: {
          storage: {
            locations: {
              archive: {
                provider: "r2",
                settings: {
                  accountId: "0".repeat(32),
                  bucket: "test-bucket",
                  accessKeyId: { source: "env", provider: "default", id: "R2_KEY" },
                  secretAccessKey: { source: "env", provider: "default", id: "R2_SECRET" },
                },
                encryption: "none",
              },
            },
          },
        },
        env: { R2_KEY: "synthetic-test-key", R2_SECRET: "synthetic-test-secret" },
        registry: {
          storageProviders: new Map([
            ["r2", { pluginId: "cloudflare", source: "test", provider: r2StorageProvider }],
          ]),
        },
      });
      let owner = "installation-a";
      async function* archive() {
        yield Buffer.alloc(64 * 1024 * 1024);
        owner = "installation-b";
      }
      try {
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
        expect(activeUploads.size).toBe(cleanupFails ? 1 : 0);
      } finally {
        await location.close();
      }
    },
  );
});
