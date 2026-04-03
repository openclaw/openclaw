import fs from "node:fs";
import path from "node:path";

export const MATRIX_TEST_HOMESERVER = "https://matrix.example.org";
export const MATRIX_DEFAULT_USER_ID = "@bot:example.org";
export const MATRIX_DEFAULT_ACCESS_TOKEN = "tok-123";
export const MATRIX_DEFAULT_DEVICE_ID = "DEVICE123";
export const MATRIX_OPS_ACCOUNT_ID = "ops";
export const MATRIX_OPS_USER_ID = "@ops-bot:example.org";
export const MATRIX_OPS_ACCESS_TOKEN = "tok-ops";
export const MATRIX_OPS_DEVICE_ID = "DEVICEOPS";

export const matrixHelperEnv = {
  OPENCLAW_BUNDLED_PLUGINS_DIR: (home: string) => path.join(home, "bundled"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
  OPENCLAW_VERSION: undefined,
  VITEST: "true",
} as const;

export function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

export function writeMatrixPluginManifest(rootDir: string): void {
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
}

export function writeMatrixPluginFixture(rootDir: string, helperBody?: string): void {
  writeMatrixPluginManifest(rootDir);
  fs.writeFileSync(
    path.join(rootDir, "legacy-crypto-inspector.js"),
    helperBody ??
      [
        "export async function inspectLegacyMatrixCryptoStore() {",
        '  return { deviceId: "FIXTURE", roomKeyCounts: { total: 1, backedUp: 1 }, backupVersion: "1", decryptionKeyBase64: null };',
        "}",
      ].join("\n"),
    "utf8",
  );
}

export function writeMatrixCredentials(
  stateDir: string,
  params?: {
    accountId?: string;
    homeserver?: string;
    userId?: string;
    accessToken?: string;
    deviceId?: string;
  },
) {
  const accountId = params?.accountId ?? MATRIX_OPS_ACCOUNT_ID;
  writeFile(
    path.join(stateDir, "credentials", "matrix", `credentials-${accountId}.json`),
    JSON.stringify(
      {
        homeserver: params?.homeserver ?? MATRIX_TEST_HOMESERVER,
        userId: params?.userId ?? MATRIX_OPS_USER_ID,
        accessToken: params?.accessToken ?? MATRIX_OPS_ACCESS_TOKEN,
        deviceId: params?.deviceId ?? MATRIX_OPS_DEVICE_ID,
      },
      null,
      2,
    ),
  );
}
