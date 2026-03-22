import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import { autoMigrateLegacyMatrixState, detectLegacyMatrixState } from "./matrix-legacy-state.js";

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf-8");
}

describe("matrix legacy state migration", () => {
  it("migrates the flat legacy Matrix store into account-scoped storage", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"next_batch":"s1"}');
      writeFile(path.join(stateDir, "matrix", "crypto", "store.db"), "crypto");

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      };

      const detection = detectLegacyMatrixState({ cfg, env: process.env });
      expect(detection && "warning" in detection).toBe(false);
      if (!detection || "warning" in detection) {
        throw new Error("expected a migratable Matrix legacy state plan");
      }

      const result = await autoMigrateLegacyMatrixState({ cfg, env: process.env });
      expect(result.migrated).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(fs.existsSync(path.join(stateDir, "matrix", "bot-storage.json"))).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "matrix", "crypto"))).toBe(false);
      expect(fs.existsSync(detection.targetStoragePath)).toBe(true);
      expect(fs.existsSync(path.join(detection.targetCryptoPath, "store.db"))).toBe(true);
    });
  });

  it("uses cached Matrix credentials when the config no longer stores an access token", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"next_batch":"s1"}');
      writeFile(
        path.join(stateDir, "credentials", "matrix", "credentials.json"),
        JSON.stringify(
          {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-from-cache",
          },
          null,
          2,
        ),
      );

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            password: "secret", // pragma: allowlist secret
          },
        },
      };

      const detection = detectLegacyMatrixState({ cfg, env: process.env });
      expect(detection && "warning" in detection).toBe(false);
      if (!detection || "warning" in detection) {
        throw new Error("expected cached credentials to make Matrix migration resolvable");
      }

      expect(detection.targetRootDir).toContain("matrix.example.org__bot_example.org");

      const result = await autoMigrateLegacyMatrixState({ cfg, env: process.env });
      expect(result.migrated).toBe(true);
      expect(fs.existsSync(detection.targetStoragePath)).toBe(true);
    });
  });

  it("records which account receives a flat legacy store when multiple Matrix accounts exist", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"next_batch":"s1"}');

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            defaultAccount: "work",
            accounts: {
              work: {
                homeserver: "https://matrix.example.org",
                userId: "@work-bot:example.org",
                accessToken: "tok-work",
              },
              alerts: {
                homeserver: "https://matrix.example.org",
                userId: "@alerts-bot:example.org",
                accessToken: "tok-alerts",
              },
            },
          },
        },
      };

      const detection = detectLegacyMatrixState({ cfg, env: process.env });
      expect(detection && "warning" in detection).toBe(false);
      if (!detection || "warning" in detection) {
        throw new Error("expected a migratable Matrix legacy state plan");
      }

      expect(detection.accountId).toBe("work");
      expect(detection.selectionNote).toContain('account "work"');
    });
  });

  it("requires channels.matrix.defaultAccount before migrating a flat store into one of multiple accounts", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"next_batch":"s1"}');

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              work: {
                homeserver: "https://matrix.example.org",
                userId: "@work-bot:example.org",
                accessToken: "tok-work",
              },
              alerts: {
                homeserver: "https://matrix.example.org",
                userId: "@alerts-bot:example.org",
                accessToken: "tok-alerts",
              },
            },
          },
        },
      };

      const detection = detectLegacyMatrixState({ cfg, env: process.env });
      expect(detection && "warning" in detection).toBe(true);
      if (!detection || !("warning" in detection)) {
        throw new Error("expected a warning-only Matrix legacy state result");
      }
      expect(detection.warning).toContain("channels.matrix.defaultAccount is not set");
    });
  });

  it("uses scoped Matrix env vars when resolving a flat-store migration target", async () => {
    await withTempHome(
      async (home) => {
        const stateDir = path.join(home, ".openclaw");
        writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"next_batch":"s1"}');
        writeFile(path.join(stateDir, "matrix", "crypto", "store.db"), "crypto");

        const cfg: OpenClawConfig = {
          channels: {
            matrix: {
              accounts: {
                ops: {},
              },
            },
          },
        };

        const detection = detectLegacyMatrixState({ cfg, env: process.env });
        expect(detection && "warning" in detection).toBe(false);
        if (!detection || "warning" in detection) {
          throw new Error("expected scoped Matrix env vars to resolve a legacy state plan");
        }

        expect(detection.accountId).toBe("ops");
        expect(detection.targetRootDir).toContain("matrix.example.org__ops-bot_example.org");

        const result = await autoMigrateLegacyMatrixState({ cfg, env: process.env });
        expect(result.migrated).toBe(true);
        expect(result.warnings).toEqual([]);
        expect(fs.existsSync(detection.targetStoragePath)).toBe(true);
        expect(fs.existsSync(path.join(detection.targetCryptoPath, "store.db"))).toBe(true);
      },
      {
        env: {
          MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
          MATRIX_OPS_USER_ID: "@ops-bot:example.org",
          MATRIX_OPS_ACCESS_TOKEN: "tok-ops-env",
        },
      },
    );
  });

  it("migrates flat legacy Matrix state into the only configured non-default account", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"next_batch":"s1"}');
      writeFile(path.join(stateDir, "matrix", "crypto", "store.db"), "crypto");
      writeFile(
        path.join(stateDir, "credentials", "matrix", "credentials-ops.json"),
        JSON.stringify(
          {
            homeserver: "https://matrix.example.org",
            userId: "@ops-bot:example.org",
            accessToken: "tok-ops",
          },
          null,
          2,
        ),
      );

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                homeserver: "https://matrix.example.org",
                userId: "@ops-bot:example.org",
              },
            },
          },
        },
      };

      const detection = detectLegacyMatrixState({ cfg, env: process.env });
      expect(detection && "warning" in detection).toBe(false);
      if (!detection || "warning" in detection) {
        throw new Error("expected a migratable Matrix legacy state plan");
      }

      expect(detection.accountId).toBe("ops");

      const result = await autoMigrateLegacyMatrixState({ cfg, env: process.env });
      expect(result.migrated).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(fs.existsSync(detection.targetStoragePath)).toBe(true);
      expect(fs.existsSync(path.join(detection.targetCryptoPath, "store.db"))).toBe(true);
    });
  });
});
