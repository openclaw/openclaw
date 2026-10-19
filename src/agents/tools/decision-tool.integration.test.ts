import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DecisionBatchV2, ProviderDecisionOutcomeV2 } from "../../decisions/types-v2.js";
import type { DecisionBatch } from "../../decisions/types.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveAgentDir } from "../agent-scope.js";
import { acquireReadOnlyPreparedModelRuntime } from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { DecisionEvaluateInput, DecisionEvaluateOutput } from "./decision-tool-contract.js";
import { createDecisionTool } from "./decision-tool.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.decision-tool-native");
type Trace = {
  calls: number;
  authenticated: boolean;
  batch?: DecisionBatchV2;
  outcome: ProviderDecisionOutcomeV2;
};
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  resetDiagnosticEventsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
});

it("returns rich native outcomes through the core tool, registered host and real preparation", async () => {
  const events: DiagnosticEventPayload[] = [];
  onTestFinished(
    onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event) => {
        if (event.type === "model.usage") {
          events.push(event);
        }
      }),
    ),
  );
  const root = roots.make("decision-tool-native-");
  const pluginRoot = path.join(root, "plugin");
  const emptyBundled = path.join(root, "bundled");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(emptyBundled);
  const id = "decision-tool-fixture";
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: id,
    providerId: id,
    manifest: {
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
      contracts: { decisionProviders: [id] },
      modelCatalog: {
        providers: {
          [id]: {
            authScope: "plugin",
            models: [
              {
                id: "native",
                name: "Native fixture",
                inference: {
                  chat: false,
                  decision: {
                    protocol: "fixture",
                    input: ["text", "image"],
                    questions: {
                      boolean: { probabilities: "none", abstention: true },
                      choice: { probabilities: "none", abstention: true },
                      score: { probabilities: "none", abstention: false },
                      box: { probabilities: "none", abstention: false },
                    },
                    limits: {
                      maxQuestions: 8,
                      image: {
                        maxBytes: 4194304,
                        mimeTypes: ["image/png", "image/jpeg"],
                        remoteUrls: false,
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    [
      'const trace=globalThis[Symbol.for("openclaw.test.decision-tool-native")];',
      `module.exports={id:${JSON.stringify(id)},register(api){`,
      `api.registerDecisionProvider({id:${JSON.stringify(id)},contractVersion:2,`,
      'provider:{label:"Synthetic",auth:[],authScope:"plugin",resolveSyntheticAuth(){return {apiKey:"synthetic-private-auth",mode:"api-key",source:"fixture"};}},',
      'async evaluate(batch,context){trace.calls++;trace.batch=batch;trace.authenticated=context.auth.apiKey==="synthetic-private-auth";return trace.outcome;}});}};',
    ].join("\n"),
  );
  const trace: Trace = {
    calls: 0,
    authenticated: false,
    outcome: {
      status: "ok",
      result: {
        model: "native-reported",
        answers: {
          explicit: { type: "boolean", answer: true, metadata: { evidence: "fixture" } },
          abstained: { type: "choice", choice: null, confidence: null },
          fractional: { type: "score", score: 1.25 },
          failed: { type: "error", code: "provider-error", providerCode: "fixture-rejected" },
        },
        usage: {
          inputTokens: 12,
          costUsd: 0,
          units: { unit: "decision-units", amount: 2 },
          raw: { nativeUnits: 2 },
        },
        metadata: { providerRequestId: "fixture-request", latencyMs: 3 },
      },
    },
  };
  Reflect.set(globalThis, traceKey, trace);
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: "unrelated/not-configured",
        decisionModel: `${id}/native`,
        workspace: path.join(root, "workspace"),
      },
    },
    plugins: {
      load: { paths: [pluginRoot] },
      slots: { memory: "none" },
      entries: { [id]: { enabled: true } },
    },
  };
  await withEnvAsync(
    {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    },
    async () => {
      setRuntimeConfigSnapshot(cfg);
      const registry = await loadAndActivateRootPluginRegistry({
        config: cfg,
        workspaceDir: path.join(root, "workspace"),
      });
      expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
      expect(registry.decisionProviders).toHaveLength(1);
      await using prepared = await acquireReadOnlyPreparedModelRuntime({
        agentId: "main",
        agentDir: resolveAgentDir(cfg, "main"),
        workspaceDir: path.join(root, "workspace"),
        config: cfg,
      });
      const tool = createDecisionTool("main", {
        config: cfg,
        preparedModelRuntime: prepared.snapshot,
      });
      expect(tool).not.toBeNull();
      const batch: DecisionBatch = {
        state: { message: "synthetic evidence" },
        questions: {
          explicit: { type: "boolean" },
          abstained: { type: "choice", criteria: { a: "A", b: "B" } },
          fractional: { type: "score", criteria: ["Low", "Medium", "High"] },
          failed: { type: "boolean" },
        },
      };
      const result = await tool!.execute("native", batch);
      expect(events).toEqual([
        expect.objectContaining({
          type: "model.usage",
          provider: id,
          model: "native",
          agentId: "main",
          usage: { input: 12 },
          costUsd: 0,
        }),
      ]);
      expect(trace.authenticated).toBe(true);
      expect(trace.calls).toBe(1);
      expect(trace.batch).toEqual({
        state: { type: "json", value: batch.state },
        questions: batch.questions,
      });
      expect(result.details).toEqual({
        ...trace.outcome,
        provenance: {
          providerId: id,
          rubricVersion: expect.stringMatching(/^decision-v1-[0-9a-f]{24}$/),
          runtimeGeneration: expect.any(String),
        },
      });
      expect(Value.Check(DecisionEvaluateOutput, result.details)).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
      expect(JSON.stringify(result)).not.toContain("synthetic-private-auth");
      expect(JSON.stringify(result)).not.toContain("authScope");

      // Malformed rich answers still fail at the host; tool projection never bypasses validation.
      trace.outcome = {
        status: "ok",
        result: { model: "native", answers: {}, usage: { costUsd: 0 } },
      };
      await expect(tool!.execute("invalid-native", batch)).resolves.toMatchObject({
        details: { status: "unavailable", reason: "invalid-response" },
      });
      expect(trace.calls).toBe(2);
      for (const type of ["sort", "tags"]) {
        await expect(
          tool!.execute("unsupported-kind", {
            state: "synthetic evidence",
            questions: { q: { type, criteria: { a: "A", b: "B" } } },
          }),
        ).rejects.toThrow("no evidence was sent");
      }
      expect(trace.calls).toBe(2);
      const imageBatch: DecisionBatchV2 = {
        state: { type: "image", dataUri: "data:image/png;base64,AA==", text: "Synthetic square" },
        questions: { target: { type: "box", instructions: "the square" } },
      };
      const nativeInput = { contractVersion: 2, ...imageBatch };
      trace.outcome = {
        status: "ok",
        result: {
          model: "native",
          answers: { target: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 } } },
        },
      };
      expect(Value.Check(DecisionEvaluateInput, nativeInput)).toBe(true);
      expect(tool!.description).toContain("box");
      expect(tool!.description).toContain("Supported input modalities: text, image.");
      expect(tool!.description).toContain("4194304 decoded bytes in image/png, image/jpeg");
      const nullBox = {
        ...nativeInput,
        questions: { target: { type: "box", instructions: null } },
      };
      expect(Value.Check(DecisionEvaluateInput, nullBox)).toBe(false);
      await expect(tool!.execute("null-box", nullBox)).rejects.toThrow("no evidence was sent");
      expect(trace.calls).toBe(2);
      const imageResult = await tool!.execute("native-image", nativeInput);
      expect(imageResult.details).toMatchObject(trace.outcome);
      expect(Value.Check(DecisionEvaluateOutput, imageResult.details)).toBe(true);
      expect(trace.batch).toEqual(imageBatch);
      expect(trace.calls).toBe(3);
      expect(events).toHaveLength(1);
    },
  );
});
