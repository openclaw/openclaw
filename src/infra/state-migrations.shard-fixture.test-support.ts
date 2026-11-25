import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  autoMigrateLegacyState,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";

export function writeFixtureFile(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function byId<T extends { id: string }>(entries: readonly T[], id: string) {
  return entries.find((entry) => entry.id === id);
}

export function createMigrationFixture(
  root: string,
  options: {
    config?: OpenClawConfig;
    copied?: boolean;
    bundledPluginsDir?: string;
  } = {},
) {
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, options.copied === false ? "state" : "copied-state");
  const configPath = path.join(
    root,
    options.copied === false ? "openclaw.json" : "copied-openclaw.json",
  );
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(options.config ?? {})}\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    ...(options.bundledPluginsDir
      ? {
          OPENCLAW_BUNDLED_PLUGINS_DIR: options.bundledPluginsDir,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        }
      : {}),
  };
  return {
    root,
    homeDir,
    stateDir,
    configPath,
    env,
    plan(overrides: Partial<Parameters<typeof planLegacyStateMigrationsReadOnly>[0]> = {}) {
      return planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: { root, version: "test" },
        snapshot: { homeDir, configPath, stateDir },
        env,
        ...overrides,
      });
    },
    migrate(
      cfg: OpenClawConfig,
      overrides: Partial<Parameters<typeof autoMigrateLegacyState>[0]> = {},
    ) {
      return autoMigrateLegacyState({
        cfg,
        env,
        homedir: () => homeDir,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        ...overrides,
      });
    },
  };
}
