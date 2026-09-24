// Install download tests cover downloading skill archives before extraction.
import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { __setFsSafeTestHooksForTest, getFsSafeTestHooks } from "@openclaw/fs-safe/test-hooks";
import JSZip from "jszip";
import * as tar from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSkillToolsRootDir } from "../runtime/tools-dir.js";
import { createInstallDownloadTestState } from "../test-support/install-download-test-utils.js";
import { fetchWithSsrFGuardMock } from "../test-support/install-test-mocks.js";
import type { SkillInstallSpec } from "../types.js";
import { installDownloadSpec } from "./install-download.js";
import { extractSkillDownloadArchive } from "./install-extract.js";

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

// Synthetic USTAR fixtures compressed with bzip2; tests need no system tar.
const TAR_BZIP2_FIXTURES = {
  // package/empty (0755), package/run.sh (0755), and package/private.txt (0640).
  safe: Buffer.from(
    "QlpoOTFBWSZTWYbTlsAAAMFfgcqQ6AHvgAACEAR/619gIAAICDAAubYgoNADQNAAB6jTQr1BMmgANAADQAbUjVHqMm1ADE0aAA0w831T1NiYahkA0hIFHTr8EZKlFWyMBzICEyR34TdK/nuwk/6uBGtUpTYCgnBAXcU4FyctMozGLS8YijlwCwso1KL+Q0GCPCZWiiJJGjlKkHUOwx1Mh8GM1wAbNzJP0wwqFxZRCxFAkHKHp2CkLVBgICX8XckU4UJCG05bAA==",
    "base64",
  ),
  // escape/pwn.txt (0644), used against a pre-existing destination symlink.
  nested: Buffer.from(
    "QlpoOTFBWSZTWRzXHUgAAHD7gMmAAAJAAecAEABuAd7ACAggAFRGqNGh6nqYRkPUzUEkk0NNDQaNAH3URyEE3oQiXOUCqMLECGBilJPE9hE3AuXH0eMsnjuaosKWJvlw0ux2ujQkACL8XckU4UJAc1x1IA==",
    "base64",
  ),
  // ../outside (0644).
  traversal: Buffer.from(
    "QlpoOTFBWSZTWasqcFYAAFt7gMmAAAJAAdeAAQBmIZ6ACAggAFQ0iZqYQNqGE2oJJR6gGnqDQAfTvKEIJuhCJcxaZYXWIEMDEoIcTsI1aQbrGnWiGbBhKpbGbL9FTZlRuREB+LuSKcKEhVlTgrA=",
    "base64",
  ),
  // a-readable followed by z-alias -> ../outside.
  symlink: Buffer.from(
    "QlpoOTFBWSZTWdtAYZYAAI57gOGQAQBAA/eAASB3JJ4QCIggAHIaJqAyaBoNDRk0CSKJp6RjQCaYEY6yN6SQgyAH8JIRVduWvcOX1KAQEIYXDr/n8xMPIKYYEZOfWArli7zYEfRFYzzkGlZpBEUQ3g/hw8cDjU+aQlKyJhi1MXMWkfvU/nAiA/F3JFOFCQ20Bhlg",
    "base64",
  ),
  // a-readable followed by the hardlink z-alias.
  hardlink: Buffer.from(
    "QlpoOTFBWSZTWY+FyHAAAI17gOGQAQBAAneAASB3JB4QCIggAHQSUKep6nqaYj1GekRskEkkGgaAAaA+1I1khQyAHTJIRZdEvHDGEE8HiEMLpytUpEF0HAjVoCIM7I6+zEYyIweaTJqDybg1luMVofqBwMXfaxFdiT5XLK+/NBIP4u5IpwoSEfC5DgA=",
    "base64",
  ),
  // a-readable (0644), then z-target (0000).
  unreadableFile: Buffer.from(
    "QlpoOTFBWSZTWfDwP48AAIz7gOuQCABAAn+AAUB/pB4QCIggAHIaU9RpoAGgeoDI9QJJU/UI2iGj1GHqmRoNNo98QckwANSkhHI1K+sxifa4sVYhDJW5uo+9yoFQMCMtwQwnItvvJ3EFXRYydPJxmAS9HE58ZwRkUFMeQaHsNtDVFIUplNR9gCID8XckU4UJDw8D+PA=",
    "base64",
  ),
  // a-readable, then z-directory (0400) containing a file.
  unsearchableDirectory: Buffer.from(
    "QlpoOTFBWSZTWd+NhiUAAKv7gOOQBABAAv+ARQB/LJ4wCIggAJIJJU9EZPQg2kGmQG9U9QIpQCNGgAPKAGh+lfGY1Q1GWBWLEFMDT4dZbc0OzRVDA3KJCHrpSGJPE3loYQrY30CspTrRsgisnxppZjopZRGVV5ayxgRCGpVsLtfjgpTehQ7jmSfzVpEbR3K7ixWUq4tmphtJqg/bpIQfxdyRThQkN+NhiUA=",
    "base64",
  ),
  // An empty directory (0400), which is readable without search permission.
  emptyReadOnlyDirectory: Buffer.from(
    "QlpoOTFBWSZTWXXuRd4AAHB7gOCAABBAANeAAQBuIJ4gAAggAFRCAAaADQSUyIxANAaXwqwkE4oQivbyeY5JAiCgXZJosI2dCYkSyVUVNQHt3rteudMzOExEQD4u5IpwoSDr3Iu8",
    "base64",
  ),
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildDownloadSpec(params: {
  url: string;
  archive: "tar.gz" | "tar.bz2" | "zip";
  targetDir: string;
  stripComponents?: number;
}): SkillInstallSpec {
  return {
    kind: "download",
    id: "dl",
    url: params.url,
    archive: params.archive,
    extract: true,
    targetDir: params.targetDir,
    ...(typeof params.stripComponents === "number"
      ? { stripComponents: params.stripComponents }
      : {}),
  };
}

async function installDownloadSkill(params: {
  name: string;
  url: string;
  archive: "tar.gz" | "tar.bz2" | "zip";
  targetDir: string;
  stripComponents?: number;
}) {
  return installDownloadSpec({
    skillKey: params.name,
    spec: buildDownloadSpec(params),
    timeoutMs: 30_000,
  });
}

function mockArchiveResponse(buffer: Uint8Array): void {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(Buffer.from(buffer)),
    release: async () => undefined,
  });
}

