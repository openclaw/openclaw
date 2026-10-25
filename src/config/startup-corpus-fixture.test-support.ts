import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyLegacyCompatibilityStep } from "../commands/doctor/shared/config-flow-steps.js";
import { normalizeCompatibilityConfigValues } from "../commands/doctor/shared/legacy-config-core-migrate.js";
import { loadGatewayStartupConfigSnapshot } from "../gateway/server-startup-config-helpers.js";
import { resolveBundledDirFromPackageRoot } from "../plugins/bundled-dir.js";
import { readConfigCorpusFixture } from "./config-corpus.test-support.js";
import type { createConfigIO } from "./io.js";
import type { ConfigFileSnapshot } from "./types.js";

const bundledPluginsDir = resolveBundledDirFromPackageRoot(
  fileURLToPath(new URL("../../", import.meta.url)),
);
if (!bundledPluginsDir) {
  throw new Error("Missing bundled plugin fixtures for startup corpus");
}

export function corpusEnv(home: string, configPath: string) {
  return {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_TEST_HOME: home,
    OPENCLAW_STATE_DIR: path.dirname(configPath),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
  };
}

export async function readCorpusStartup(io: ReturnType<typeof createConfigIO>) {
  return loadGatewayStartupConfigSnapshot({
    initialSnapshotRead: await io.readConfigFileSnapshotWithPluginMetadata(),
    minimalTestGateway: false,
    ambientEnvTriggers: "suppress",
    log: console,
  });
}

export function prepareConfigCorpus(home: string, configPath: string, configName: string) {
  const pluginDir = path.join(home, "external-plugin");
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture-extension",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: { apiKey: { type: "string" } },
      },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.ts"),
    'export default { id: "fixture-extension", register() {} };\n',
  );
  const config: unknown = JSON.parse(readConfigCorpusFixture(configName), (_key, value: unknown) =>
    typeof value === "string" && value.startsWith("/home/fixture/")
      ? path.join(home, value.slice("/home/fixture/".length))
      : value,
  );
  fs.writeFileSync(configPath, JSON.stringify(config));
}

export function migrateConfigCorpus(snapshot: ConfigFileSnapshot) {
  const migrated = applyLegacyCompatibilityStep({
    snapshot,
    state: {
      cfg: snapshot.sourceConfig,
      candidate: snapshot.sourceConfig,
      pendingChanges: false,
      fixHints: [],
    },
    shouldRepair: true,
    doctorFixCommand: "openclaw doctor --fix",
  });
  const normalized = normalizeCompatibilityConfigValues(migrated.state.candidate, {
    sourceRaw: snapshot.parsed,
  });
  return { migrated, normalized };
}
