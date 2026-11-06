import { getRuntimeConfig } from "../../config/config.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { listAvailableManifestContractPlugins } from "../../plugins/manifest-contract-eligibility.js";
import { getPluginRegistryForContext } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveDecisionModelSetting } from "../decision-model-setting.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import type { AnyAgentTool } from "./common.js";
import {
  capabilityGuidance,
  decisionToolResult,
  parseDecisionEvaluateInput,
  rubricVersion,
} from "./decision-tool-contract.js";
import { DecisionEvaluateInput, DecisionEvaluateOutput } from "./decision-tool-schema.js";

/** Bind a conditional core tool to its trusted agent; provider health never changes eligibility. */
export function createDecisionTool(
  agentId: string,
  options?: Pick<OpenClawToolsOptions, "config" | "preparedModelRuntime">,
): AnyAgentTool | null {
  const config = options?.config ?? getRuntimeConfig();
  const selected = resolveDecisionModelSetting(config, agentId);
  if (!agentId.trim() || !selected) {
    return null;
  }
  // Prepared declarations follow the existing tool/context refresh lifecycle.
  const snapshot =
    options?.preparedModelRuntime?.metadataSnapshot ?? getGatewayPluginMetadataSnapshot();
  const models =
    config.plugins?.enabled === false
      ? []
      : (options?.preparedModelRuntime?.modelCatalog.entries ??
        (snapshot
          ? listAvailableManifestContractPlugins({
              snapshot,
              config,
              contract: "decisionProviders",
            }).flatMap((plugin) =>
              Object.entries(plugin.modelCatalog?.providers ?? {}).flatMap(([provider, catalog]) =>
                catalog.models.map((model) => ({ ...model, provider })),
              ),
            )
          : []));
  const resolveCapabilities = (selection: ReturnType<typeof resolveDecisionModelSetting>) => {
    if (!selection) {
      return undefined;
    }
    const modelId = splitTrailingAuthProfile(selection.model).model;
    return models.find((model) => model.provider === selection.provider && model.id === modelId)
      ?.inference?.decision;
  };
  const capabilities = resolveCapabilities(selected);
  return {
    name: "decision_evaluate",
    label: "Decision evaluation",
    description:
      "Evaluate only supplied state with this agent's selected decision model. Ask independent boolean (explicit answer and/or probabilityTrue), choice (competing alternatives), or score (fractional zero-based rubric position) questions. Use contractVersion 2 and tagged state for images, box (normalized image edges), sort (list IDs), or tags, when the provider supports them. A box does not prove presence; ask a companion boolean question. Instructions and criteria accept text, JSON objects/arrays, or null, except box instructions must be non-null. Preserve explicit answers, abstentions, per-question errors, distributions, metadata and usage; never infer missing probabilities or normalize estimates. Optional confidence is not demonstrated accuracy. Dependent questions require another call with the previous result explicitly supplied. Sends no ambient conversation or files. Hosted providers may charge. Results never authorize actions." +
      (capabilities
        ? ` ${capabilityGuidance(capabilities)}`
        : " Provider limits are undeclared; use concise evidence and explicit true/false descriptions."),
    parameters: DecisionEvaluateInput,
    outputSchema: DecisionEvaluateOutput,
    resultContentSource: "network",
    async execute(_id, params, signal) {
      const operationSignal = signal ?? new AbortController().signal;
      operationSignal.throwIfAborted();
      const batch = parseDecisionEvaluateInput(params);
      if (!batch) {
        // Host bounds are independent of the provider selected after this definition was built.
        return decisionToolResult({ status: "unavailable", reason: "unsupported-input" });
      }
      // Load execution only on invocation; the runtime rereads selection and checks live authority.
      const [{ evaluateDecisionV2Operation }, { completeDecisionEvaluation }] = await Promise.all([
        import("../../decisions/runtime.js"),
        import("../../decisions/completion.js"),
      ]);
      operationSignal.throwIfAborted();
      const currentConfig = getRuntimeConfig();
      const currentSelection = resolveDecisionModelSetting(currentConfig, agentId);
      const currentCapabilities = resolveCapabilities(currentSelection);
      const evaluation = await evaluateDecisionV2Operation(
        batch,
        {
          agentId,
          purpose: "decision_evaluate",
          rubricVersion: rubricVersion(batch),
          timeoutMs: 30_000,
          signal: operationSignal,
        },
        getPluginRegistryForContext(),
        currentConfig,
      );
      operationSignal.throwIfAborted();
      const result = decisionToolResult(evaluation.outcome, currentCapabilities);
      completeDecisionEvaluation(evaluation);
      return result;
    },
  };
}
