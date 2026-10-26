import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as privateTempWorkspace from "@openclaw/fs-safe/temp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  type ClawHubDownloadResult,
  downloadClawHubGitHubSkillArchive,
  downloadClawHubPackageArchive,
  downloadClawHubSkillArchive,
  downloadClawHubSkillArchiveUrl,
} from "./clawhub-artifacts.js";
import { normalizeClawHubSha256Integrity, normalizeClawHubSha256Hex } from "./clawhub-integrity.js";
import { captureClawHubResponse } from "./clawhub.test-support.js";
import { makeStallingStream } from "./http-body.test-support.js";

vi.mock("@openclaw/fs-safe/temp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/temp")>()),
}));

const tempDirs = createTrackedTempDirs();
const bytes = new Uint8Array([7, 8, 9]);
const digest = (algorithm: string, encoding: "hex" | "base64" = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);

type TempWorkspace = Awaited<ReturnType<typeof privateTempWorkspace.tempWorkspace>>;
type ObservedTempWorkspace = Omit<TempWorkspace, "cleanup"> & {
  cleanup: ReturnType<typeof vi.fn<TempWorkspace["cleanup"]>>;
};

async function observeTempWorkspace(params: { cleanupFailure?: Error } = {}) {
  const root = await tempDirs.make("openclaw-clawhub-archive-");
  const createWorkspace = privateTempWorkspace.tempWorkspace;
  let workspace: ObservedTempWorkspace | undefined;
  vi.spyOn(privateTempWorkspace, "tempWorkspace").mockImplementation(async (options) => {
    const ownedWorkspace = await createWorkspace({ ...options, rootDir: root });
    workspace = {
      ...ownedWorkspace,
      cleanup: vi.fn(async () => {
        const result = await ownedWorkspace.cleanup();
        if (params.cleanupFailure) {
          throw params.cleanupFailure;
        }
        return result;
      }),
    };
    return workspace;
  });

  return {
    root,
    workspace(): ObservedTempWorkspace {
      if (!workspace) {
        throw new Error("archive acquisition did not create a temporary workspace");
      }
      return workspace;
    },
  };
}

function createArchiveResponse(headers?: HeadersInit): Response {
  return archiveResponse({
    "X-ClawHub-Artifact-Sha256": digest("sha256"),
    "X-ClawHub-Npm-Integrity": `sha512-${digest("sha512", "base64")}`,
    "X-ClawHub-Npm-Shasum": digest("sha1"),
    "X-ClawHub-Npm-Tarball-Name": "NUL.tgz",
    "X-ClawHub-ClawPack-Spec-Version": "3",
    ...Object.fromEntries(new Headers(headers)),
  });
}

function archiveResponse(headers: Record<string, string> = {}, body = bytes) {
  return new Response(new Uint8Array(body), {
    headers: { "content-type": "application/zip", ...headers },
  });
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function unendingArchive(headers: HeadersInit, firstChunk?: Uint8Array) {
  const cancel = vi.fn();
  const body = makeStallingStream(firstChunk ? [firstChunk] : [], (reason) => {
    cancel(reason);
  });
  return {
    response: new Response(body, { headers }),
    cancel,
  };
}

async function withArchive(
  archive: ClawHubDownloadResult,
  verify: (archive: ClawHubDownloadResult) => Promise<void>,
) {
  try {
    await verify(archive);
  } finally {
    await archive.cleanup();
    await expectPathMissing(path.dirname(archive.archivePath));
  }
}

function downloadPackageArchive(
  response: Response,
  options: Partial<Parameters<typeof downloadClawHubPackageArchive>[0]> = {},
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response);
  return downloadClawHubPackageArchive({
    name: "@hyf/zai-external-alpha",
    version: "0.0.1",
    token: "test-token",
    ...options,
  });
}

function downloadSkill(response: Response, slug: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response);
  return downloadClawHubSkillArchive({
    slug,
    token: "test-token",
  });
}

function failArchiveWrite(
  beforeFailure?: (file: Parameters<typeof fs.writeFile>[0]) => Promise<void>,
) {
  const error = Object.assign(new Error("disk full after partial archive write"), {
    code: "ENOSPC",
  });
  const writeFile = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (file) => {
    await writeFile(file, new Uint8Array([1]));
    await beforeFailure?.(file);
    throw error;
  });
  return error;
}

