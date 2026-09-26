import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { DecisionBatch, DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type DecisionObservation = {
  batch: DecisionBatch;
  model: string;
  agentId?: string;
};

export default definePluginEntry({
  id: "auto-joined-decision",
  name: "Synthetic joined-proof Decision provider",
  description:
    "Fixed answer at the Decision provider boundary only; no routing or transcript writes.",
  register(api: OpenClawPluginApi) {
    const evidencePath = api.pluginConfig?.evidencePath;
    if (typeof evidencePath !== "string" || !isAbsolute(evidencePath)) {
      throw new Error("The proof owner must provide an absolute observation path.");
    }
    const provider: DecisionProviderV1 = {
      id: "auto-joined-decision",
      contractVersion: 1,
      isReady: () => true,
      async evaluate(batch, context) {
        context.signal.throwIfAborted();
        appendFileSync(
          evidencePath,
          JSON.stringify({
            batch,
            model: context.model,
            agentId: context.agentId,
          } satisfies DecisionObservation) + "\n",
        );
        return {
          status: "ok",
          result: {
            model: context.model,
            answers: {
              delivery: {
                type: "choice",
                choice: "steer",
                probabilities: { steer: 1, followup: 0, abstain: 0 },
              },
            },
          },
        };
      },
    };
    api.registerDecisionProvider(provider);
  },
});
