import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveSyncConfig, generateRcloneConfig, isRcloneConfigured } from "./rclone.js";

describe("rclone helpers", () => {
  describe("resolveSyncConfig", () => {
    it("uses defaults when config is minimal", () => {
      const config = { provider: "dropbox" as const, remotePath: "test-folder" };
      const workspaceDir = path.join("/home", "user", "workspace");
      const stateDir = path.join("/home", "user", ".moltbot");

      const resolved = resolveSyncConfig(config, workspaceDir, stateDir);

      expect(resolved.provider).toBe("dropbox");
      expect(resolved.remotePath).toBe("test-folder");
      expect(resolved.localPath).toBe(path.join(workspaceDir, "shared"));
      expect(resolved.remoteName).toBe("cloud");
      expect(resolved.conflictResolve).toBe("newer");
      expect(resolved.interval).toBe(0);
      expect(resolved.onSessionStart).toBe(false);
      expect(resolved.onSessionEnd).toBe(false);
    });

    it("respects custom localPath", () => {
      const config = {
        provider: "dropbox" as const,
        remotePath: "test-folder",
        localPath: "sync",
      };
      const workspaceDir = path.join("/home", "user", "workspace");
      const stateDir = path.join("/home", "user", ".moltbot");

      const resolved = resolveSyncConfig(config, workspaceDir, stateDir);

      expect(resolved.localPath).toBe(path.join(workspaceDir, "sync"));
    });

    it("respects custom remoteName", () => {
      const config = {
        provider: "dropbox" as const,
        remotePath: "test-folder",
        remoteName: "my-dropbox",
      };
      const workspaceDir = path.join("/home", "user", "workspace");
      const stateDir = path.join("/home", "user", ".moltbot");

      const resolved = resolveSyncConfig(config, workspaceDir, stateDir);

      expect(resolved.remoteName).toBe("my-dropbox");
    });

    it("respects interval and session hooks", () => {
      const config = {
        provider: "dropbox" as const,
        remotePath: "test-folder",
        interval: 300,
        onSessionStart: true,
        onSessionEnd: true,
      };
      const workspaceDir = path.join("/home", "user", "workspace");
      const stateDir = path.join("/home", "user", ".moltbot");

      const resolved = resolveSyncConfig(config, workspaceDir, stateDir);

      expect(resolved.interval).toBe(300);
      expect(resolved.onSessionStart).toBe(true);
      expect(resolved.onSessionEnd).toBe(true);
    });

    it("applies default excludes", () => {
      const config = { provider: "dropbox" as const, remotePath: "test" };
      const resolved = resolveSyncConfig(config, "/workspace", "/state");

      expect(resolved.exclude).toContain(".git/**");
      expect(resolved.exclude).toContain("node_modules/**");
    });

    it("respects custom excludes", () => {
      const config = {
        provider: "dropbox" as const,
        remotePath: "test",
        exclude: ["*.tmp", "cache/**"],
      };
      const resolved = resolveSyncConfig(config, "/workspace", "/state");

      expect(resolved.exclude).toEqual(["*.tmp", "cache/**"]);
    });
  });

  describe("generateRcloneConfig", () => {
    it("generates dropbox config with token", () => {
      const config = generateRcloneConfig("dropbox", "cloud", '{"access_token":"abc123"}');

      expect(config).toContain("[cloud]");
      expect(config).toContain("type = dropbox");
      expect(config).toContain('token = {"access_token":"abc123"}');
    });

    it("generates gdrive config", () => {
      const config = generateRcloneConfig("gdrive", "drive", '{"access_token":"xyz"}');

      expect(config).toContain("[drive]");
      expect(config).toContain("type = drive");
      expect(config).toContain('token = {"access_token":"xyz"}');
    });

    it("generates onedrive config", () => {
      const config = generateRcloneConfig("onedrive", "od", '{"access_token":"123"}');

      expect(config).toContain("[od]");
      expect(config).toContain("type = onedrive");
    });

    it("includes app key/secret for dropbox app folder", () => {
      const config = generateRcloneConfig("dropbox", "cloud", '{"access_token":"abc"}', {
        dropbox: { appKey: "key123", appSecret: "secret456" },
      });

      expect(config).toContain("client_id = key123");
      expect(config).toContain("client_secret = secret456");
    });

    it("generates s3 config with endpoint", () => {
      const config = generateRcloneConfig("s3", "r2", "", {
        s3: {
          endpoint: "https://xxx.r2.cloudflarestorage.com",
          accessKeyId: "AKID",
          secretAccessKey: "SECRET",
        },
      });

      expect(config).toContain("[r2]");
      expect(config).toContain("type = s3");
      expect(config).toContain("endpoint = https://xxx.r2.cloudflarestorage.com");
      expect(config).toContain("access_key_id = AKID");
      expect(config).toContain("secret_access_key = SECRET");
    });

    it("includes region for s3 when provided", () => {
      const config = generateRcloneConfig("s3", "aws", "", {
        s3: {
          region: "us-east-1",
          bucket: "my-bucket",
        },
      });

      expect(config).toContain("region = us-east-1");
    });
  });

  describe("isRcloneConfigured", () => {
    it("returns false when config file does not exist", () => {
      const result = isRcloneConfigured("/nonexistent/path/rclone.conf", "cloud");
      expect(result).toBe(false);
    });
  });
});
