// Vitest channels config wires the channels test shard.
import { coreChannelTestInclude } from "./vitest.channel-paths.mjs";
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createChannelsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(coreChannelTestInclude, {
    env,
    exclude: [
      "src/gateway/**",
      "src/channels/plugins/contracts/**",
      ...databaseWorkerCoreTestFiles,
    ],
    name: "channels",
    passWithNoTests: true,
  });
}

export default createChannelsVitestConfig();
