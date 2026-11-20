// Plugin SDK tests cover the live-discovery unknown-model gate.
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { makeConfiguredModel } from "../agents/test-helpers/provider-model-fixture.js";
import {
  buildOpenAICompatibleLiveModels,
  readLiveModelChatCapability,
} from "./provider-catalog-live-normalize.internal.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";

const fallback = {
  baseUrl: "https://api.example.com",
  api: "anthropic-messages",
  models: [
    makeConfiguredModel({
      id: "known-model",
      name: "Known",
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    }),
  ],
} as unknown as ModelProviderConfig;

const rows = [
  { id: "known-model", object: "model" },
  { id: "brand-new-model", object: "model", capabilities: { chat: true } },
];

describe("live discovery unknown-model gate", () => {
  // Shapes from real listings (OpenAI, Vercel, DeepInfra, Venice, LiteLLM, Together, NVIDIA)
  // with synthetic ids. `inference` stays absent for shown rows: unknown is not false. Weak
  // evidence only demotes a row to unlikely chat; declared non-chat rows get `chat: false`.
  it.each([
    {
      name: "OpenAI bare rows are unknown; a non-text family id is only unlikely chat",
      rows: [
        { id: "vendor-chat-9", object: "model", created: 1, owned_by: "system" },
        { id: "vendor-embed-small", object: "model", created: 1, owned_by: "system" },
      ],
      shown: ["vendor-chat-9"],
      unlikely: ["vendor-embed-small"],
    },
    {
      name: "Vercel reranking kind beats its text output",
      rows: [
        { id: "acme/ranker-5", type: "reranking", modalities: { output: ["text"] } },
        { id: "acme/lm-5", type: "language", modalities: { output: ["text"] } },
      ],
      shown: ["acme/lm-5"],
    },
    {
      name: "DeepInfra metadata.tags",
      rows: [
        { id: "acme/bge-small", metadata: { tags: ["embed"] } },
        { id: "acme/voice-1", metadata: { tags: ["tts"] } },
        { id: "acme/seed-2", metadata: { tags: ["chat", "reasoning"] } },
      ],
      shown: ["acme/seed-2"],
    },
    {
      name: "Venice type",
      rows: [
        { id: "venice-llm", type: "text" },
        { id: "venice-song", type: "music" },
      ],
      shown: ["venice-llm"],
    },
    {
      name: "LiteLLM mode",
      rows: [
        { id: "proxy-chat", object: "model", mode: "chat" },
        { id: "proxy-vectors", object: "model", mode: "embedding" },
        { id: "proxy-legacy", object: "model", mode: "completion" },
      ],
      shown: ["proxy-chat"],
    },
    {
      name: "LiteLLM completion mode is non-chat without a chat sibling",
      rows: [{ id: "proxy-legacy", object: "model", mode: "completion" }],
      shown: [],
    },
    {
      name: "Together language is unlikely chat only in a listing that names a chat type",
      rows: [
        { id: "together/llama-instruct", type: "chat" },
        { id: "together/llama-base", type: "language" },
      ],
      shown: ["together/llama-instruct"],
      unlikely: ["together/llama-base"],
    },
    {
      name: "NVIDIA mixed rows leave bare rows unknown",
      rows: [
        { id: "nv/vision-1", model_type: "vlm" },
        { id: "nv/llama-4" },
        { id: "nv/coder-2", model_type: "embedding" },
      ],
      shown: ["nv/llama-4", "nv/vision-1"],
    },
  ])("$name", ({ rows: listing, shown, unlikely = [] }) => {
    const models = buildOpenAICompatibleLiveModels(listing, { ...fallback, models: [] });
    const ids = (inference: unknown) =>
      models.filter((m) => isDeepStrictEqual(m.inference, inference)).map((m) => m.id);
    expect(ids(undefined)).toEqual(shown);
    expect(ids({ chat: true, chatEvidence: "unlikely" })).toEqual(unlikely);
    expect(ids({ chat: false })).toHaveLength(listing.length - shown.length - unlikely.length);
  });

  it("applies a provider prior to bare uncatalogued rows only", () => {
    const listing = [
      { id: "known-model", object: "model" },
      { id: "Vendor-Speech2", object: "model" },
      { id: "vendor-chat-2", object: "model", capabilities: { chat: true } },
      { id: "vendor-voice", object: "model", output_modalities: ["audio"] },
    ];
    const models = buildOpenAICompatibleLiveModels(listing, fallback, undefined, "unlikely");
    expect(Object.fromEntries(models.map((m) => [m.id, m.inference]))).toEqual({
      "known-model": undefined,
      "Vendor-Speech2": { chat: true, chatEvidence: "unlikely" },
      "vendor-chat-2": undefined,
      "vendor-voice": { chat: false },
    });
  });

  it("does not read Together's language type as chat on its own", () => {
    expect(readLiveModelChatCapability({ id: "base", type: "language" })).toBeUndefined();
  });

  it("drops only the ids the manifest does not publish when the gate rejects", () => {
    const seen: string[] = [];
    const models = buildOpenAICompatibleLiveModels(rows, fallback, ({ id }) => {
      seen.push(id);
      return false;
    });
    // The manifest-published row bypasses the gate entirely and survives.
    expect(models).toEqual([fallback.models[0]]);
    expect(seen).toEqual(["brand-new-model"]);
  });

  it("admits unknown ids the gate accepts", () => {
    const ids = buildOpenAICompatibleLiveModels(rows, fallback, () => true).map((m) => m.id);
    expect(ids).toEqual(["brand-new-model", "known-model"]);
  });
});

it("marks explicit embedding-only capabilities as non-chat without hiding mixed chat rows", () => {
  const capabilityRows = [
    { id: "mlx-community/all-MiniLM-L6-v2-4bit", capabilities: ["embedding"] },
    { id: "mixed-model", capabilities: ["text", "embedding"] },
    { id: "unknown-model", capabilities: ["tools"] },
  ];
  expect(
    Object.fromEntries(
      buildOpenAICompatibleLiveModels(capabilityRows, fallback).map((model) => [
        model.id,
        model.inference,
      ]),
    ),
  ).toEqual({
    "mlx-community/all-MiniLM-L6-v2-4bit": { chat: false },
    "mixed-model": undefined,
    "unknown-model": { chat: true, chatEvidence: "unlikely" },
  });
});
