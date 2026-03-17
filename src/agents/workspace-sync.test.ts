import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSyncConfig } from "../config/types.agent-defaults.js";
import {
  applyWorkspaceManifest,
  pullAndApplyWorkspaceSync,
  pullWorkspaceManifest,
  pushWorkspaceToRemote,
  type WorkspaceManifest,
} from "./workspace-sync.js";
import {
  DEFAULT_SOUL_FILENAME,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
} from "./workspace.js";

function buildCryptoHash(data: string) {
  return require("node:crypto").createHash("sha256").update(data).digest("hex");
}

describe("Workspace Sync Service", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-sync-test-"));
    // Mock fetch
    globalThis.fetch = vi.fn();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("pullWorkspaceManifest", () => {
    it("throws if no url is configured", async () => {
      await expect(pullWorkspaceManifest({})).rejects.toThrow(
        "Workspace sync URL is not configured",
      );
    });

    it("throws on invalid URL scheme", async () => {
      await expect(pullWorkspaceManifest({ url: "ftp://example.com/workspace" })).rejects.toThrow(
        "Invalid URL scheme",
      );
    });

    it("rejects insecure HTTP by default", async () => {
      await expect(pullWorkspaceManifest({ url: "http://example.com/workspace" })).rejects.toThrow(
        "HTTP URL used without allowInsecure=true in configuration",
      );
    });

    it("allows insecure HTTP when allowInsecure=true", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 1, files: {} })),
      );

      const manifest = await pullWorkspaceManifest({
        url: "http://example.com/workspace",
        allowInsecure: true,
      });

      expect(manifest.version).toBe(1);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://example.com/workspace",
        expect.any(Object),
      );
    });

    it("allows localhost HTTP even without allowInsecure", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 1, files: {} })),
      );

      const manifest = await pullWorkspaceManifest({ url: "http://localhost:8080/w" });
      expect(manifest.version).toBe(1);
    });

    it("sends Bearer token if configured", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 1, files: {} })),
      );

      await pullWorkspaceManifest({ url: "https://example.com/w", token: "secret-abc" });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.com/w",
        expect.objectContaining({
          headers: {
            Accept: "application/json",
            Authorization: "Bearer secret-abc",
          },
        }),
      );
    });

    it("validates manifest structure", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 2, files: {} })), // Bad version
      );

      await expect(pullWorkspaceManifest({ url: "https://example.com/w" })).rejects.toThrow(
        "Unsupported manifest version: 2",
      );
    });
  });

  describe("applyWorkspaceManifest", () => {
    it("writes allowed files into the workspace atomically", async () => {
      const manifest: WorkspaceManifest = {
        version: 1,
        files: {
          [DEFAULT_SOUL_FILENAME]: "# Soul Content",
          [DEFAULT_AGENTS_FILENAME]: "# Agents Content",
          "UNSUPPORTED.md": "should be ignored", // Not an allowed bootstrap file
        },
      };

      const updated = await applyWorkspaceManifest(manifest, tempDir);

      expect(updated).toEqual(
        expect.arrayContaining([DEFAULT_SOUL_FILENAME, DEFAULT_AGENTS_FILENAME]),
      );
      expect(updated).not.toContain("UNSUPPORTED.md");

      const soul = await fs.readFile(path.join(tempDir, DEFAULT_SOUL_FILENAME), "utf8");
      expect(soul).toBe("# Soul Content");

      const agents = await fs.readFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "utf8");
      expect(agents).toBe("# Agents Content");

      await expect(fs.stat(path.join(tempDir, "UNSUPPORTED.md"))).rejects.toThrow("ENOENT");
    });
  });

  describe("pullAndApplyWorkspaceSync", () => {
    it("returns early if not enabled", async () => {
      const result = await pullAndApplyWorkspaceSync({}, tempDir);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/disabled/i);
    });

    it("pulls and applies manifest successfully", async () => {
      const validFiles = {
        [DEFAULT_IDENTITY_FILENAME]: "foo",
      };
      const filesStr = "IDENTITY.md:foo";
      const sha256 = buildCryptoHash(filesStr);

      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 1, files: validFiles, sha256 })),
      );

      const config: WorkspaceSyncConfig = {
        enabled: true,
        url: "https://example.com/w",
      };

      const result = await pullAndApplyWorkspaceSync(config, tempDir);

      expect(result.ok).toBe(true);
      expect(result.filesUpdated).toEqual([DEFAULT_IDENTITY_FILENAME]);

      const identity = await fs.readFile(path.join(tempDir, DEFAULT_IDENTITY_FILENAME), "utf8");
      expect(identity).toBe("foo");
    });

    it("fails if checksum mismatch", async () => {
      const validFiles = {
        [DEFAULT_IDENTITY_FILENAME]: "foo",
      };

      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 1, files: validFiles, sha256: "bad-hash" })),
      );

      const config: WorkspaceSyncConfig = {
        enabled: true,
        url: "https://example.com/w",
      };

      const result = await pullAndApplyWorkspaceSync(config, tempDir);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/checksum mismatch/);
    });
  });

  describe("pushWorkspaceToRemote", () => {
    it("reads local files and PUTs to pushUrl", async () => {
      await fs.writeFile(path.join(tempDir, DEFAULT_SOUL_FILENAME), "hello soul");

      const mockFetchResponse = new Response("{}", { status: 200 });
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockFetchResponse);

      const config: WorkspaceSyncConfig = {
        enabled: true, // doesn't explicitly matter for push fn, but good practice
        url: "https://example.com/w",
        pushUrl: "https://example.com/push",
        pushToken: "secret-push-token",
      };

      const result = await pushWorkspaceToRemote(config, tempDir);
      expect(result.ok).toBe(true);
      expect(result.filesUpdated).toEqual([DEFAULT_SOUL_FILENAME]);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.com/push",
        expect.objectContaining({
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: "Bearer secret-push-token",
          },
          body: expect.stringContaining("hello soul"),
        }),
      );
    });

    it("falls back to pull url returning error if missing", async () => {
      const result = await pushWorkspaceToRemote({}, tempDir);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/No URL configured/);
    });

    it("returns error if no recognized files are found locally", async () => {
      const config: WorkspaceSyncConfig = {
        url: "https://example.com/w",
      };
      const result = await pushWorkspaceToRemote(config, tempDir);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/No recognized files/);
    });
  });
});
