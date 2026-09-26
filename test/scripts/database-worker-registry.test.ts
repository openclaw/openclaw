import { describe, expect, it } from "vitest";
import {
  databaseWorkerCoreTestFiles,
  isDatabaseWorkerCoreTestFile,
} from "../vitest/vitest.database-worker-core-paths.mjs";

describe("database-worker test routing registry", () => {
  it("contains no duplicate file routes", () => {
    expect(new Set(databaseWorkerCoreTestFiles).size).toBe(databaseWorkerCoreTestFiles.length);
  });

  it.each([
    "src/agents/git-coauthor-attribution.test.ts",
    "src/wizard/setup.inference-recovery.integration.test.ts",
    "src/channels/message-access/discord-native-acp-owner.test.ts",
    "src/auto-reply/reply/commands-acp.owner.test.ts",
    "src/auto-reply/reply/commands-config.owner.test.ts",
    "src/auto-reply/reply/commands-plugins.owner.test.ts",
    "src/auto-reply/reply/commands-session-restart.test.ts",
  ])("keeps %s on the forked database-worker route exactly once", (file) => {
    expect(databaseWorkerCoreTestFiles.filter((entry) => entry === file)).toEqual([file]);
    expect(isDatabaseWorkerCoreTestFile(file)).toBe(true);
  });
});
