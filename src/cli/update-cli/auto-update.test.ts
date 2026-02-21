import fs from "node:fs/promises";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadAutoUpdateConfig,
  saveAutoUpdateConfig,
  getAutoUpdateConfigPath,
} from "./auto-update.js";

vi.mock("node:fs/promises");
vi.mock("../../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/tmp/test-openclaw"),
}));

describe("auto-update config", () => {
  const testConfigPath = "/tmp/test-openclaw/auto-update.json";

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("loadAutoUpdateConfig", () => {
    it("returns default config when file does not exist", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      const config = await loadAutoUpdateConfig();

      expect(config.enabled).toBe(false);
      expect(config.interval).toBe("weekly");
      expect(config.skipVersions).toEqual([]);
      expect(config.notifyOnUpdate).toBe(true);
    });

    it("loads config from file when it exists", async () => {
      const mockConfig = {
        enabled: true,
        interval: "daily" as const,
        skipVersions: ["v1.0.0"],
        notifyOnUpdate: false,
      };
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockConfig));

      const config = await loadAutoUpdateConfig();

      expect(config.enabled).toBe(true);
      expect(config.interval).toBe("daily");
      expect(config.skipVersions).toEqual(["v1.0.0"]);
      expect(config.notifyOnUpdate).toBe(false);
    });

    it("falls back to defaults when JSON is invalid", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue("invalid json");

      const config = await loadAutoUpdateConfig();

      expect(config.enabled).toBe(false);
      expect(config.interval).toBe("weekly");
    });
  });

  describe("saveAutoUpdateConfig", () => {
    it("writes config to file", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await saveAutoUpdateConfig({
        enabled: false,
        interval: "manual",
        skipVersions: ["v2.0.0"],
        notifyOnUpdate: false,
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        testConfigPath,
        JSON.stringify(
          {
            enabled: false,
            interval: "manual",
            skipVersions: ["v2.0.0"],
            notifyOnUpdate: false,
          },
          null,
          2,
        ),
      );
    });
  });

  describe("getAutoUpdateConfigPath", () => {
    it("returns path to auto-update.json in state dir", () => {
      const path = getAutoUpdateConfigPath();
      expect(path).toBe("/tmp/test-openclaw/auto-update.json");
    });
  });
});
