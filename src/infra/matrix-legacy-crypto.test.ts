import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMatrixAccountStorageRoot } from "../../extensions/matrix/runtime-api.js";
import { withTempHome } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import { autoPrepareLegacyMatrixCrypto, detectLegacyMatrixCrypto } from "./matrix-legacy-crypto.js";
import { MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE } from "./matrix-plugin-helper.js";
import {
  MATRIX_DEFAULT_ACCESS_TOKEN,
  MATRIX_DEFAULT_DEVICE_ID,
  MATRIX_DEFAULT_USER_ID,
  MATRIX_OPS_ACCESS_TOKEN,
  MATRIX_OPS_ACCOUNT_ID,
  MATRIX_OPS_DEVICE_ID,
  MATRIX_OPS_USER_ID,
  MATRIX_TEST_HOMESERVER,
  matrixHelperEnv,
  writeFile,
  writeMatrixCredentials,
  writeMatrixPluginFixture,
} from "./matrix.test-helpers.js";

vi.unmock("../version.js");

function createDefaultMatrixConfig(): OpenClawConfig {
  return {
    channels: {
      matrix: {
        homeserver: MATRIX_TEST_HOMESERVER,
        userId: MATRIX_DEFAULT_USER_ID,
        accessToken: MATRIX_DEFAULT_ACCESS_TOKEN,
      },
    },
  };
}

function writeDefaultLegacyCryptoFixture(home: string) {
  const stateDir = path.join(home, ".openclaw");
  const cfg = createDefaultMatrixConfig();
  const { rootDir } = resolveMatrixAccountStorageRoot({
    stateDir,
    homeserver: MATRIX_TEST_HOMESERVER,
    userId: MATRIX_DEFAULT_USER_ID,
    accessToken: MATRIX_DEFAULT_ACCESS_TOKEN,
  });
  writeFile(
    path.join(rootDir, "crypto", "bot-sdk.json"),
    JSON.stringify({ deviceId: MATRIX_DEFAULT_DEVICE_ID }),
  );
  return { cfg, rootDir, stateDir };
}

function createOpsLegacyCryptoFixture(params: {
  home: string;
  cfg: OpenClawConfig;
  accessToken?: string;
  includeStoredCredentials?: boolean;
}) {
  const stateDir = path.join(params.home, ".openclaw");
  writeMatrixPluginFixture(path.join(params.home, "bundled", "matrix"));
  writeFile(
    path.join(stateDir, "matrix", "crypto", "bot-sdk.json"),
    JSON.stringify({ deviceId: MATRIX_OPS_DEVICE_ID }),
  );
  if (params.includeStoredCredentials) {
    writeMatrixCredentials(stateDir, {
      accountId: MATRIX_OPS_ACCOUNT_ID,
      accessToken: params.accessToken ?? MATRIX_OPS_ACCESS_TOKEN,
      deviceId: MATRIX_OPS_DEVICE_ID,
    });
  }
  const { rootDir } = resolveMatrixAccountStorageRoot({
    stateDir,
    homeserver: MATRIX_TEST_HOMESERVER,
    userId: MATRIX_OPS_USER_ID,
    accessToken: params.accessToken ?? MATRIX_OPS_ACCESS_TOKEN,
    accountId: MATRIX_OPS_ACCOUNT_ID,
  });
  return { rootDir, stateDir };
}

async function expectPreparedOpsLegacyMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  rootDir: string;
  inspectLegacyStore: {
    deviceId: string;
    roomKeyCounts: { total: number; backedUp: number };
    backupVersion: string;
    decryptionKeyBase64: string;
  };
  expectAccountId?: boolean;
}) {
  const detection = detectLegacyMatrixCrypto({ cfg: params.cfg, env: params.env });
  expect(detection.warnings).toEqual([]);
  expect(detection.plans).toHaveLength(1);
  expect(detection.plans[0]?.accountId).toBe("ops");

  const result = await autoPrepareLegacyMatrixCrypto({
    cfg: params.cfg,
    env: params.env,
    deps: {
      inspectLegacyStore: async () => params.inspectLegacyStore,
    },
  });

  expect(result.migrated).toBe(true);
  expect(result.warnings).toEqual([]);
  const recovery = JSON.parse(
    fs.readFileSync(path.join(params.rootDir, "recovery-key.json"), "utf8"),
  ) as {
    privateKeyBase64: string;
  };
  expect(recovery.privateKeyBase64).toBe(params.inspectLegacyStore.decryptionKeyBase64);
  if (!params.expectAccountId) {
    return;
  }
  const state = JSON.parse(
    fs.readFileSync(path.join(params.rootDir, "legacy-crypto-migration.json"), "utf8"),
  ) as {
    accountId: string;
  };
  expect(state.accountId).toBe("ops");
}

