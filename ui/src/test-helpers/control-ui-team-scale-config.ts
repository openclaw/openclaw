import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { ConfigSnapshot } from "../api/types.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";

export function withTeamScaleConfig(
  scenario: ControlUiMockGatewayScenario,
): ControlUiMockGatewayScenario {
  const { display, snapshot } = createTeamScaleConfig();
  return {
    ...scenario,
    bootstrapPreferences: {
      profileId:
        scenario.bootstrapPreferences?.profileId ??
        scenario.presenceUsers?.find((user) => user.self)?.id,
      config: display,
      entries:
        scenario.bootstrapPreferences?.entries ??
        asOptionalRecord(asOptionalRecord(scenario.methodResponses?.["users.prefs.get"])?.entries),
    },
    featureMethods: ["config.get", "tts.speak", ...(scenario.featureMethods ?? [])],
    methodResponses: { "config.get": snapshot, ...scenario.methodResponses },
  };
}

/** Synthetic provider inventory keeps config.get at the observed 152–169 KB scale. */
function createTeamScaleConfig() {
  const display = {
    ui: { prefs: {} },
    gateway: { publicOrigin: "https://example.test" },
    messages: { queue: { mode: "steer" as const } },
    tools: { swarm: { enabled: true }, web: { search: { enabled: true } } },
    agents: { entries: {} },
    mcp: { servers: {} },
    tts: { maxTextLength: 4096 },
  };
  const config: OpenClawConfig = {
    ...display,
    models: {
      providers: Object.fromEntries(
        Array.from({ length: 8 }, (_, provider) => [
          `synthetic-provider-${provider}`,
          {
            baseUrl: `https://provider-${provider}.example.test/v1`,
            models: Array.from({ length: 18 }, (_modelValue, model) => ({
              id: `synthetic-model-${provider}-${model}`,
              name: `Synthetic provider ${provider} model ${model}`,
              reasoning: true,
              input: ["text" as const, "image" as const],
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
              contextWindow: 200_000,
              maxTokens: 16_384,
            })),
          },
        ]),
      ),
    },
  };
  const snapshot: ConfigSnapshot = {
    path: "/synthetic/openclaw.json",
    exists: true,
    valid: true,
    raw: JSON.stringify(config),
    config,
    sourceConfig: config,
    resolved: config,
    runtimeConfig: config,
    hash: "synthetic-config-v1",
    configRevisionHash: "synthetic-config-v1",
    appliedConfigHash: "synthetic-config-v1",
    issues: [],
  };
  return { display, snapshot };
}
