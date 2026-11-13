import assert from "node:assert/strict";
import { expect, it } from "vitest";
import celeris from "../extensions/celeris/index.js";
import fastino from "../extensions/fastino/index.js";
import nace from "../extensions/nace/index.js";
import perplexity from "../extensions/perplexity/index.js";
import { attachModelProviderRequestTransport } from "../src/agents/provider-request-config.js";
import {
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionProviderV2,
} from "../src/plugin-sdk/decisions.js";
import { createTestPluginApi } from "../src/plugin-sdk/plugin-test-api.js";

const providers = [
  { plugin: celeris, provider: "celeris", model: "celeris-1.1-decision", key: "CELERIS_API_KEY" },
  { plugin: fastino, provider: "fastino", model: "fastino/GLiDE", key: "FASTINO_API_KEY" },
  { plugin: nace, provider: "nace", model: "drex-max-v1.1", key: "NACE_API_KEY" },
  {
    plugin: perplexity,
    provider: "perplexity-decisions",
    model: "pplx-decider-v1.2",
    key: "PERPLEXITY_API_KEY",
  },
];

// Fixed synthetic evidence exercises the real registered adapter, credentialed HTTP,
// native response decoding, and all three result primitives without customer data.
const batch: DecisionBatchV2 = {
  state: { type: "text", text: "A square is entirely red. It contains no blue." },
  questions: {
    red: { type: "boolean", instructions: "Is the square red?" },
    color: {
      type: "choice",
      instructions: "What color is the square?",
      criteria: { red: "Red", blue: "Blue" },
    },
    coverage: {
      type: "score",
      instructions: "How much of the square is red?",
      criteria: ["None", "About half", "All"],
    },
  },
};

for (const row of providers) {
  it.runIf(process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env[row.key]))(
    `evaluates a synthetic batch through native ${row.provider}`,
    async () => {
      const apiKey = process.env[row.key];
      assert(apiKey);
      let provider: DecisionProviderV2 | undefined;
      row.plugin.register(
        createTestPluginApi({
          registerDecisionProvider(candidate) {
            if (candidate.id === row.provider && candidate.contractVersion === 2) {
              provider = candidate;
            }
          },
        }),
      );
      assert(provider, "The native Decision V2 provider must register");
      // Use the supported prepared model transport for protected-store HTTPS egress.
      // Never load or change the operator Gateway config/auth store.
      const model = attachModelProviderRequestTransport(
        { provider: row.provider, id: row.model, name: row.model },
        process.env.HTTPS_PROXY || process.env.https_proxy
          ? { proxy: { mode: "env-proxy" } }
          : undefined,
      );
      const outcome = await provider.evaluate(batch, {
        model,
        config: {},
        auth: { mode: "api-key", apiKey },
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 30_000,
        isAdmissible: () => true,
      });
      if (outcome.status !== "ok") {
        throw new Error(`${row.provider} live contract unavailable: ${outcome.reason}`);
      }
      const { answers, model: servedModel, usage } = outcome.result;
      // Retain the paid synthetic result even if a semantic assertion fails.
      console.log(JSON.stringify({ provider: row.provider, model: servedModel, answers, usage }));
      expect(validateDecisionResultV2(batch, outcome.result)).toBe(true);
      expect(answers.color).toMatchObject({ type: "choice", choice: "red" });
      assert(answers.red?.type === "boolean" && answers.coverage?.type === "score");
      expect(answers.red.probabilityTrue).toBeGreaterThan(0.5);
      expect(answers.coverage.score).toBeGreaterThan(1);
      expect(usage).toMatchObject({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      });
    },
    40_000,
  );
}
