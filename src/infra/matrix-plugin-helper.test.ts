import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  isMatrixLegacyCryptoInspectorAvailable,
  loadMatrixLegacyCryptoInspector,
} from "./matrix-plugin-helper.js";

function writeMatrixPluginFixture(rootDir: string, helperBody: string): void {
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
  fs.writeFileSync(path.join(rootDir, "legacy-crypto-inspector.js"), helperBody, "utf8");
}

function writeMatrixPluginManifest(rootDir: string): void {
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

describe("matrix plugin helper resolution", () => {
  it("loads the legacy crypto inspector from the bundled matrix plugin", async () => {
    await withTempHome(
      async (home) => {
        const bundledRoot = path.join(home, "bundled", "matrix");
        writeMatrixPluginFixture(
          bundledRoot,
          [
            "export async function inspectLegacyMatrixCryptoStore() {",
            '  return { deviceId: "BUNDLED", roomKeyCounts: { total: 7, backedUp: 6 }, backupVersion: "1", decryptionKeyBase64: "YWJjZA==" };',
            "}",
          ].join("\n"),
        );

        const cfg = {} as const;

        expect(isMatrixLegacyCryptoInspectorAvailable({ cfg, env: process.env })).toBe(true);
        const inspectLegacyStore = await loadMatrixLegacyCryptoInspector({
          cfg,
          env: process.env,
        });

        await expect(
          inspectLegacyStore({
            cryptoRootDir: "/tmp/legacy",
            userId: "@bot:example.org",
            deviceId: "DEVICE123",
          }),
        ).resolves.toEqual({
          deviceId: "BUNDLED",
          roomKeyCounts: { total: 7, backedUp: 6 },
          backupVersion: "1",
          decryptionKeyBase64: "YWJjZA==",
        });
      },
      {
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: (home) => path.join(home, "bundled"),
        },
      },
    );
  });

  it("prefers configured plugin load paths over bundled matrix plugins", async () => {
    await withTempHome(
      async (home) => {
        const bundledRoot = path.join(home, "bundled", "matrix");
        const customRoot = path.join(home, "plugins", "matrix-local");
        writeMatrixPluginFixture(
          bundledRoot,
          [
            "export async function inspectLegacyMatrixCryptoStore() {",
            '  return { deviceId: "BUNDLED", roomKeyCounts: null, backupVersion: null, decryptionKeyBase64: null };',
            "}",
          ].join("\n"),
        );
        writeMatrixPluginFixture(
          customRoot,
          [
            "export default async function inspectLegacyMatrixCryptoStore() {",
            '  return { deviceId: "CONFIG", roomKeyCounts: null, backupVersion: null, decryptionKeyBase64: null };',
            "}",
          ].join("\n"),
        );

        const cfg: OpenClawConfig = {
          plugins: {
            load: {
              paths: [customRoot],
            },
          },
        };

        expect(isMatrixLegacyCryptoInspectorAvailable({ cfg, env: process.env })).toBe(true);
        const inspectLegacyStore = await loadMatrixLegacyCryptoInspector({
          cfg,
          env: process.env,
        });

        await expect(
          inspectLegacyStore({
            cryptoRootDir: "/tmp/legacy",
            userId: "@bot:example.org",
            deviceId: "DEVICE123",
          }),
        ).resolves.toEqual({
          deviceId: "CONFIG",
          roomKeyCounts: null,
          backupVersion: null,
          decryptionKeyBase64: null,
        });
      },
      {
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: (home) => path.join(home, "bundled"),
        },
      },
    );
  });

  it("keeps source-style root helper shims on the Jiti fallback path", async () => {
    await withTempHome(
      async (home) => {
        const customRoot = path.join(home, "plugins", "matrix-local");
        writeMatrixPluginManifest(customRoot);
        fs.mkdirSync(path.join(customRoot, "src", "matrix"), { recursive: true });
        fs.writeFileSync(
          path.join(customRoot, "legacy-crypto-inspector.js"),
          'export { inspectLegacyMatrixCryptoStore } from "./src/matrix/legacy-crypto-inspector.js";\n',
          "utf8",
        );
        fs.writeFileSync(
          path.join(customRoot, "src", "matrix", "legacy-crypto-inspector.ts"),
          [
            "export async function inspectLegacyMatrixCryptoStore() {",
            '  return { deviceId: "SRCJS", roomKeyCounts: null, backupVersion: null, decryptionKeyBase64: null };',
            "}",
          ].join("\n"),
          "utf8",
        );

        const cfg: OpenClawConfig = {
          plugins: {
            load: {
              paths: [customRoot],
            },
          },
        };

        expect(isMatrixLegacyCryptoInspectorAvailable({ cfg, env: process.env })).toBe(true);
        const inspectLegacyStore = await loadMatrixLegacyCryptoInspector({
          cfg,
          env: process.env,
        });

        await expect(
          inspectLegacyStore({
            cryptoRootDir: "/tmp/legacy",
            userId: "@bot:example.org",
            deviceId: "DEVICE123",
          }),
        ).resolves.toEqual({
          deviceId: "SRCJS",
          roomKeyCounts: null,
          backupVersion: null,
          decryptionKeyBase64: null,
        });
      },
      {
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: (home) => path.join(home, "empty-bundled"),
        },
      },
    );
  });

  it("rejects helper files that escape the plugin root", async () => {
    await withTempHome(
      async (home) => {
        const customRoot = path.join(home, "plugins", "matrix-local");
        const outsideRoot = path.join(home, "outside");
        fs.mkdirSync(customRoot, { recursive: true });
        fs.mkdirSync(outsideRoot, { recursive: true });
        fs.writeFileSync(
          path.join(customRoot, "openclaw.plugin.json"),
          JSON.stringify({
            id: "matrix",
            configSchema: {
              type: "object",
              additionalProperties: false,
            },
          }),
          "utf8",
        );
        fs.writeFileSync(path.join(customRoot, "index.js"), "export default {};\n", "utf8");
        const outsideHelper = path.join(outsideRoot, "legacy-crypto-inspector.js");
        fs.writeFileSync(
          outsideHelper,
          'export default async function inspectLegacyMatrixCryptoStore() { return { deviceId: "ESCAPE", roomKeyCounts: null, backupVersion: null, decryptionKeyBase64: null }; }\n',
          "utf8",
        );

        try {
          fs.symlinkSync(
            outsideHelper,
            path.join(customRoot, "legacy-crypto-inspector.js"),
            process.platform === "win32" ? "file" : undefined,
          );
        } catch {
          return;
        }

        const cfg: OpenClawConfig = {
          plugins: {
            load: {
              paths: [customRoot],
            },
          },
        };

        expect(isMatrixLegacyCryptoInspectorAvailable({ cfg, env: process.env })).toBe(false);
        await expect(
          loadMatrixLegacyCryptoInspector({
            cfg,
            env: process.env,
          }),
        ).rejects.toThrow("Matrix plugin helper path is unsafe");
      },
      {
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: (home) => path.join(home, "empty-bundled"),
        },
      },
    );
  });
});
