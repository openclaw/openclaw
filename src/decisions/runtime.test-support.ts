import { onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createDecisionRegistry } from "./contract.test-support.js";
import { evaluateDecisionInRegistry, prepareDecisionProviderReload } from "./runtime.js";
import type {
  DecisionBatch,
  DecisionProviderV1,
  DecisionRuntimeV1,
  ProviderDecisionOutcome,
} from "./types.js";

export const batch: DecisionBatch = {
  state: { evidence: "synthetic" },
  questions: {
    pick: { type: "choice", criteria: { yes: "supported", unclear: "not established" } },
    rank: { type: "score", criteria: ["low", "middle", "high"] },
    truth: { type: "boolean" },
  },
};
export const answer = {
  status: "ok",
  result: {
    model: "fixture-v1",
    answers: {
      pick: { type: "choice", choice: "yes", probabilities: { yes: 0.8, unclear: 0.2 } },
      rank: { type: "score", score: 1.3, probabilities: [0.1, 0.5, 0.4] },
      truth: { type: "boolean", probabilityTrue: 0.7 },
    },
    usage: { inputTokens: 25, outputTokens: 4 },
  },
} satisfies ProviderDecisionOutcome;
export const config: OpenClawConfig = {
  agents: { defaults: { decisionModel: "fixture/fixture-v1" } },
};
export const options = (): Parameters<DecisionRuntimeV1["evaluate"]>[1] => ({
  purpose: "test",
  rubricVersion: "1",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
});
export function registered(
  evaluate: DecisionProviderV1["evaluate"] = async () => answer,
  isReady?: () => boolean,
  providerId = "fixture",
) {
  const started = createDeferredCore();
  const builder = createDecisionRegistry(config, {
    id: providerId,
    contractVersion: 1,
    evaluate: (...args) => {
      started.resolve();
      return evaluate(...args);
    },
    isReady,
  });
  const { record } = builder;
  onTestFinished(async () => {
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  });
  const run = (opts = options(), cfg = config) =>
    evaluateDecisionInRegistry(batch, opts, builder.registry, cfg);
  return { ...builder, run, started: started.promise };
}
