// Runtime plugin health tests cover state shared across runtime processes.
import { describe, expect, it } from "vitest";
import { recordPersistedContextEngineQuarantine } from "../context-engine/quarantine-health.js";
import { clearContextEngineRuntimeQuarantine } from "../context-engine/registry.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { collectRuntimePluginHealthSnapshot } from "./status-plugin-health.runtime.js";

describe("runtime plugin health snapshot", () => {
  it("includes persisted context-engine quarantines", async () => {
    await withStateDirEnv("openclaw-status-plugin-health-", async () => {
      clearContextEngineRuntimeQuarantine();
      recordPersistedContextEngineQuarantine({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "intentional bootstrap failure",
        failedAt: new Date(123),
      });

      expect(collectRuntimePluginHealthSnapshot().contextEngineQuarantines).toEqual([
        {
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "intentional bootstrap failure",
          failedAt: new Date(123),
        },
      ]);
    });
  });
});
