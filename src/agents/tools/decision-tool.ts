import { getRuntimeConfig } from "../../config/config.js";
import { decisionBatchV1ToV2 } from "../../decisions/compatibility.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { listAvailableManifestContractPlugins } from "../../plugins/manifest-contract-eligibility.js";
import { resolveDecisionModelSetting } from "../decision-model-setting.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import type { AnyAgentTool } from "./common.js";
import {
  capabilityGuidance,
  DecisionEvaluateInput,
  DecisionEvaluateOutput,
  decisionToolResult,
  parseDecisionEvaluateInput,
  rubricVersion,
} from "./decision-tool-contract.js";

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
      "Evaluate only supplied state with this agent's selected decision model. Ask independent boolean (explicit answer and/or probabilityTrue), choice (competing alternatives), or score (fractional zero-based rubric position) questions. Instructions and criteria accept text, JSON objects/arrays, or null. Preserve explicit answers, abstentions, per-question errors, distributions, metadata and usage; never infer missing probabilities or normalize estimates. Optional confidence is not demonstrated accuracy. Dependent questions require another call with the previous result explicitly supplied. Sends no ambient conversation or files. Hosted providers may charge. Results never authorize actions." +
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
      const submitted = batch && decisionBatchV1ToV2(batch);
      if (!batch || !submitted) {
        // Host bounds are independent of the provider selected after this definition was built.
        return decisionToolResult({ status: "unavailable", reason: "unsupported-input" });
      }
      // Load execution only on invocation; the runtime rereads selection and checks live authority.
      const { evaluateDecisionV2 } = await import("../../decisions/runtime.js");
      operationSignal.throwIfAborted();
      const currentConfig = getRuntimeConfig();
      const currentSelection = resolveDecisionModelSetting(currentConfig, agentId);
      const currentCapabilities = resolveCapabilities(currentSelection);
      // The public input/rubric stays bounded V1 data; execution must retain
      // native costs, metadata and explicit answers that cannot narrow to V1.
      const outcome = await evaluateDecisionV2(submitted, {
        agentId,
        purpose: "decision_evaluate",
        rubricVersion: rubricVersion(batch),
        timeoutMs: 30_000,
        signal: operationSignal,
      });
      operationSignal.throwIfAborted();
      return decisionToolResult(outcome, currentCapabilities);
    },
  };
}
