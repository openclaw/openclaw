import fs from "node:fs/promises";
import { vi } from "vitest";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../../plugins/installed-plugin-index-records.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext } from "./types.js";

export async function coldPlugin(
  state: OpenClawTestState,
  pluginId: string,
  contracts?: { tools: string[] },
) {
  const rootDir = state.path("plugin");
  await fs.mkdir(rootDir);
  createColdPluginFixture({
    rootDir,
    pluginId,
    manifest: {
      providers: [],
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
      ...(contracts ? { contracts } : {}),
    },
  });
  return { rootDir, plugins: { allow: [pluginId], load: { paths: [rootDir] } } };
}

export async function readPluginState(state: OpenClawTestState, ...extraPaths: string[]) {
  return {
    files: await Promise.all(
      [state.configPath, ...extraPaths].map((file) => fs.readFile(file, "utf8")),
    ),
    records: await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
  };
}

export function pluginRequest(
  method: string,
  params: Record<string, unknown>,
  context: GatewayRequestContext,
) {
  return {
    req: { type: "req" as const, id: "plugin-test", method, params },
    params,
    context,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
  };
}