async function withDownloadServer(
  respond: (response: ServerResponse) => Promise<void> | void,
  run: (origin: string, release: ReturnType<typeof vi.fn>) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    void Promise.resolve(respond(response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral loopback server address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const release = vi.fn();
  const actualFetchGuard = await vi.importActual<typeof import("../../infra/net/fetch-guard.js")>(
    "../../infra/net/fetch-guard.js",
  );
  fetchWithSsrFGuardMock.mockImplementation(async (...args: unknown[]) => {
    const params = args[0] as Parameters<typeof actualFetchGuard.fetchWithSsrFGuard>[0];
    const guarded = await actualFetchGuard.fetchWithSsrFGuard({
      ...params,
      policy: { allowedOrigins: [origin] },
    });
    return {
      ...guarded,
      release: async () => {
        release();
        await guarded.release();
      },
    };
  });

  try {
    await run(origin, release);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

let workspaceDir = "";
let testState: OpenClawTestState | undefined;
beforeAll(async () => {
  testState = await createInstallDownloadTestState();
  workspaceDir = testState.workspaceDir;
});

afterAll(async () => {
  await testState?.cleanup();
  testState = undefined;
  workspaceDir = "";
});

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

describe("installDownloadSpec extraction safety", () => {
  it("rejects oversized advertised HTTP downloads before staging the response body", async () => {
    let responseCompleted = false;
    let resolveConnectionClosed: (() => void) | undefined;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });

    await withDownloadServer(
      (response) => {
        response.once("close", () => resolveConnectionClosed?.());
        response.once("finish", () => {
          responseCompleted = true;
        });
        response.writeHead(200, {
          "content-length": "268435457",
          "content-type": "application/octet-stream",
        });
        response.write(Buffer.from([1]));
      },
      async (origin, release) => {
        const skillKey = "oversized-advertised-http-download";
        const toolsRoot = resolveSkillToolsRootDir(skillKey);
        const result = await installDownloadSpec({
          skillKey,
          spec: {
            kind: "download",
            id: "dl",
            url: `${origin}/oversized.bin`,
            extract: false,
            targetDir: "runtime",
          },
          timeoutMs: 1_000,
        });

        expect(result.ok).toBe(false);
        expect(result.stderr).toBe(
          "Skill download exceeds 268435456-byte limit (declared 268435457 bytes)",
        );
        await connectionClosed;
        expect(responseCompleted).toBe(false);
        expect(release).toHaveBeenCalledOnce();
        await expect(fileExists(path.join(toolsRoot, "runtime", "oversized.bin"))).resolves.toBe(
          false,
        );
        await expect(fileExists(path.join(toolsRoot, ".openclaw-download-staging"))).resolves.toBe(
          false,
        );
      },
    );
  }, 10_000);

  it.each([
    {
      name: "encoded-response-length",
      headers: new Headers({ "content-encoding": "gzip", "content-length": "268435457" }),
    },
    {
      name: "malformed-response-length",
      headers: new Headers({ "content-length": "1e9" }),
    },
  ])("streams a decoded response with an unusable declared length ($name)", async (testCase) => {
    const body = Buffer.from("decoded skill artifact");
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200, headers: testCase.headers }),
      release,
    });
    const skillKey = testCase.name;
    const toolsRoot = resolveSkillToolsRootDir(skillKey);

    const result = await installDownloadSpec({
      skillKey,
      spec: {
        kind: "download",
        id: "dl",
        url: "https://example.invalid/artifact.bin",
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(`downloaded=${body.byteLength}`);
    await expect(fs.readFile(path.join(toolsRoot, "runtime", "artifact.bin"))).resolves.toEqual(
      body,
    );
    expect(release).toHaveBeenCalledOnce();
    await expect(fileExists(path.join(toolsRoot, ".openclaw-download-staging"))).resolves.toBe(
      false,
    );
  });

  it("aborts oversized chunked HTTP downloads and removes partial staging data", async () => {
    const maxBytes = 256 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024);
    let producedBytes = 0;
    let resolveConnectionClosed: (() => void) | undefined;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });

    await withDownloadServer(
      async (response) => {
        response.once("close", () => resolveConnectionClosed?.());
        response.writeHead(200, { "content-type": "application/octet-stream" });

        while (producedBytes < maxBytes && !response.destroyed) {
          const writable = response.write(chunk);
          producedBytes += chunk.byteLength;
          if (!writable) {
            await new Promise<void>((resolve) => {
              const onDrain = () => {
                response.off("close", onClose);
                resolve();
              };
              const onClose = () => {
                response.off("drain", onDrain);
                resolve();
              };
              response.once("drain", onDrain);
              response.once("close", onClose);
            });
          }
        }

        if (response.destroyed) {
          return;
        }
        response.write(Buffer.from([1]));
        producedBytes += 1;
      },
      async (origin, release) => {
        const skillKey = "oversized-http-download";
        const toolsRoot = resolveSkillToolsRootDir(skillKey);
        const result = await installDownloadSpec({
          skillKey,
          spec: {
            kind: "download",
            id: "dl",
            url: `${origin}/oversized.bin`,
            extract: false,
            targetDir: "runtime",
          },
          timeoutMs: 30_000,
        });

        expect(result.ok).toBe(false);
        expect(result.stderr).toContain("Skill download exceeds 268435456-byte limit");
        await connectionClosed;
        expect(producedBytes).toBe(maxBytes + 1);
        expect(release).toHaveBeenCalledOnce();
        await expect(fileExists(path.join(toolsRoot, "runtime", "oversized.bin"))).resolves.toBe(
          false,
        );
        await expect(fileExists(path.join(toolsRoot, ".openclaw-download-staging"))).resolves.toBe(
          false,
        );
      },
    );
  }, 45_000);

  it("installs exact bytes from a chunked HTTP response and releases guarded resources", async () => {
    const chunks = [Buffer.from("skill "), Buffer.from("artifact"), Buffer.from([0, 255])];

    await withDownloadServer(
      (response) => {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        for (const chunk of chunks) {
          response.write(chunk);
        }
        response.end();
      },
      async (origin, release) => {
        const skillKey = "successful-http-download";
        const toolsRoot = resolveSkillToolsRootDir(skillKey);
        const result = await installDownloadSpec({
          skillKey,
          spec: {
            kind: "download",
            id: "dl",
            url: `${origin}/artifact.bin`,
            extract: false,
            targetDir: "runtime",
          },
          timeoutMs: 30_000,
        });

        expect(result.ok).toBe(true);
        expect(result.stdout).toBe(`downloaded=${Buffer.concat(chunks).byteLength}`);
        await expect(fs.readFile(path.join(toolsRoot, "runtime", "artifact.bin"))).resolves.toEqual(
          Buffer.concat(chunks),
        );
        expect(release).toHaveBeenCalledOnce();
        await expect(fileExists(path.join(toolsRoot, ".openclaw-download-staging"))).resolves.toBe(
          false,
        );
      },
    );
  });

  it.each([
    { name: "new destination", existing: false },
    { name: "existing destination", existing: true },
  ])("rejects a SHA-256 mismatch without changing a $name", async ({ existing }) => {
    const archive = Buffer.from("unverified archive bytes");
    const expected = "0".repeat(64);
    const actual = createHash("sha256").update(archive).digest("hex");
    const skillKey = `digest-mismatch-${existing ? "existing" : "new"}`;
    const toolsRoot = resolveSkillToolsRootDir(skillKey);
    const targetDir = path.join(toolsRoot, "runtime");
    if (existing) {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "existing.txt"), "preserved");
    }
    mockArchiveResponse(archive);

    const result = await installDownloadSpec({
      skillKey,
      spec: {
        ...buildDownloadSpec({
          url: "https://example.invalid/runtime.tar.bz2?token=do-not-disclose",
          archive: "tar.bz2",
          targetDir: "runtime",
        }),
        sha256: expected,
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("runtime.tar.bz2");
    expect(result.stderr).toContain(expected);
    expect(result.stderr).toContain(actual);
    expect(result.stderr).toContain("download was discarded");
    expect(result.stderr).toContain("verify the publisher checksum");
    expect(result.stderr).not.toContain("do-not-disclose");
    await expect(fileExists(path.join(targetDir, "runtime.tar.bz2"))).resolves.toBe(false);
    if (existing) {
      await expect(fs.readdir(toolsRoot)).resolves.toEqual(["runtime"]);
      await expect(fs.readdir(targetDir)).resolves.toEqual(["existing.txt"]);
      await expect(fs.readFile(path.join(targetDir, "existing.txt"), "utf8")).resolves.toBe(
        "preserved",
      );
    } else {
      await expect(fs.readdir(toolsRoot)).resolves.toEqual([]);
      await expect(fileExists(targetDir)).resolves.toBe(false);
    }
  });

  it.each([
    { name: "a matching SHA-256 digest", verified: true },
    { name: "no declared digest", verified: false },
  ])("installs and extracts a download with $name", async ({ verified }) => {
    const payload = TAR_BZIP2_FIXTURES.safe;
    const skillKey = `digest-success-${verified ? "verified" : "legacy"}`;
    const toolsRoot = resolveSkillToolsRootDir(skillKey);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    mockArchiveResponse(payload);

    const result = await installDownloadSpec({
      skillKey,
      spec: {
        kind: "download",
        url: "https://example.invalid/runtime.tar.bz2",
        archive: "tar.bz2",
        extract: true,
        targetDir: "runtime",
        ...(verified ? { sha256 } : {}),
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(true);
    await expect(fs.readFile(path.join(toolsRoot, "runtime", "runtime.tar.bz2"))).resolves.toEqual(
      payload,
    );
    await expect(fs.readdir(toolsRoot)).resolves.toEqual(["runtime"]);
    await expect(
      fs.readFile(path.join(toolsRoot, "runtime", "package", "private.txt"), "utf8"),
    ).resolves.toBe("private data\n");
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the tools root is replaced after verified archive publication",
    async () => {
      const verifiedArchive = TAR_BZIP2_FIXTURES.safe;
      const replacementArchive = Buffer.from("unverified replacement archive bytes");
      const skillKey = "verified-post-publication-root-replacement";
      const toolsRoot = resolveSkillToolsRootDir(skillKey);
      const displacedRoot = `${toolsRoot}-displaced`;
      const archivePath = path.join(toolsRoot, "runtime", "runtime.tar.bz2");
      const replacementOutput = path.join(toolsRoot, "runtime", "package");
      let extractedPath = "";
      let extractedContents: string | undefined;
      const release = vi.fn(async () => {
        const publishedIdentity = await fs.stat(archivePath);
        await getFsSafeTestHooks()?.afterPublishTargetCreated?.(
          "exclusive-copy",
          archivePath,
          publishedIdentity,
        );
      });
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(verifiedArchive),
        release,
      });

      __setFsSafeTestHooksForTest({
        afterOpen: async (openedPath, handle) => {
          if (openedPath.endsWith(path.join("extracted", "package", "private.txt"))) {
            extractedPath = openedPath;
            extractedContents = await handle.readFile("utf8");
          }
        },
        afterPublishTargetCreated: async (_method, publishedPath) => {
          if (publishedPath !== archivePath) {
            return;
          }
          await fs.rename(toolsRoot, displacedRoot);
          await fs.mkdir(path.join(toolsRoot, "runtime"), { recursive: true });
          await fs.writeFile(archivePath, replacementArchive);
        },
      });

      let result;
      try {
        result = await installDownloadSpec({
          skillKey,
          spec: {
            ...buildDownloadSpec({
              url: "https://example.invalid/runtime.tar.bz2",
              archive: "tar.bz2",
              targetDir: "runtime",
            }),
            sha256: createHash("sha256").update(verifiedArchive).digest("hex"),
          },
          timeoutMs: 30_000,
        });
      } finally {
        __setFsSafeTestHooksForTest(undefined);
      }

      expect(result.ok).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      expect(extractedContents).toBe("private data\n");
      await expect(fileExists(extractedPath)).resolves.toBe(false);
      await expect(fileExists(replacementOutput)).resolves.toBe(false);
      await expect(fs.readFile(archivePath)).resolves.toEqual(replacementArchive);
      await expect(
        fs.readFile(path.join(displacedRoot, "runtime", "runtime.tar.bz2")),
      ).resolves.toEqual(verifiedArchive);
      expect(getFsSafeTestHooks()).toBeUndefined();
    },
  );

  it.each(["tar.gz", "tar.bz2", "zip"] as const)(
    "publishes verified %s archives with executable files and empty directories",
    async (archiveType) => {
      const skillKey = `verified-published-${archiveType}`;
      const fixtureRoot = path.join(workspaceDir, `archive-fixture-${archiveType}`);
      const packageDir = path.join(fixtureRoot, "package");
      const executableContents = "#!/bin/sh\nprintf verified\\n\n";
      await fs.mkdir(path.join(packageDir, "empty"), { recursive: true });
      await fs.writeFile(path.join(packageDir, "run.sh"), executableContents, { mode: 0o755 });

      let archive: Buffer;
      if (archiveType === "tar.bz2") {
        archive = TAR_BZIP2_FIXTURES.safe;
      } else if (archiveType === "zip") {
        const zip = new JSZip();
        zip.folder("package/empty/");
        zip.file("package/run.sh", executableContents, { unixPermissions: 0o755 });
        archive = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
      } else {
        const fixtureArchive = path.join(fixtureRoot, "runtime.tar.gz");
        await tar.c({ cwd: fixtureRoot, file: fixtureArchive, gzip: true }, ["package"]);
        archive = await fs.readFile(fixtureArchive);
      }
      mockArchiveResponse(archive);

      const archiveName = `runtime.${archiveType}`;
      const result = await installDownloadSpec({
        skillKey,
        spec: {
          ...buildDownloadSpec({
            url: `https://example.invalid/${archiveName}`,
            archive: archiveType,
            targetDir: "runtime",
            stripComponents: 1,
          }),
          sha256: createHash("sha256").update(archive).digest("hex"),
        },
        timeoutMs: 30_000,
      });

      const destinationDir = path.join(resolveSkillToolsRootDir(skillKey), "runtime");
      expect(result.ok).toBe(true);
      await expect(fs.readFile(path.join(destinationDir, archiveName))).resolves.toEqual(archive);
      await expect(fs.readFile(path.join(destinationDir, "run.sh"), "utf8")).resolves.toBe(
        executableContents,
      );
      expect((await fs.stat(path.join(destinationDir, "empty"))).isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        const mask = archiveType === "tar.bz2" && process.geteuid?.() !== 0 ? process.umask() : 0;
        expect((await fs.stat(path.join(destinationDir, "run.sh"))).mode & 0o777).toBe(
          0o755 & ~mask,
        );
      }
    },
  );

  it("rejects targetDir escapes outside the per-skill tools root", async () => {
    const beforeFetchCalls = fetchWithSsrFGuardMock.mock.calls.length;
    const skillKey = "relative-traversal";
    const toolsRoot = resolveSkillToolsRootDir(skillKey);
    const escapedTargetDir = path.resolve(toolsRoot, "../outside");

    const result = await installDownloadSpec({
      skillKey,
      spec: buildDownloadSpec({
        url: "https://example.invalid/good.zip",
        archive: "zip",
        targetDir: "../outside",
      }),
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Refusing to install outside the skill tools directory");
    expect(fetchWithSsrFGuardMock.mock.calls.length).toBe(beforeFetchCalls);
    await expect(fileExists(toolsRoot)).resolves.toBe(true);
    await expect(fileExists(escapedTargetDir)).resolves.toBe(false);
  });

  it("allows relative targetDir inside the per-skill tools root", async () => {
    mockArchiveResponse(new TextEncoder().encode("payload"));
    const skillKey = "relative-targetdir";

    const result = await installDownloadSpec({
      skillKey,
      spec: {
        kind: "download",
        id: "dl",
        url: "https://example.invalid/payload.bin",
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });
    expect(result.ok).toBe(true);
    expect(
      await fs.readFile(
        path.join(resolveSkillToolsRootDir(skillKey), "runtime", "payload.bin"),
        "utf-8",
      ),
    ).toBe("payload");
  });

  it("cancels failed download response bodies before returning the error", async () => {
    const connectionClosed = createDeferred();
    await withDownloadServer(
      (response) => {
        response.once("close", () => connectionClosed.resolve());
        response.writeHead(500, "Server Error");
        response.write(Buffer.from([1, 2, 3]));
      },
      async (origin, release) => {
        const result = await installDownloadSpec({
          skillKey: "failed-download-body",
          spec: {
            kind: "download",
            id: "dl",
            url: `${origin}/broken.bin`,
            extract: false,
            targetDir: "runtime",
          },
          timeoutMs: 30_000,
        });

        expect(result.ok).toBe(false);
        expect(result.stderr).toContain("Download failed (500 Server Error)");
        await connectionClosed.promise;
        expect(release).toHaveBeenCalledOnce();
      },
    );
  });

  it.runIf(process.platform !== "win32").each([
    { name: "a legacy download", verified: false },
    { name: "a matching-digest download", verified: true },
  ])(
    "fails closed when $name rebinds the lexical tools root before the final copy",
    async ({ verified }) => {
      const skillKey = `base-rebind-${verified ? "verified" : "legacy"}`;
      const safeToolsRoot = resolveSkillToolsRootDir(skillKey);
      const outsideRoot = path.join(
        workspaceDir,
        `outside-root-${verified ? "verified" : "legacy"}`,
      );
      const payload = Buffer.from("payload");
      await fs.mkdir(safeToolsRoot, { recursive: true });
      await fs.mkdir(outsideRoot, { recursive: true });

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body: Readable.toWeb(
            Readable.from(
              (async function* () {
                yield payload;
                const reboundRoot = `${safeToolsRoot}-rebound`;
                await fs.rename(safeToolsRoot, reboundRoot);
                await fs.symlink(outsideRoot, safeToolsRoot);
              })(),
            ),
            { strategy: { highWaterMark: 0 } },
          ),
        },
        release: async () => undefined,
      });

      const result = await installDownloadSpec({
        skillKey,
        spec: {
          kind: "download",
          id: "dl",
          url: "https://example.invalid/payload.bin",
          extract: false,
          targetDir: "runtime",
          ...(verified ? { sha256: createHash("sha256").update(payload).digest("hex") } : {}),
        },
        timeoutMs: 30_000,
      });

      expect(result.ok).toBe(false);
      expect(await fileExists(path.join(outsideRoot, "runtime", "payload.bin"))).toBe(false);
    },
  );
});

describe("installDownloadSpec extraction safety (tar.bz2)", () => {
  it.each([
    { name: "symlink", archive: TAR_BZIP2_FIXTURES.symlink, error: /link/i },
    { name: "hardlink", archive: TAR_BZIP2_FIXTURES.hardlink, error: /link/i },
    {
      name: "traversal",
      archive: TAR_BZIP2_FIXTURES.traversal,
      error: /archive-entry-path-invalid|archive entry (?:escapes|contains a parent segment)/i,
    },
    {
      name: "truncated",
      archive: TAR_BZIP2_FIXTURES.safe.subarray(0, 40),
      error: /decompression not finished but EOF reached|incomplete compressed stream/i,
    },
  ])(
    "rejects $name archives before publishing extracted payload",
    async ({ name, archive, error }) => {
      const targetDir = path.join(resolveSkillToolsRootDir(`tbz2-${name}`), "target");
      mockArchiveResponse(archive);

      const result = await installDownloadSkill({
        name: `tbz2-${name}`,
        url: "https://example.invalid/archive.tbz2",
        archive: "tar.bz2",
        targetDir,
      });

      expect(result.ok).toBe(false);
      expect(result.stderr).toMatch(error);
      await expect(fs.readdir(targetDir)).resolves.toEqual(["archive.tbz2"]);
    },
  );

  it("extracts the verified private archive when the published archive is replaced", async () => {
    const skillKey = "tbz2-published-archive-replacement";
    const targetDir = path.join(resolveSkillToolsRootDir(skillKey), "target");
    const replacement = Buffer.from("unverified replacement");
    const archive = TAR_BZIP2_FIXTURES.safe;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(archive),
      release: async () => {
        await fs.writeFile(path.join(targetDir, "archive.tbz2"), replacement);
      },
    });

    const result = await installDownloadSpec({
      skillKey,
      spec: {
        ...buildDownloadSpec({
          url: "https://example.invalid/archive.tbz2",
          archive: "tar.bz2",
          targetDir,
          stripComponents: 1,
        }),
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(true);
    await expect(fs.readFile(path.join(targetDir, "private.txt"), "utf8")).resolves.toBe(
      "private data\n",
    );
    await expect(fs.readFile(path.join(targetDir, "archive.tbz2"))).resolves.toEqual(replacement);
  });

  it.runIf(process.platform !== "win32").each([
    { name: "ordinary user", euid: 1000, mask: 0o077 },
    { name: "root", euid: 0, mask: 0 },
  ])("retains tar permission policy for $name", async ({ name, euid, mask }) => {
    const targetDir = path.join(workspaceDir, `tbz2-permissions-${euid}`);
    const archivePath = path.join(workspaceDir, `permissions-${euid}.tbz2`);
    await fs.mkdir(targetDir);
    await fs.writeFile(archivePath, TAR_BZIP2_FIXTURES.safe);
    const umask = vi.spyOn(process, "umask").mockReturnValue(0o077);
    // Only the installer's policy decision is simulated; filesystem ownership stays real.
    const getuid = vi.spyOn(process, "geteuid").mockReturnValueOnce(euid);
    try {
      const result = await extractSkillDownloadArchive({
        archivePath,
        archiveType: "tar.bz2",
        targetDir,
        stripComponents: 1,
        timeoutMs: 30_000,
      });

      expect(result.code, name).toBe(0);
      expect((await fs.stat(path.join(targetDir, "run.sh"))).mode & 0o777).toBe(0o755 & ~mask);
      expect((await fs.stat(path.join(targetDir, "private.txt"))).mode & 0o777).toBe(0o640 & ~mask);
    } finally {
      umask.mockRestore();
      getuid.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32").each(["read", "close"] as const)(
    "settles a staged %s failure before publishing any extracted files",
    async (operation) => {
      const name = `tbz2-staged-${operation}-failure`;
      const targetDir = path.join(resolveSkillToolsRootDir(name), "target");
      mockArchiveResponse(TAR_BZIP2_FIXTURES.safe);
      let extractedPath = "";
      const openedHandles: Array<{ handle: FileHandle; syncs: number; closes: number }> = [];
      __setFsSafeTestHooksForTest({
        afterOpen: (openedPath, handle) => {
          if (!openedPath.endsWith(path.join("extracted", "package", "run.sh"))) {
            return;
          }
          extractedPath = openedPath;
          const observed = { handle, syncs: 0, closes: 0 };
          openedHandles.push(observed);
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            observed.syncs += 1;
            await sync();
          });
          if (operation === "read") {
            const read = handle.read.bind(handle);
            vi.spyOn(handle, "read")
              .mockImplementationOnce(read)
              .mockRejectedValueOnce(new Error("staged read failed at EOF"));
          }
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            observed.closes += 1;
            await close();
            // Extraction's earlier durability handle must close normally.
            if (operation === "close" && observed.syncs === 0) {
              throw new Error("staged close failed");
            }
          });
        },
      });
      try {
        const result = await withEnvAsync(
          operation === "read" ? { FS_SAFE_NATIVE_MODE: "off" } : {},
          () =>
            installDownloadSkill({
              name,
              url: "https://example.invalid/archive.tbz2",
              archive: "tar.bz2",
              targetDir,
            }),
        );

        expect(result.ok).toBe(false);
        expect(result.stderr).toContain(`staged ${operation} failed`);
        expect(openedHandles.filter(({ syncs }) => syncs === 0)).toHaveLength(1);
        expect(new Set(openedHandles.map(({ handle }) => handle)).size).toBe(openedHandles.length);
        for (const { handle, closes } of openedHandles) {
          expect(closes).toBe(1);
          expect(handle.fd).toBe(-1);
        }
        await expect(fs.readdir(targetDir)).resolves.toEqual(["archive.tbz2"]);
        await expect(fileExists(extractedPath)).resolves.toBe(false);
      } finally {
        __setFsSafeTestHooksForTest(undefined);
        vi.restoreAllMocks();
      }
    },
  );

  it.runIf(process.platform !== "win32" && process.geteuid?.() !== 0).each([
    { name: "unreadable-file", archive: TAR_BZIP2_FIXTURES.unreadableFile },
    { name: "unsearchable-directory", archive: TAR_BZIP2_FIXTURES.unsearchableDirectory },
  ])("rejects $name before publishing earlier readable files", async ({ name, archive }) => {
    const targetDir = path.join(resolveSkillToolsRootDir(`tbz2-${name}`), "target");
    mockArchiveResponse(archive);

    const result = await installDownloadSkill({
      name: `tbz2-${name}`,
      url: "https://example.invalid/archive.tbz2",
      archive: "tar.bz2",
      targetDir,
    });

    expect(result.ok).toBe(false);
    await expect(fs.readdir(targetDir)).resolves.toEqual(["archive.tbz2"]);
  });

  it.runIf(process.platform !== "win32")("installs an empty read-only directory", async () => {
    const name = "tbz2-empty-read-only-directory";
    const targetDir = path.join(resolveSkillToolsRootDir(name), "target");
    mockArchiveResponse(TAR_BZIP2_FIXTURES.emptyReadOnlyDirectory);

    const result = await installDownloadSkill({
      name,
      url: "https://example.invalid/archive.tbz2",
      archive: "tar.bz2",
      targetDir,
    });

    expect(result.ok).toBe(true);
    expect((await fs.stat(path.join(targetDir, "directory"))).isDirectory()).toBe(true);
    await expect(fs.readdir(path.join(targetDir, "directory"))).resolves.toEqual([]);
  });

  it("rejects tar.bz2 entries that traverse pre-existing targetDir symlinks", async () => {
    const skillKey = "tbz2-targetdir-symlink";
    const targetDir = path.join(resolveSkillToolsRootDir(skillKey), "target");
    const outsideDir = path.join(workspaceDir, "tbz2-targetdir-outside");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(
      outsideDir,
      path.join(targetDir, "escape"),
      process.platform === "win32" ? "junction" : undefined,
    );
    mockArchiveResponse(TAR_BZIP2_FIXTURES.nested);

    const result = await installDownloadSkill({
      name: skillKey,
      url: "https://example.invalid/archive.tbz2",
      archive: "tar.bz2",
      targetDir,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr.toLowerCase()).toContain("archive entry traverses symlink in destination");
    expect(await fileExists(path.join(outsideDir, "pwn.txt"))).toBe(false);
  });
});
