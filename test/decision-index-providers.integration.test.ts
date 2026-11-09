import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import celeris from "../extensions/celeris/index.js";
import fastino from "../extensions/fastino/index.js";
import nace from "../extensions/nace/index.js";
import perplexity from "../extensions/perplexity/index.js";
import { resolveEnvApiKey } from "../src/agents/model-auth-env.js";
import { loadManifestModelCatalog } from "../src/agents/model-catalog.js";
import { listDecisionModels } from "../src/gateway/server-methods/models-list-capabilities.js";
import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  DecisionProviderV2,
} from "../src/plugin-sdk/decisions.js";
import { createTestPluginApi } from "../src/plugin-sdk/plugin-test-api.js";
import {
  mockPinnedHostnameResolution,
  requestUrl,
  withFetchPreconnect,
} from "../src/plugin-sdk/test-env.js";
import { loadPluginManifest } from "../src/plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../src/plugins/plugin-metadata.test-support.js";
import { resolveProviderAuthLookupMaps } from "../src/secrets/provider-env-vars.js";

const cases = [
  {
    plugin: celeris,
    provider: "celeris",
    model: "celeris-1.1-decision",
    served: "celeris-1.1-decision",
    url: "https://inference.celeris.ai/celeris-1-decision/v1/decisions",
    format: "openai",
    maxScore: 64,
    maxQuestions: 400,
  },
  {
    plugin: nace,
    provider: "nace",
    model: "drex-max-v1.1",
    served: "drex-max-v1.1",
    url: "https://console.nace.ai/v1/decisions",
    format: "openai",
    maxScore: 255,
    maxQuestions: 400,
  },
  {
    plugin: perplexity,
    provider: "perplexity-decisions",
    model: "pplx-decider-v1.2",
    served: "pplx-decider-v1.2",
    url: "https://api.perplexity.ai/v1/decisions",
    format: "systemone",
    maxScore: 10,
    maxQuestions: 128,
  },
  {
    plugin: fastino,
    provider: "fastino",
    model: "fastino/GLiDE",
    served: "glide",
    url: "https://api.fastino.ai/v1/systemone",
    format: "fastino",
    maxScore: 255,
    maxQuestions: 256,
  },
];
const batch: DecisionBatchV2 = {
  state: { type: "json", value: { ticket: "Refund duplicate charge" } },
  questions: {
    refund: { type: "boolean", instructions: "Is a refund requested?" },
    team: { type: "choice", criteria: { billing: "Payments", support: "Technical" } },
    urgency: { type: "score", criteria: ["Routine", "Emergency"] },
  },
};
function registered(row: (typeof cases)[number]) {
  let decision: DecisionProviderV2 | undefined;
  row.plugin.register(
    createTestPluginApi({
      registerDecisionProvider(p) {
        if (p.contractVersion === 2) {
          decision = p;
        }
      },
    }),
  );
  if (!decision) {
    throw new Error("Native Decision provider was not registered");
  }
  const context: DecisionProviderContextV2 = {
    model: { provider: row.provider, id: row.model, name: row.model },
    config: {},
    auth: { mode: "api-key", apiKey: "synthetic-native-credential" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30_000,
    isAdmissible: () => true,
  };
  return { decision, context };
}
function reply(row: (typeof cases)[number]) {
  return {
    model: row.served,
    answers:
      row.format === "openai"
        ? [
            { name: "refund", type: "predicate", probability: 0.98 },
            {
              name: "team",
              type: "choice",
              choice: "billing",
              confidence: 0.8,
              probabilities: [
                { value: "billing", probability: 0.9 },
                { value: "support", probability: 0.1 },
              ],
            },
            {
              name: "urgency",
              type: "score",
              score: 0.2,
              confidence: 0.6,
              probabilities: [
                { label: "0", value: 0, probability: 0.8 },
                { label: "1", value: 1, probability: 0.2 },
              ],
            },
          ]
        : {
            refund: { type: "noul", noul: 0.98 },
            team: {
              type: "choice",
              choice: "billing",
              confidence: 0.8,
              probabilities: { billing: 0.9, support: 0.1 },
            },
            urgency: {
              type: "score",
              score: row.format === "fastino" ? 0 : 0.2,
              ...(row.format === "fastino" ? { expected_level: 0.2 } : {}),
              confidence: 0.6,
              probabilities: { "0": 0.8, "1": 0.2 },
              legend: { "0": "Routine", "1": "Emergency" },
            },
          },
    usage: { input_tokens: 42, output_tokens: 252 },
  };
}
const fetch = vi.fn<typeof globalThis.fetch>();
beforeEach(() => {
  // Only external DNS/fetch are fixtures; registration, codecs, auth assembly and HTTP guard are real.
  mockPinnedHostnameResolution();
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  fetch.mockReset();
  vi.stubGlobal("fetch", withFetchPreconnect(fetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(cases)("evaluates $provider through its registered native protocol", async (row) => {
  fetch.mockResolvedValue(Response.json(reply(row)));
  const { decision, context } = registered(row);
  expect(await decision.evaluate(batch, context)).toEqual({
    status: "ok",
    result: {
      model: row.served,
      answers: {
        refund: { type: "boolean", probabilityTrue: 0.98 },
        team: {
          type: "choice",
          choice: "billing",
          confidence: 0.8,
          probabilities: { billing: 0.9, support: 0.1 },
        },
        urgency: { type: "score", score: 0.2, confidence: 0.6, probabilities: [0.8, 0.2] },
      },
      usage: { inputTokens: 42, outputTokens: 252 },
    },
  });
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0]!;
  expect(requestUrl(url)).toBe(row.url);
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer synthetic-native-credential",
  );
  if (typeof init?.body !== "string") {
    throw new Error("Expected serialized JSON");
  }
  const body = JSON.parse(init.body);
  expect(body.model).toBe(row.model);
  expect(body[row.format === "openai" ? "input" : "state"]).toBe(
    '{"ticket":"Refund duplicate charge"}',
  );
  if (row.format === "openai") {
    expect(Object.keys(body).toSorted()).toEqual(["input", "model", "questions"]);
    expect(body.questions.map((q: { type: string }) => q.type)).toEqual([
      "predicate",
      "choice",
      "score",
    ]);
  } else {
    expect(Object.keys(body).toSorted()).toEqual(
      row.format === "fastino"
        ? ["model", "questions", "state", "store"]
        : ["model", "questions", "state"],
    );
    expect(body.questions.refund.type).toBe("noul");
    expect(body.questions.team.criteria).toEqual({ billing: "Payments", support: "Technical" });
    expect(body.questions.urgency.criteria).toEqual(["Routine", "Emergency"]);
    if (row.format === "fastino") {
      expect(body.store).toBe(false);
      expect(body.questions.urgency.instructions).toBe(
        "Rate the state against the ordered rubric.",
      );
    }
  }
});
it.each(cases)("rejects $provider route mismatches and native bounds before HTTP", async (row) => {
  const { decision, context } = registered(row);
  expect(
    await decision.evaluate(batch, {
      ...context,
      model: { ...context.model, id: "unverified-model" },
    }),
  ).toEqual({ status: "unavailable", reason: "unsupported-input" });
  expect(
    await decision.evaluate(batch, {
      ...context,
      model: { ...context.model, api: "openai-completions" },
    }),
  ).toEqual({ status: "unavailable", reason: "unsupported-input" });
  const inputs: DecisionBatchV2[] = [
    { ...batch, state: { type: "image", dataUri: "data:image/png;base64,AA==" } },
    {
      ...batch,
      questions: {
        q: {
          type: "score",
          criteria: Array.from({ length: row.maxScore + 1 }, (_, i) => String(i)),
        },
      },
    },
    {
      ...batch,
      questions: Object.fromEntries(
        Array.from({ length: row.maxQuestions + 1 }, (_, i) => [
          String(i),
          { type: "boolean", instructions: "Match?" },
        ]),
      ),
    },
  ];
  for (const input of inputs) {
    expect(await decision.evaluate(input, context)).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects GLiDE scores missing expected_level instead of silently substituting argmax", async () => {
  const row = cases[3]!;
  const payload = reply(row);
  if (Array.isArray(payload.answers)) {
    throw new Error("Expected native answer map");
  }
  const { expected_level: _expected, ...urgency } = payload.answers.urgency;
  fetch.mockResolvedValue(Response.json({ ...payload, answers: { ...payload.answers, urgency } }));
  const { decision, context } = registered(row);
  expect(await decision.evaluate(batch, context)).toEqual({
    status: "unavailable",
    reason: "invalid-response",
  });
});

it("projects the source manifests into the Decision picker and isolates native Perplexity auth", () => {
  const config = {
    plugins: {
      entries: Object.fromEntries(cases.map((row) => [row.plugin.id, { enabled: true }])),
    },
  };
  const plugins = cases.map((row) => {
    const rootDir = fileURLToPath(new URL("../extensions/" + row.plugin.id, import.meta.url));
    const loaded = loadPluginManifest(rootDir);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    const { manifest } = loaded;
    return {
      id: manifest.id,
      rootDir,
      providers: manifest.providers,
      contracts: manifest.contracts,
      modelCatalog: manifest.modelCatalog,
      setup: manifest.setup,
    };
  });
  const snapshot = createPluginMetadataSnapshotFixture({ plugins });
  const catalog = loadManifestModelCatalog({ config, metadataSnapshot: snapshot });
  const selectable = listDecisionModels({ config, snapshot, catalog });
  expect(selectable.map((row) => row.provider + "/" + row.id).toSorted()).toEqual(
    cases.map((row) => row.provider + "/" + row.model).toSorted(),
  );
  expect(catalog.every((row) => row.inference?.chat === false)).toBe(true);
  const maps = resolveProviderAuthLookupMaps({ config, metadataSnapshot: snapshot });
  const authOptions = {
    config,
    aliasMap: maps.aliasMap,
    candidateMap: maps.envCandidateMap,
    authEvidenceMap: maps.authEvidenceMap,
    skipSetupProviderFallback: true,
  };
  const env = { OPENROUTER_API_KEY: "synthetic-search-only-key" };
  expect(resolveEnvApiKey("perplexity-decisions", env, authOptions)).toBeNull();
  expect(resolveEnvApiKey("perplexity", env, authOptions)).toEqual({
    apiKey: "synthetic-search-only-key",
    source: "env: OPENROUTER_API_KEY",
  });
});