const clawpackOptions = { name: "demo", version: "1.2.3", artifact: "clawpack" } as const;

describe("clawhub artifacts", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CLAWHUB_TOKEN;
    await tempDirs.cleanup();
  });

  it("normalizes raw ClawHub SHA-256 hashes into integrity strings", () => {
    const hex = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const integrity = "sha256-A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=";
    const unpaddedIntegrity = "sha256-A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E";
    expect(normalizeClawHubSha256Integrity(hex)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(`sha256:${hex}`)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(integrity)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(unpaddedIntegrity)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(`sha256=${hex}`)).toBeNull();
    expect(normalizeClawHubSha256Integrity("sha256-a=")).toBeNull();
    expect(normalizeClawHubSha256Integrity("not-a-hash")).toBeNull();
  });

  it("normalizes ClawHub SHA-256 hex values", () => {
    expect(normalizeClawHubSha256Hex("AA".repeat(32))).toBe("aa".repeat(32));
    expect(normalizeClawHubSha256Hex("not-a-hash")).toBeNull();
  });

  it("downloads ClawPack package artifacts from the version route and verifies response headers", async () => {
    const sha256Hex = digest("sha256");
    const request = captureClawHubResponse(() =>
      archiveResponse({
        "content-type": "application/octet-stream",
        "X-ClawHub-Artifact-Sha256": sha256Hex,
      }),
    );
    const archive = await downloadClawHubPackageArchive(clawpackOptions);

    await withArchive(archive, async () => {
      expect(request.url().pathname).toBe("/api/v1/packages/demo/versions/1.2.3/artifact/download");
      expect(path.basename(archive.archivePath)).toBe("demo-1.2.3.tgz");
      expect(archive).toMatchObject({
        artifact: "clawpack",
        sha256Hex,
        clawpackHeaderSha256: sha256Hex,
        npmIntegrity: expect.stringMatching(/^sha512-/),
        npmShasum: digest("sha1"),
      });
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from(bytes));
    });
  });

  it("rejects ClawPack package artifacts when the declared digest does not match the bytes", async () => {
    await expect(
      downloadPackageArchive(
        archiveResponse({
          "content-type": "application/octet-stream",
          "X-ClawHub-Artifact-Sha256": "0".repeat(64),
        }),
        { ...clawpackOptions, token: undefined },
      ),
    ).rejects.toThrow(/declared sha256/);
  });

  it("rejects and cancels oversized archive downloads", async () => {
    const oversized = unendingArchive({
      "content-type": "application/zip",
      "content-length": String(256 * 1024 * 1024 + 512 * 1024),
    });
    await expect(downloadPackageArchive(oversized.response)).rejects.toThrow(
      "ClawHub package archive download for @hyf/zai-external-alpha exceeded 268435456 bytes (268959744 bytes declared)",
    );
    expect(oversized.cancel).toHaveBeenCalledTimes(1);
  });

  it("removes the owned workspace when writing an archive partially fails", async () => {
    const observed = await observeTempWorkspace();
    const unrelatedFile = path.join(observed.root, "preexisting.txt");
    await fs.writeFile(unrelatedFile, "preserved");

    const writeError = failArchiveWrite();
    await expect(downloadPackageArchive(createArchiveResponse())).rejects.toBe(writeError);
    const workspace = observed.workspace();
    expect(workspace.cleanup).toHaveBeenCalledOnce();
    await expectPathMissing(workspace.dir);
    await expect(fs.readFile(unrelatedFile, "utf8")).resolves.toBe("preserved");
    await expect(fs.readdir(observed.root)).resolves.toEqual(["preexisting.txt"]);
  });

  it.each(["clawpack", "archive"] as const)(
    "preserves %s bytes, integrity, metadata, and caller-owned cleanup",
    async (artifact) => {
      const observed = await observeTempWorkspace();
      const sha256Digest = digest("sha256");
      const response = createArchiveResponse(
        artifact === "clawpack" ? { "content-type": "application/octet-stream" } : undefined,
      );
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => response);
      const archive = await (artifact === "clawpack"
        ? downloadPackageArchive(response, clawpackOptions)
        : downloadClawHubGitHubSkillArchive({
            repo: "owner/repo",
            commit: "abc123",
          }));
      const workspace = observed.workspace();

      expect(path.basename(archive.archivePath)).toBe(
        artifact === "clawpack" ? "NUL_.tgz" : "abc123.zip",
      );
      expect(archive).toMatchObject({
        artifact,
        sha256Hex: sha256Digest,
        integrity: `sha256-${digest("sha256", "base64")}`,
      });
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from(bytes));
      expect(workspace.cleanup).not.toHaveBeenCalled();

      if (artifact === "clawpack") {
        expect(archive).toMatchObject({
          clawpackHeaderSha256: sha256Digest,
          npmIntegrity: `sha512-${digest("sha512", "base64")}`,
          npmShasum: digest("sha1"),
          npmTarballName: "NUL.tgz",
        });
      }

      await archive.cleanup();
      expect(workspace.cleanup).toHaveBeenCalledOnce();
      await expectPathMissing(workspace.dir);
    },
  );

  it("does not delete a replacement workspace after an archive write failure", async () => {
    const observed = await observeTempWorkspace();
    const writeFile = fs.writeFile;
    const writeError = failArchiveWrite(async () => {
      const workspace = observed.workspace();
      await fs.rename(workspace.dir, `${workspace.dir}-original`);
      await fs.mkdir(workspace.dir);
      await writeFile(path.join(workspace.dir, "replacement-marker"), "preserved");
    });

    await expect(downloadSkill(createArchiveResponse(), "replacement-skill")).rejects.toBe(
      writeError,
    );

    const workspace = observed.workspace();
    expect(workspace.cleanup).toHaveBeenCalledOnce();
    await expect(vi.mocked(workspace.cleanup).mock.results[0]?.value).resolves.toBe(
      "identity-mismatch",
    );
    await expect(fs.readFile(path.join(workspace.dir, "replacement-marker"), "utf8")).resolves.toBe(
      "preserved",
    );
    await expect(
      fs.readFile(path.join(`${workspace.dir}-original`, "replacement-skill.zip")),
    ).resolves.toEqual(Buffer.from([1]));
  });

  it("keeps the original archive write failure when cleanup logging fails", async () => {
    const cleanupError = new Error("temporary workspace cleanup failed");
    cleanupError.toString = () => {
      throw new Error("temporary workspace cleanup logger failed");
    };
    const observed = await observeTempWorkspace({ cleanupFailure: cleanupError });
    const writeError = failArchiveWrite();
    await expect(downloadSkill(createArchiveResponse(), "cleanup-failure-skill")).rejects.toBe(
      writeError,
    );
    expect(observed.workspace().cleanup).toHaveBeenCalledOnce();
    await expectPathMissing(observed.workspace().dir);
  });

  it("uses decoded stream bytes instead of encoded content length", async () => {
    const decodedBytes = new Uint8Array([1, 2, 3]);
    const archive = await downloadPackageArchive(
      archiveResponse(
        {
          "content-encoding": "gzip",
          "content-length": String(256 * 1024 * 1024 + 1),
        },
        decodedBytes,
      ),
      { name: "encoded-package", version: "1.0.0", token: undefined },
    );
    await withArchive(archive, async () => {
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from(decodedBytes));
    });
  });

  it("times out and cancels stalled skill archive body reads", async () => {
    const stalled = unendingArchive({ "content-type": "application/zip" }, new Uint8Array([4]));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => stalled.response);

    await expect(
      downloadClawHubSkillArchive({
        slug: "agentreceipt",
        version: "1.0.0",
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/skill archive download for agentreceipt body stalled after 5ms/i);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("does not send ambient ClawHub auth tokens to off-registry resolver archive URLs", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    const request = captureClawHubResponse(() => archiveResponse());
    const archive = await downloadClawHubSkillArchiveUrl({
      baseUrl: "https://clawhub.ai",
      url: "https://codeload.github.com/NVIDIA/skills/zip/abcdef",
    });

    await withArchive(archive, async () => {
      expect(request.url().toString()).toBe("https://codeload.github.com/NVIDIA/skills/zip/abcdef");
      expect(new Headers(request.init()?.headers).get("Authorization")).toBeNull();
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from([7, 8, 9]));
    });
  });
});
