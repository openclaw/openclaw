import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MODELS_JSON_STATE } from "../agents/models-config-state.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveModelCostConfig } from "./usage-format.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("usage-format agent roster", () => {
  afterEach(() => {
    MODELS_JSON_STATE.costCache.clear();
  });

  it("uses the sole agent directory from a canonical roster", async () => {
    const opsAgentDir = path.join(tempDirs.make("openclaw-usage-roster-"), "custom-ops-agent");
    await fs.mkdir(opsAgentDir, { recursive: true });
    await fs.writeFile(
      path.join(opsAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          "demo-roster": {
            models: [
              {
                id: "demo-model",
                cost: { input: 42, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const config = {
      agents: {
        entries: { ops: { agentDir: opsAgentDir } },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-roster",
        model: "demo-model",
        config,
      })?.input,
    ).toBe(42);
  });
});
