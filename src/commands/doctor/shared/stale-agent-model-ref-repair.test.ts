import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { repairStaleAgentModelRefs } from "./stale-agent-model-ref-repair.js";

describe("repairStaleAgentModelRefs catalog reading", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("repairs stale refs while preserving providers and comments in the agent catalog", () => {
    const stateDir = tempDirs.make("openclaw-doctor-model-catalog-");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const modelsPath = path.join(agentDir, "models.json");
    const catalog = `{
  // This catalog is author-owned.
  "providers": {
    "agent-local": {
      "baseUrl": "http://127.0.0.1:9/v1",
      "api": "openai-completions",
      "models": [{ "id": "kept", "name": "Kept" }],
    },
  },
}
`;
    fs.writeFileSync(modelsPath, catalog);

    const result = repairStaleAgentModelRefs(
      {
        agents: {
          defaults: {
            model: {
              primary: "deleted/primary",
              fallbacks: ["agent-local/kept", "deleted/fallback"],
            },
          },
          entries: { main: {} },
        },
      },
      { env: { OPENCLAW_STATE_DIR: stateDir } },
    );

    expect(result.warnings).toEqual([]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      fallbacks: ["agent-local/kept"],
    });
    expect(fs.readFileSync(modelsPath, "utf8")).toBe(catalog);
  });
});
