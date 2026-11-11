import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderSolidColorPngBase64 } from "../../test/helpers/live-image-probe.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { createDecisionTool } from "../agents/tools/decision-tool.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createImageProcessor } from "../media/image-processor.js";
import {
  clearPluginRegistryLoadCache,
  loadAndActivateRootPluginRegistry,
} from "../plugins/loader.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DecisionOutcome, DecisionOutcomeV2 } from "./host-outcomes.js";
import { prepareDecisionProviderReload } from "./provider-reload.js";
import type { DecisionBatchV2 } from "./types-v2.js";
import type { DecisionBatch } from "./types.js";

const enabled =
  process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.OPENAI_API_KEY?.trim());
const describeLive = enabled ? describe : describe.skip;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Unlike adapter mocks, this covers discovery, registration, tool dispatch, scoped auth,
// guarded HTTPS, wire translation, and host validation. Only the injected Platform
// key is eligible: no desktop subscription/profile discovery or endpoint override.
describeLive("OpenAI Decisions registered live flow", () => {
  it("evaluates text and each advertised image MIME through decision_evaluate", async () => {
    const state = await createOpenClawTestState({ applyEnv: false });
    const workspaceDir = tempDirs.make("openclaw-decisions-live-");
    const config: OpenClawConfig = {
      agents: {
        defaults: { workspace: workspaceDir, decisionModel: "openai/gpt-6-luna" },
        entries: { main: {} },
      },
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } } },
      plugins: { allow: ["openai"], slots: { memory: "none" } },
    };
    const env = {
      ...state.envVars,
      OPENAI_BASE_URL: undefined,
      CODEX_HOME: path.join(state.root, "empty-codex"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      all_proxy: undefined,
    };
    try {
      await withEnvAsync(env, async () => {
        setRuntimeConfigSnapshot(config);
        const registry = await loadAndActivateRootPluginRegistry({
          config,
          workspaceDir,
          onlyPluginIds: ["openai"],
          pluginSdkResolution: "src",
          preferBuiltPluginArtifacts: false,
          cache: false,
          env: {
            ...process.env,
            ...env,
          },
        });
        try {
          await using prepared = await acquireAgentRunPreparedModelRuntime(
            {
              config,
              agentId: "main",
              agentDir: resolveAgentDir(config, "main"),
              workspaceDir,
              loadRuntimePlugins: true,
              runtimePluginSelections: [
                { provider: "openai", modelId: "gpt-6-luna", agentId: "main" },
              ],
            },
            { catalogMode: "static" },
          );
          expect(
            prepared.snapshot.modelCatalog.entries.some(
              (row) => row.provider === "openai" && row.id === "gpt-6-luna",
            ),
          ).toBe(true);
          expect(
            registry.decisionProviders.some((entry) => entry.host.provider.id === "openai"),
          ).toBe(true);
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
          const png = Buffer.from(renderSolidColorPngBase64({ r: 255, g: 0, b: 0 }), "base64");
          for (const format of ["png", "jpeg", "webp"] as const) {
            const image = await createImageProcessor().encode(png, { format });
            const batch: DecisionBatchV2 = {
              state: {
                type: "image",
                dataUri: `data:${image.mimeType};base64,${image.data.toString("base64")}`,
                text: "Inspect the image.",
              },
              questions: {
                red: { type: "boolean", instructions: "Is this image predominantly red?" },
                color: {
                  type: "choice",
                  instructions: "Choose the dominant color.",
                  criteria: { red: "Red", blue: "Blue", green: "Green" },
                },
                intensity: {
                  type: "score",
                  instructions: "Rate how much of the image is red.",
                  criteria: ["None", "About half", "Nearly all"],
                },
              },
            };
            const reply = await tool.execute("live-decision-image", {
              contractVersion: 2,
              ...batch,
            });
            const outcome = reply.details as DecisionOutcomeV2;
            expect(outcome.status).toBe("ok");
            if (outcome.status !== "ok") {
              throw new Error("Image Decision unavailable: " + outcome.reason);
            }
            const { answers, usage, model } = outcome.result;
            expect(outcome.provenance.providerId).toBe("openai");
            expect(model).toBe("gpt-6-luna");
            expect(answers.color).toMatchObject({ type: "choice", choice: "red" });
            const red = answers.red;
            const intensity = answers.intensity;
            if (red?.type !== "boolean" || intensity?.type !== "score") {
              throw new Error("Image Decision is missing its Boolean or Score answer");
            }
            expect(red.probabilityTrue).toBeGreaterThan(0.5);
            expect(intensity.score).toBeGreaterThan(1);
            expect(usage?.inputTokens).toBeGreaterThan(0);
            expect(usage?.outputTokens).toBe(0);
            console.log(JSON.stringify({ scenario: image.mimeType, model, answers, usage }));
          }
        } finally {
          await resetPreparedModelRuntimeSnapshotsForTest();
          prepareDecisionProviderReload(registry, new Set(["openai"]));
          for (const record of registry.plugins) {
            await getPluginInstance(record)?.dispose();
          }
        }
      });
    } finally {
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();
      clearPluginRegistryLoadCache();
      await state.cleanup();
    }
  }, 180_000);
});
