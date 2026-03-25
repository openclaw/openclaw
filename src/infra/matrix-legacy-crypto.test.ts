import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMatrixAccountStorageRoot } from "../../extensions/matrix/runtime-api.js";
import { withTempHome } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import { autoPrepareLegacyMatrixCrypto, detectLegacyMatrixCrypto } from "./matrix-legacy-crypto.js";
import { MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE } from "./matrix-plugin-helper.js";

vi.unmock("../version.js");

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function writeMatrixPluginFixture(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "matrix",
      configSchema: {
        type: "object",
        additionalProperties: false,
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(rootDir, "index.js"), "export default {};\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "legacy-crypto-inspector.js"),
    [
      "export async function inspectLegacyMatrixCryptoStore() {",
      '  return { deviceId: "FIXTURE", roomKeyCounts: { total: 1, backedUp: 1 }, backupVersion: "1", decryptionKeyBase64: null };',
      "}",
    ].join("\n"),
    "utf8",
  );
}

const matrixHelperEnv = {
  OPENCLAW_BUNDLED_PLUGINS_DIR: (home: string) => path.join(home, "bundled"),
  OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
  OPENCLAW_VERSION: undefined,
  VITEST: "true",
};

describe("matrix legacy encrypted-state migration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts a saved backup key into the new recovery-key path", async () => {
    await withTempHome(
      async (home) => {
        writeMatrixPluginFixture(path.join(home, "bundled", "matrix"));
        const stateDir = path.join(home, ".openclaw");
        const cfg: OpenClawConfig = {
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            },
          },
        };
        const { rootDir } = resolveMatrixAccountStorageRoot({
          stateDir,
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
        });
        writeFile(path.join(rootDir, "crypto", "bot-sdk.json"), '{"deviceId":"DEVICE123"}');

        const detection = detectLegacyMatrixCrypto({ cfg, env: process.env });
        expect(detection.warnings).toEqual([]);
        expect(detection.plans).toHaveLength(1);

        const inspectLegacyStore = vi.fn(async () => ({
          deviceId: "DEVICE123",
          roomKeyCounts: { total: 12, backedUp: 12 },
          backupVersion: "1",
          decryptionKeyBase64: "YWJjZA==",
        }));

        const result = await autoPrepareLegacyMatrixCrypto({
          cfg,
          env: process.env,
          deps: { inspectLegacyStore },
        });

        expect(result.migrated).toBe(true);
        expect(result.warnings).toEqual([]);
        expect(inspectLegacyStore).toHaveBeenCalledOnce();

        const recovery = JSON.parse(
          fs.readFileSync(path.join(rootDir, "recovery-key.json"), "utf8"),
        ) as {
          privateKeyBase64: string;
        };
        expect(recovery.privateKeyBase64).toBe("YWJjZA==");

        const state = JSON.parse(
          fs.readFileSync(path.join(rootDir, "legacy-crypto-migration.json"), "utf8"),
        ) as {
          restoreStatus: string;
          decryptionKeyImported: boolean;
        };
        expect(state.restoreStatus).toBe("pending");
        expect(state.decryptionKeyImported).toBe(true);
      },
      { env: matrixHelperEnv },
    );
  });

  it("warns when legacy local-only room keys cannot be recovered automatically", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      };
      const { rootDir } = resolveMatrixAccountStorageRoot({
        stateDir,
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      });
      writeFile(path.join(rootDir, "crypto", "bot-sdk.json"), '{"deviceId":"DEVICE123"}');

      const result = await autoPrepareLegacyMatrixCrypto({
        cfg,
        env: process.env,
        deps: {
          inspectLegacyStore: async () => ({
            deviceId: "DEVICE123",
            roomKeyCounts: { total: 15, backedUp: 10 },
            backupVersion: null,
            decryptionKeyBase64: null,
          }),
        },
      });

      expect(result.migrated).toBe(true);
      expect(result.warnings).toContain(
        'Legacy Matrix encrypted state for account "default" contains 5 room key(s) that were never backed up. Backed-up keys can be restored automatically, but local-only encrypted history may remain unavailable after upgrade.',
      );
      expect(result.warnings).toContain(
        'Legacy Matrix encrypted state for account "default" cannot be fully converted automatically because the old rust crypto store does not expose all local room keys for export.',
      );
      const state = JSON.parse(
        fs.readFileSync(path.join(rootDir, "legacy-crypto-migration.json"), "utf8"),
      ) as {
        restoreStatus: string;
      };
      expect(state.restoreStatus).toBe("manual-action-required");
    });
  });

  it("warns instead of throwing when recovery-key persistence fails", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      };
      const { rootDir } = resolveMatrixAccountStorageRoot({
        stateDir,
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      });
      writeFile(path.join(rootDir, "crypto", "bot-sdk.json"), '{"deviceId":"DEVICE123"}');

      const result = await autoPrepareLegacyMatrixCrypto({
        cfg,
        env: process.env,
        deps: {
          inspectLegacyStore: async () => ({
            deviceId: "DEVICE123",
            roomKeyCounts: { total: 12, backedUp: 12 },
            backupVersion: "1",
            decryptionKeyBase64: "YWJjZA==",
          }),
          writeJsonFileAtomically: async (filePath) => {
            if (filePath.endsWith("recovery-key.json")) {
              throw new Error("disk full");
            }
            writeFile(filePath, JSON.stringify({ ok: true }, null, 2));
          },
        },
      });

      expect(result.migrated).toBe(false);
      expect(result.warnings).toContain(
        `Failed writing Matrix recovery key for account "default" (${path.join(rootDir, "recovery-key.json")}): Error: disk full`,
      );
      expect(fs.existsSync(path.join(rootDir, "recovery-key.json"))).toBe(false);
      expect(fs.existsSync(path.join(rootDir, "legacy-crypto-migration.json"))).toBe(false);
    });
  });

  it("prepares flat legacy crypto for the only configured non-default Matrix account", async () => {
    await withTempHome(
      async (home) => {
        writeMatrixPluginFixture(path.join(home, "bundled", "matrix"));
        const stateDir = path.join(home, ".openclaw");
        writeFile(
          path.join(stateDir, "matrix", "crypto", "bot-sdk.json"),
          JSON.stringify({ deviceId: "DEVICEOPS" }),
        );
        writeFile(
          path.join(stateDir, "credentials", "matrix", "credentials-ops.json"),
          JSON.stringify(
            {
              homeserver: "https://matrix.example.org",
              userId: "@ops-bot:example.org",
              accessToken: "tok-ops",
              deviceId: "DEVICEOPS",
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
        const { rootDir } = resolveMatrixAccountStorageRoot({
          stateDir,
          homeserver: "https://matrix.example.org",
          userId: "@ops-bot:example.org",
          accessToken: "tok-ops",
          accountId: "ops",
        });

        const detection = detectLegacyMatrixCrypto({ cfg, env: process.env });
        expect(detection.warnings).toEqual([]);
        expect(detection.plans).toHaveLength(1);
        expect(detection.plans[0]?.accountId).toBe("ops");

        const result = await autoPrepareLegacyMatrixCrypto({
          cfg,
          env: process.env,
          deps: {
            inspectLegacyStore: async () => ({
              deviceId: "DEVICEOPS",
              roomKeyCounts: { total: 6, backedUp: 6 },
              backupVersion: "21868",
              decryptionKeyBase64: "YWJjZA==",
            }),
          },
        });

        expect(result.migrated).toBe(true);
        expect(result.warnings).toEqual([]);
        const recovery = JSON.parse(
          fs.readFileSync(path.join(rootDir, "recovery-key.json"), "utf8"),
        ) as {
          privateKeyBase64: string;
        };
        expect(recovery.privateKeyBase64).toBe("YWJjZA==");
        const state = JSON.parse(
          fs.readFileSync(path.join(rootDir, "legacy-crypto-migration.json"), "utf8"),
        ) as {
          accountId: string;
        };
        expect(state.accountId).toBe("ops");
      },
      { env: matrixHelperEnv },
    );
  });

  it("uses scoped Matrix env vars when resolving flat legacy crypto migration", async () => {
    await withTempHome(
      async (home) => {
        writeMatrixPluginFixture(path.join(home, "bundled", "matrix"));
        const stateDir = path.join(home, ".openclaw");
        writeFile(
          path.join(stateDir, "matrix", "crypto", "bot-sdk.json"),
          JSON.stringify({ deviceId: "DEVICEOPS" }),
        );

        const cfg: OpenClawConfig = {
          channels: {
            matrix: {
              accounts: {
                ops: {},
              },
            },
          },
        };
        const { rootDir } = resolveMatrixAccountStorageRoot({
          stateDir,
          homeserver: "https://matrix.example.org",
          userId: "@ops-bot:example.org",
          accessToken: "tok-ops-env",
          accountId: "ops",
        });

        const detection = detectLegacyMatrixCrypto({ cfg, env: process.env });
        expect(detection.warnings).toEqual([]);
        expect(detection.plans).toHaveLength(1);
        expect(detection.plans[0]?.accountId).toBe("ops");

        const result = await autoPrepareLegacyMatrixCrypto({
          cfg,
          env: process.env,
          deps: {
            inspectLegacyStore: async () => ({
              deviceId: "DEVICEOPS",
              roomKeyCounts: { total: 4, backedUp: 4 },
              backupVersion: "9001",
              decryptionKeyBase64: "YWJjZA==",
            }),
          },
        });

        expect(result.migrated).toBe(true);
        expect(result.warnings).toEqual([]);
        const recovery = JSON.parse(
          fs.readFileSync(path.join(rootDir, "recovery-key.json"), "utf8"),
        ) as {
          privateKeyBase64: string;
        };
        expect(recovery.privateKeyBase64).toBe("YWJjZA==");
      },
      {
        env: {
          ...matrixHelperEnv,
          MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
          MATRIX_OPS_USER_ID: "@ops-bot:example.org",
          MATRIX_OPS_ACCESS_TOKEN: "tok-ops-env",
        },
      },
    );
  });

  it("requires channels.matrix.defaultAccount before preparing flat legacy crypto for one of multiple accounts", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(
        path.join(stateDir, "matrix", "crypto", "bot-sdk.json"),
        JSON.stringify({ deviceId: "DEVICEOPS" }),
      );

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                homeserver: "https://matrix.example.org",
                userId: "@ops-bot:example.org",
                accessToken: "tok-ops",
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

      const detection = detectLegacyMatrixCrypto({ cfg, env: process.env });
      expect(detection.plans).toHaveLength(0);
      expect(detection.warnings).toContain(
        "Legacy Matrix encrypted state detected at " +
          path.join(stateDir, "matrix", "crypto") +
          ', but multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set. Set "channels.matrix.defaultAccount" to the intended target account before rerunning "openclaw doctor --fix" or restarting the gateway.',
      );
    });
  });

  it("warns instead of throwing when a legacy crypto path is a file", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(path.join(stateDir, "matrix", "crypto"), "not-a-directory");

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      };

      const detection = detectLegacyMatrixCrypto({ cfg, env: process.env });
      expect(detection.plans).toHaveLength(0);
      expect(detection.warnings).toContain(
        `Legacy Matrix encrypted state path exists but is not a directory: ${path.join(stateDir, "matrix", "crypto")}. OpenClaw skipped automatic crypto migration for that path.`,
      );
    });
  });

  it("reports a missing matrix plugin helper once when encrypted-state migration cannot run", async () => {
    await withTempHome(
      async (home) => {
        const stateDir = path.join(home, ".openclaw");
        writeFile(
          path.join(stateDir, "matrix", "crypto", "bot-sdk.json"),
          '{"deviceId":"DEVICE123"}',
        );

        const cfg: OpenClawConfig = {
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            },
          },
        };

        const result = await autoPrepareLegacyMatrixCrypto({
          cfg,
          env: process.env,
        });

        expect(result.migrated).toBe(false);
        expect(
          result.warnings.filter(
            (warning) => warning === MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE,
          ),
        ).toHaveLength(1);
      },
      {
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: (home) => path.join(home, "empty-bundled"),
        },
      },
    );
  });
});
