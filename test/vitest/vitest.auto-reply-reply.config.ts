import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { autoReplyReplySubtreeTestInclude } from "./vitest.test-shards.mjs";

export function createAutoReplyReplyVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig([...autoReplyReplySubtreeTestInclude], {
    dir: "src/auto-reply",
    env,
    fileParallelism: false,
    maxWorkers: 1,
    name: "auto-reply-reply",
    sequence: {
      groupOrder: 1,
    },
  });
}

export default createAutoReplyReplyVitestConfig();
