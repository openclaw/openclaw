import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerPluginCliCommandsFromValidatedConfig } from "./cli.js";
import { makePluginLoaderTempDir } from "./loader.test-fixtures.js";

export const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value));

export const cliEnv = (root: string) => ({
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});

export function createCliFixture(homeKey: "HOME" | "OPENCLAW_HOME" = "HOME") {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const env = { ...cliEnv(root), [homeKey]: root };
  return { root, configPath: env.OPENCLAW_CONFIG_PATH, env };
}

export const stringConfigSchema = (field: string, extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties: { [field]: { type: "string" } },
  ...extra,
});

export function pluginConfig(
  plugin: { id: string; dir: string },
  entry: { enabled?: boolean; config?: Record<string, unknown> },
): OpenClawConfig {
  return {
    plugins: { load: { paths: [plugin.dir] }, allow: [plugin.id], entries: { [plugin.id]: entry } },
  };
}

export function patchManifest(dir: string, fields: Record<string, unknown>) {
  const file = path.join(dir, "openclaw.plugin.json");
  writeJson(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), ...fields });
}

export function registerCli(
  program: Parameters<typeof registerPluginCliCommandsFromValidatedConfig>[0],
  {
    env,
    ...options
  }: NonNullable<Parameters<typeof registerPluginCliCommandsFromValidatedConfig>[3]> & {
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return registerPluginCliCommandsFromValidatedConfig(program, env, undefined, options);
}
