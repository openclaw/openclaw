import fs from "node:fs";
import path from "node:path";
import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { Value } from "typebox/value";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { ProviderDecisionOutcomeV2 } from "../../decisions/provider-outcomes.js";
import type { DecisionBatchResultV2, DecisionBatchV2 } from "../../decisions/types-v2.js";
import type { DecisionBatch } from "../../decisions/types.js";
import { setCurrentPluginMetadataSnapshotState } from "../../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  createColdPluginFixture,
  createColdPluginConfig,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveAgentDir } from "../agent-scope.js";
import * as harness from "../decision-inference.test-support.js";
import { createEmptyPreparedModelRuntimeFixture } from "../embedded-agent-runner/model.fixture.test-support.js";
import { acquireReadOnlyPreparedModelRuntime } from "../prepared-model-runtime.js";
import { DecisionEvaluateInput, DecisionEvaluateOutput } from "./decision-tool-schema.js";
import { createDecisionTool } from "./decision-tool.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.decision-tool-native");
type Trace = {
  calls: number;
  authenticated: boolean;
  batch?: DecisionBatchV2;
  outcome: ProviderDecisionOutcomeV2;
};
const nativeOutcome = (result: DecisionBatchResultV2): ProviderDecisionOutcomeV2 => ({
  status: "ok",
  result,
});
afterEach(() => harness.resetDecisionTestRuntime(traceKey));

it("keeps capability guidance bound to catalog order, visibility and prepared precedence", () => {
  const decision: ModelDecisionCapabilities = {
    protocol: "fixture",
    input: ["text"],
    limits: { maxQuestions: 3 },
  };
  const model = {
    id: "native",
    name: "Native",
    provider: "row-provider-must-not-win",
    inference: { decision },
  };
  const later = {
    ...model,
    id: "undeclared",
    inference: {
      decision: {
        ...decision,
        limits: { maxQuestions: 7 },
      },
    },
  };
  const catalog = { models: [model, { id: "undeclared", name: "First match" }, later] };
  const providers = { fixture: catalog };
  Object.setPrototypeOf(providers, { inherited: catalog });
  Object.defineProperty(providers, "hidden", { value: catalog, enumerable: false });
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "first", contracts: { decisionProviders: ["fixture"] }, modelCatalog: { providers } },
      {
        id: "later",
        contracts: { decisionProviders: ["fixture"] },
        modelCatalog: {
          providers: { fixture: { models: [later] } },
        },
      },
    ],
  });
  setCurrentPluginMetadataSnapshotState(snapshot, undefined, undefined, undefined, "gateway");
  for (const [selection, guidance] of [
    ["fixture/native", "at most 3 questions"],
    ["fixture/native@fixture-profile", "at most 3 questions"],
    ["fixture/undeclared", "Provider limits are undeclared"],
    ["inherited/native", "Provider limits are undeclared"],
    ["hidden/native", "Provider limits are undeclared"],
    ["fixture/missing", "Provider limits are undeclared"],
  ]) {
    expect(
      createDecisionTool("main", {
        config: { agents: { defaults: { decisionModel: selection } } },
      })?.description,
    ).toContain(guidance);
  }
  const config = { agents: { defaults: { decisionModel: "fixture/native" } } };
  const prepared = createEmptyPreparedModelRuntimeFixture({
    agentDir: "/tmp/decision-catalog-fixture",
    config,
    metadataSnapshot: snapshot,
    createStores: () => expect.fail("Catalog guidance must not acquire runtime stores"),
  });
  expect(
    createDecisionTool("main", {
      config,
      preparedModelRuntime: {
        ...prepared,
        modelCatalog: {
          ...prepared.modelCatalog,
          entries: [{ ...later, id: "native", provider: "fixture" }],
        },
      },
    })?.description,
  ).toContain("at most 7 questions");
  expect(
    createDecisionTool("main", { config, preparedModelRuntime: prepared })?.description,
  ).toContain("Provider limits are undeclared");

  setCurrentPluginMetadataSnapshotState(
    {
      ...snapshot,
      get plugins() {
        return expect.fail("Disabled plugins must not inspect the fallback catalog");
      },
    },
    undefined,
    undefined,
    undefined,
    "gateway",
  );
  const disabled = { ...config, plugins: { enabled: false } };
  for (const preparedModelRuntime of [
    undefined,
    {
      ...prepared,
      get modelCatalog() {
        return expect.fail("Disabled plugins must not read the prepared catalog");
      },
    },
  ]) {
    expect(
      createDecisionTool("main", { config: disabled, preparedModelRuntime })?.description,
    ).toContain("Provider limits are undeclared");
  }
});

