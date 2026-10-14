import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDecisionTool } from "../agents/tools/decision-tool.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "../plugins/loader.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { prepareDecisionProviderReload } from "./runtime.js";
import type { DecisionBatch, DecisionOutcome } from "./types.js";

const enabled =
  process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.OPENAI_API_KEY?.trim());
const describeLive = enabled ? describe : describe.skip;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Unlike adapter mocks, this covers discovery, registration, tool dispatch, scoped auth,
// guarded HTTPS, wire translation, and host result validation with two bounded requests.
describeLive("OpenAI Decisions registered live flow", () => {
  it("evaluates outage and routine billing evidence through decision_evaluate", async () => {
    const workspaceDir = tempDirs.make("openclaw-decisions-live-");
    const config: OpenClawConfig = {
      agents: {
        defaults: { workspace: workspaceDir, decisionModel: "openai/gpt-6-luna" },
        entries: { main: {} },
      },
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } } },
      plugins: { allow: ["openai"], slots: { memory: "none" } },
    };
    setRuntimeConfigSnapshot(config);
    const registry = loadOpenClawPlugins({
      config,
      workspaceDir,
      onlyPluginIds: ["openai"],
      pluginSdkResolution: "src",
      preferBuiltPluginArtifacts: false,
      cache: false,
      env: {
        ...process.env,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      },
    });
    try {
      expect(registry.decisionProviders.some((entry) => entry.host.provider.id === "openai")).toBe(
        true,
      );
      const tool = createDecisionTool("main", { config });
      if (!tool) {
        throw new Error("Configured decision_evaluate tool was not created");
      }
      const cases = [
        {
          message:
            "Checkout is down for every customer. No payments can complete. Incident response is needed immediately.",
          route: "technical",
          incident: true,
        },
        {
          message:
            "Please email me a copy of last month's invoice. Everything is working normally and this can wait until next week.",
          route: "billing",
          incident: false,
        },
      ];
      for (const scenario of cases) {
        const batch: DecisionBatch = {
          state: { message: scenario.message },
          questions: {
            incident: {
              type: "boolean",
              instructions: "Does this need incident response?",
              criteria: { true: { includes: ["Widespread outage"] }, false: "Routine request" },
            },
            route: {
              type: "choice",
              instructions: "Which team should handle this?",
              criteria: {
                technical: "Service failures and outages",
                billing: ["Invoices", "Refunds"],
              },
            },
            urgency: {
              type: "score",
              instructions: "Rate operational impact.",
              criteria: ["No disruption", "One workflow blocked", "Widespread outage"],
            },
          },
        };
        const reply = await tool.execute("live-decision", batch);
        const outcome = reply.details as DecisionOutcome;
        expect(outcome.status).toBe("ok");
        if (outcome.status !== "ok") {
          throw new Error("Decision unavailable: " + outcome.reason);
        }
        const { answers, usage, model } = outcome.result;
        expect(model).toBe("gpt-6-luna");
        expect(outcome.provenance.providerId).toBe("openai");
        expect(answers.route).toMatchObject({ type: "choice", choice: scenario.route });
        const incident = answers.incident;
        const urgency = answers.urgency;
        if (incident?.type !== "boolean" || urgency?.type !== "score") {
          throw new Error("Decision result is missing its Boolean or Score answer");
        }
        expect(incident.probabilityTrue > 0.5).toBe(scenario.incident);
        expect(urgency.score > 1).toBe(scenario.incident);
        expect(urgency.probabilities).toHaveLength(3);
        expect(usage?.inputTokens).toBeGreaterThan(0);
        expect(usage?.outputTokens).toBe(0);
        // Synthetic evidence only; never print credentials or provider request headers.
        console.log(JSON.stringify({ scenario: scenario.route, model, answers, usage }));
      }
    } finally {
      prepareDecisionProviderReload(registry, new Set(["openai"]));
      for (const record of registry.plugins) {
        await getPluginInstance(record)?.dispose();
      }
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();
      clearPluginRegistryLoadCache();
    }
  }, 90_000);
});
