import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";

describe("config io invalid-config fallback", () => {
  it("preserves DM policy settings when strict schema validation fails", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            channels: {
              whatsapp: {
                dmPolicy: "allowlist",
                allowFrom: ["+15555550123"],
              },
            },
            unknown_top_level_key_trigger: true,
          },
          null,
          2,
        ),
        "utf-8",
      );

      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
      });

      const cfg = io.loadConfig();

      expect(cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
      expect(cfg.channels?.whatsapp?.allowFrom).toEqual(["+15555550123"]);
      expect(cfg.channels?.whatsapp?.dmPolicy ?? "pairing").toBe("allowlist");
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid config at ${configPath}:`),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("using best-effort fallback"),
      );
    });
  });

  it("preserves DM policy settings when plugin validation fails", async () => {
    await withTempHome("openclaw-config-io-", async (home) => {
      const missingPluginPath = path.join(home, "missing-plugin-path");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            channels: {
              whatsapp: {
                dmPolicy: "allowlist",
                allowFrom: ["+15555550123"],
              },
            },
            plugins: {
              load: { paths: [missingPluginPath] },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      const cfg = io.loadConfig();

      expect(cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
      expect(cfg.channels?.whatsapp?.allowFrom).toEqual(["+15555550123"]);
      expect(cfg.channels?.whatsapp?.dmPolicy ?? "pairing").toBe("allowlist");
    });
  });
});
