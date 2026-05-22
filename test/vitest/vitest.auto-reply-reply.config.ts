import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { autoReplyReplySubtreeTestInclude } from "./vitest.test-shards.mjs";

export function createAutoReplyReplyVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig([...autoReplyReplySubtreeTestInclude], {
    dir: "src/auto-reply",
    env,
    name: "auto-reply-reply",
    sequence: {
      groupOrder: 1,
    },
  });
  // This shard uses the non-isolated runner and shared reply dispatch/abort
  // registries. Keep files serialized so ACP abort tests cannot race other
  // dispatch tests that intentionally mutate the same singleton state.
  config.test = {
    ...config.test,
    maxWorkers: 1,
    fileParallelism: false,
    sequence: {
      ...config.test?.sequence,
      groupOrder: 1,
    },
  };
  return config;
}

export default createAutoReplyReplyVitestConfig();
