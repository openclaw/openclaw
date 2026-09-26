import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifest } from "./manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("discovers only decision models owned by the manifest without executing its runtime", () => {
  const root = tempDirs.make("manifest-decision-models-");
  fs.writeFileSync(path.join(root, "index.js"), "throw new Error('runtime must stay cold');");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      contracts: { decisionProviders: ["fixture"] },
      decisionModels: [
        {
          provider: " fixture ",
          id: " fast ",
          name: " Fast decisions ",
          capabilities: {
            questionTypes: ["boolean", "choice", "score"],
            maxQuestions: 32,
            maxChoiceAlternatives: 64,
            maxScoreLevels: 64,
            maxInputTokens: 512,
            inputTokenScope: "encoded-question",
            requiresBooleanCriteria: true,
            confidence: "none",
          },
        },
        { provider: "fixture", id: "fast", name: "Duplicate" },
        { provider: "other", id: "foreign", name: "Unowned" },
        { provider: "fixture", id: "missing-name" },
      ],
    }),
  );
  const result = loadPluginManifest(root);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  expect(result.manifest.decisionModels).toEqual([
    {
      provider: "fixture",
      id: "fast",
      name: "Fast decisions",
      capabilities: {
        questionTypes: ["boolean", "choice", "score"],
        maxQuestions: 32,
        maxChoiceAlternatives: 64,
        maxScoreLevels: 64,
        maxInputTokens: 512,
        inputTokenScope: "encoded-question",
        requiresBooleanCriteria: true,
        confidence: "none",
      },
    },
  ]);
  expect(result.manifest.providers ?? []).toEqual([]);
  const row = result.manifest.modelCatalog?.providers?.fixture?.models[0];
  expect(row).toMatchObject({
    id: "fast",
    name: "Fast decisions",
    inference: {
      chat: false,
      decision: {
        protocol: "decision-v1",
        questions: {
          boolean: { probabilities: "boolean", abstention: false },
          choice: { maxOptions: 64 },
          score: { maxOptions: 64 },
        },
        limits: { maxQuestions: 32, maxInputTokens: 512, inputTokenScope: "encoded-question" },
      },
    },
  });
  expect(row).not.toHaveProperty("api");
  expect(row).not.toHaveProperty("cost");
  expect(row).not.toHaveProperty("maxTokens");
});

it("bounds provider metadata before discovery can expose it to tool diagnostics", () => {
  const root = tempDirs.make("manifest-decision-capabilities-");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      contracts: { decisionProviders: ["fixture"] },
      decisionModels: [
        {
          provider: "fixture",
          id: "bounded",
          name: "Bounded",
          capabilities: {
            questionTypes: ["boolean", "boolean"],
            maxQuestions: -1,
            maxChoiceAlternatives: 1.5,
            maxScoreLevels: Number.MAX_SAFE_INTEGER + 1,
            maxInputTokens: "private-provider-diagnostic",
            confidence: "private-provider-diagnostic",
            inputTokenScope: "private-provider-diagnostic",
            requiresBooleanCriteria: "true",
          },
        },
        {
          provider: "fixture",
          id: "invalid",
          name: "Invalid",
          capabilities: { questionTypes: ["private-provider-diagnostic"] },
        },
      ],
    }),
  );
  const result = loadPluginManifest(root);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  expect(result.manifest.decisionModels).toEqual([
    {
      provider: "fixture",
      id: "bounded",
      name: "Bounded",
      capabilities: { questionTypes: ["boolean"] },
    },
    { provider: "fixture", id: "invalid", name: "Invalid" },
  ]);
});

it("keeps undocumented legacy capabilities unknown in the canonical catalog", () => {
  const root = tempDirs.make("manifest-decision-unknown-");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      contracts: { decisionProviders: ["fixture"] },
      decisionModels: [
        { provider: "fixture", id: "unknown", name: "Unknown" },
        { provider: "fixture", id: "empty", name: "Empty", capabilities: {} },
      ],
    }),
  );
  const result = loadPluginManifest(root);
  if (!result.ok) {
    throw new Error(result.error);
  }
  const rows = result.manifest.modelCatalog?.providers?.fixture?.models;
  expect(rows?.map((row) => row.id)).toEqual(["unknown", "empty"]);
  for (const row of rows ?? []) {
    expect(row.inference).toEqual({
      chat: false,
      decision: { protocol: "decision-v1", input: ["text"] },
    });
    expect(row).not.toHaveProperty("cost");
    expect(row).not.toHaveProperty("contextWindow");
    expect(row).not.toHaveProperty("maxTokens");
  }
});

it.each([{}, null, [], { unknown: {} }, { boolean: {} }].map((questions) => ({ questions })))(
  "does not revive a rejected canonical declaration from legacy metadata: $questions",
  ({ questions }) => {
    const root = tempDirs.make("manifest-decision-invalid-canonical-");
    fs.writeFileSync(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({
        id: "fixture",
        configSchema: { type: "object" },
        contracts: { decisionProviders: ["fixture"] },
        decisionModels: [{ provider: "fixture", id: "native", name: "Legacy" }],
        modelCatalog: {
          providers: {
            " fixture ": {
              models: [
                {
                  id: " native ",
                  inference: {
                    chat: false,
                    decision: { protocol: "native", input: ["text"], questions },
                  },
                },
              ],
            },
          },
        },
      }),
    );
    const result = loadPluginManifest(root);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.manifest.modelCatalog?.providers?.fixture?.models).toBeUndefined();
    expect(result.manifest.decisionModels).toBeUndefined();
  },
);
