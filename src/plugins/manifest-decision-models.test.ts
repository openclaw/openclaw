import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifest } from "./manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const decision = (id: string, name: string, fields: Record<string, unknown> = {}) => ({
  provider: "fixture",
  id,
  name,
  ...fields,
});

function loadModels(fields: Record<string, unknown>) {
  const root = tempDirs.make("manifest-decision-models-");
  fs.writeFileSync(path.join(root, "index.js"), "throw new Error('runtime must stay cold');");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      contracts: { decisionProviders: ["fixture"] },
      ...fields,
    }),
  );
  const result = loadPluginManifest(root);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.manifest;
}

it("discovers only decision models owned by the manifest without executing its runtime", () => {
  const capabilities = {
    questionTypes: ["boolean", "choice", "score"],
    maxQuestions: 32,
    maxChoiceAlternatives: 64,
    maxScoreLevels: 64,
    maxInputTokens: 512,
    inputTokenScope: "encoded-question",
    requiresBooleanCriteria: true,
    confidence: "none",
  };
  const manifest = loadModels({
    decisionModels: [
      decision(" fast ", " Fast decisions ", { provider: " fixture ", capabilities }),
      decision("fast", "Duplicate"),
      decision("foreign", "Unowned", { provider: "other" }),
      { provider: "fixture", id: "missing-name" },
    ],
  });
  expect(manifest.decisionModels).toEqual([decision("fast", "Fast decisions", { capabilities })]);
  expect(manifest.providers ?? []).toEqual([]);
  expect(manifest.modelCatalog?.providers?.fixture?.models).toEqual([
    {
      id: "fast",
      name: "Fast decisions",
      inference: {
        chat: false,
        decision: {
          protocol: "decision-v1",
          input: ["text"],
          questions: {
            boolean: { probabilities: "boolean", abstention: false, requiresCriteria: true },
            choice: { probabilities: "provider-defined", abstention: false, maxOptions: 64 },
            score: { probabilities: "provider-defined", abstention: false, maxOptions: 64 },
          },
          confidence: "none",
          limits: { maxQuestions: 32, maxInputTokens: 512, inputTokenScope: "encoded-question" },
        },
      },
    },
  ]);
});

it("bounds provider metadata before discovery can expose it to tool diagnostics", () => {
  const manifest = loadModels({
    decisionModels: [
      decision("bounded", "Bounded", {
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
      }),
      decision("invalid", "Invalid", {
        capabilities: { questionTypes: ["private-provider-diagnostic"] },
      }),
    ],
  });
  expect(manifest.decisionModels).toEqual([
    decision("bounded", "Bounded", { capabilities: { questionTypes: ["boolean"] } }),
    decision("invalid", "Invalid"),
  ]);
});

it("keeps explicit canonical identities authoritative over V1 input, including rejected rows", () => {
  const native = {
    id: "native",
    name: "Native",
    inference: { chat: false, decision: { protocol: "native", input: ["image"] } },
  };
  const manifest = loadModels({
    modelCatalog: {
      providers: {
        fixture: {
          models: [
            native,
            {
              id: "rejected",
              name: "Rejected",
              inference: { decision: { protocol: "invalid", input: ["unrecognized"] } },
            },
          ],
        },
      },
    },
    decisionModels: [
      decision("native", "Legacy duplicate"),
      decision("rejected", "Must not resurrect"),
    ],
  });
  expect(manifest.modelCatalog?.providers?.fixture?.models).toEqual([native]);
});