it("returns rich native outcomes through the core tool, registered host and real preparation", async () => {
  const events = harness.trackDecisionUsage();
  const root = roots.make("decision-tool-native-");
  const pluginRoot = path.join(root, "plugin");
  const emptyBundled = path.join(root, "bundled");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(emptyBundled);
  const id = "decision-tool-fixture";
  const model = {
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
          image: { maxBytes: 4194304, mimeTypes: ["image/png", "image/jpeg"], remoteUrls: false },
        },
      },
    },
  };
  const otherDecision: ModelDecisionCapabilities = {
    protocol: "fixture",
    input: ["text"],
    limits: { maxQuestions: 3 },
  };
  const otherModel = {
    id: "other",
    name: "Other fixture",
    inference: { decision: otherDecision },
  };
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
            models: [model, otherModel],
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
    outcome: nativeOutcome({
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
    }),
  };
  Reflect.set(globalThis, traceKey, trace);
  const cfg = harness.decisionConfig(root, `${id}/native`, {
    ...createColdPluginConfig(pluginRoot, id).plugins,
  });
  await withEnvAsync(harness.decisionEnv(root), async () => {
    const registry = await harness.activateDecisionRegistry(cfg);
    expect(registry.decisionProviders).toHaveLength(1);
    await using prepared = await acquireReadOnlyPreparedModelRuntime({
      agentId: "main",
      agentDir: resolveAgentDir(cfg, "main"),
      workspaceDir,
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
    expect(trace).toMatchObject({ authenticated: true, calls: 1 });
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

    trace.outcome = nativeOutcome({ model: "native", answers: {}, usage: { costUsd: 0 } });
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
    trace.outcome = nativeOutcome({
      model: "native",
      answers: { target: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 } } },
    });
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

    const metadata = prepared.snapshot.metadataSnapshot;
    setCurrentPluginMetadataSnapshotState(metadata, undefined, undefined, undefined, "gateway");
    const captured =
      createDecisionTool("main", { config: cfg }) ?? expect.fail("Missing captured tool");
    expect(captured.description).toContain("at most 8 questions");
    const record =
      metadata.plugins.find((plugin) => plugin.id === id) ?? expect.fail("Missing fixture");
    const replacement = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          ...record,
          modelCatalog: {
            providers: {
              [id]: {
                authScope: "plugin",
                models: [
                  {
                    ...otherModel,
                    inference: {
                      decision: {
                        ...otherDecision,
                        limits: { maxQuestions: 99 },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    });
    setCurrentPluginMetadataSnapshotState(replacement, undefined, undefined, undefined, "gateway");
    setRuntimeConfigSnapshot({
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          decisionModel: `${id}/other`,
        },
      },
    });
    trace.outcome = { status: "unavailable", reason: "unsupported-input" };
    const changed = await captured.execute("changed-selection", {
      state: "Synthetic selection evidence",
      questions: { selected: { type: "boolean" } },
    });
    expect(changed.details).toMatchObject({ status: "unavailable", reason: "unsupported-input" });
    expect(changed.content[0]).toMatchObject({
      text: expect.stringContaining("at most 3 questions"),
    });
    expect(captured.description).toContain("at most 8 questions");
    expect(trace.calls).toBe(4);
  });
});
