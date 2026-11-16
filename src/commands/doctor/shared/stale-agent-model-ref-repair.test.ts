import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { repairStaleAgentModelRefs } from "./stale-agent-model-ref-repair.js";

describe("repairStaleAgentModelRefs catalog reading", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([true, false])(
    "respects CLI runtime availability in replace mode (enabled=%s)",
    (enabled) => {
      const cli = { agentRuntime: { id: "claude-cli" } };
      const result = repairStaleAgentModelRefs(
        {
          models: {
            mode: "replace",
            providers: {
              custom: { baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "kept", name: "Kept" }] },
            },
          },
          plugins: { entries: { anthropic: { enabled } } },
          agents: {
            defaults: {
              model: {
                primary: "custom/kept",
                fallbacks: [
                  "anthropic/claude-sonnet-5-5",
                  "anthropic/claude-sonnet-5-5@work",
                  "anthropic/worker-only",
                  "deleted/model",
                ],
              },
              models: {
                "custom/kept": {},
                "anthropic/claude-sonnet-5-5": cli,
                "anthropic/api": {},
              },
            },
            entries: {
              worker: {
                model: {
                  primary: "anthropic/claude-haiku-4-5",
                  fallbacks: [
                    "anthropic/claude-sonnet-5-5",
                    "anthropic/claude-sonnet-5-5@work",
                    "anthropic/worker-only",
                    "deleted/model",
                  ],
                },
                models: { "anthropic/*": cli, "anthropic/claude-haiku-4-5": cli },
              },
            },
          },
        },
        { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-cli-pins-") } },
      );

      expect(result.warnings).toEqual([]);
      expect(result.config.agents?.defaults?.model).toEqual({
        primary: "custom/kept",
        fallbacks: enabled
          ? ["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5@work"]
          : [],
      });
      expect(result.config.agents?.defaults?.models).toEqual({
        "custom/kept": {},
        ...(enabled ? { "anthropic/claude-sonnet-5-5": cli } : {}),
      });
      expect(result.config.agents?.entries?.worker?.model).toEqual({
        ...(enabled ? { primary: "anthropic/claude-haiku-4-5" } : {}),
        fallbacks: enabled
          ? [
              "anthropic/claude-sonnet-5-5",
              "anthropic/claude-sonnet-5-5@work",
              "anthropic/worker-only",
            ]
          : [],
      });
      expect(result.config.agents?.entries?.worker?.models).toEqual(
        enabled ? { "anthropic/*": cli, "anthropic/claude-haiku-4-5": cli } : { "custom/kept": {} },
      );
    },
  );

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