describe("matrix legacy encrypted-state migration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts a saved backup key into the new recovery-key path", async () => {
    await withTempHome(
      async (home) => {
        writeMatrixPluginFixture(path.join(home, "bundled", "matrix"));
        const { cfg, rootDir } = writeDefaultLegacyCryptoFixture(home);

        const detection = detectLegacyMatrixCrypto({ cfg, env: process.env });
        expect(detection.warnings).toEqual([]);
        expect(detection.plans).toHaveLength(1);

        const inspectLegacyStore = vi.fn(async () => ({
          deviceId: MATRIX_DEFAULT_DEVICE_ID,
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
      const { cfg, rootDir } = writeDefaultLegacyCryptoFixture(home);

      const result = await autoPrepareLegacyMatrixCrypto({
        cfg,
        env: process.env,
        deps: {
          inspectLegacyStore: async () => ({
            deviceId: MATRIX_DEFAULT_DEVICE_ID,
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
      const { cfg, rootDir } = writeDefaultLegacyCryptoFixture(home);

      const result = await autoPrepareLegacyMatrixCrypto({
        cfg,
        env: process.env,
        deps: {
          inspectLegacyStore: async () => ({
            deviceId: MATRIX_DEFAULT_DEVICE_ID,
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
        const cfg: OpenClawConfig = {
          channels: {
            matrix: {
              accounts: {
                ops: {
                  homeserver: MATRIX_TEST_HOMESERVER,
                  userId: MATRIX_OPS_USER_ID,
                },
              },
            },
          },
        };
        const { rootDir } = createOpsLegacyCryptoFixture({
          home,
          cfg,
          includeStoredCredentials: true,
        });

        await expectPreparedOpsLegacyMigration({
          cfg,
          env: process.env,
          rootDir,
          inspectLegacyStore: {
            deviceId: MATRIX_OPS_DEVICE_ID,
            roomKeyCounts: { total: 6, backedUp: 6 },
            backupVersion: "21868",
            decryptionKeyBase64: "YWJjZA==",
          },
          expectAccountId: true,
        });
      },
      { env: matrixHelperEnv },
    );
  });

  it("uses scoped Matrix env vars when resolving flat legacy crypto migration", async () => {
    await withTempHome(
      async (home) => {
        const cfg: OpenClawConfig = {
          channels: {
            matrix: {
              accounts: {
                ops: {},
              },
            },
          },
        };
        const { rootDir } = createOpsLegacyCryptoFixture({
          home,
          cfg,
          accessToken: "tok-ops-env",
        });

        await expectPreparedOpsLegacyMigration({
          cfg,
          env: process.env,
          rootDir,
          inspectLegacyStore: {
            deviceId: MATRIX_OPS_DEVICE_ID,
            roomKeyCounts: { total: 4, backedUp: 4 },
            backupVersion: "9001",
            decryptionKeyBase64: "YWJjZA==",
          },
        });
      },
      {
        env: {
          ...matrixHelperEnv,
          MATRIX_OPS_HOMESERVER: MATRIX_TEST_HOMESERVER,
          MATRIX_OPS_USER_ID,
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
        JSON.stringify({ deviceId: MATRIX_OPS_DEVICE_ID }),
      );

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                homeserver: MATRIX_TEST_HOMESERVER,
                userId: MATRIX_OPS_USER_ID,
                accessToken: MATRIX_OPS_ACCESS_TOKEN,
              },
              alerts: {
                homeserver: MATRIX_TEST_HOMESERVER,
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
          JSON.stringify({ deviceId: MATRIX_DEFAULT_DEVICE_ID }),
        );

        const cfg = createDefaultMatrixConfig();

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
