import { getRuntimeConfig } from "../../config/config.js";
import { projectDecisionModelCatalog } from "../../model-catalog/decision-compatibility.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { resolveDecisionModelSetting } from "../decision-model-setting.js";
import { loadManifestModelCatalogRows } from "../model-catalog-manifest.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import type { AnyAgentTool } from "./common.js";
import {
  capabilityGuidance,
  DecisionEvaluateInput,
  DecisionEvaluateOutput,
  decisionToolResult,
  parseDecisionToolRequest,
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
  const canonical =
    options?.preparedModelRuntime?.modelCatalog.entries ??
    (snapshot ? loadManifestModelCatalogRows(config, snapshot) : []);
  const models = projectDecisionModelCatalog(canonical);
  const capabilities = models.find(
    (model) => model.provider === selected.provider && model.id === selected.model,
  )?.capabilities;
  return {
    name: "decision_evaluate",
    label: "Decision evaluation",
    description:
      "Evaluate only supplied state with this agent's selected decision model. Ask independent boolean (probabilityTrue, not a thresholded answer), choice (competing alternatives), or score (fractional zero-based rubric position) questions. Instructions and criteria accept text, JSON objects/arrays, or null. Preserve distributions and optional provider-specific confidence/usage; confidence is not demonstrated accuracy. Dependent questions require another call with the previous result explicitly supplied. Sends no ambient conversation or files. Hosted providers may charge. Results never authorize actions. Set contractVersion:2 with explicit text/json/image/list state for supported native sort/tags, images, reasoning controls, abstention or probability-free results. A model must declare support; never infer chat support or fabricate missing probabilities." +
      (capabilities
        ? ` ${capabilityGuidance(capabilities)}`
        : " Provider limits are undeclared; use concise evidence and explicit true/false descriptions."),
    parameters: DecisionEvaluateInput,
    outputSchema: DecisionEvaluateOutput,
    resultContentSource: "network",
    async execute(_id, params, signal) {
      const operationSignal = signal ?? new AbortController().signal;
      operationSignal.throwIfAborted();
      const request = parseDecisionToolRequest(params);
      if (!request) {
        // Host bounds are independent of the provider selected after this definition was built.
        return decisionToolResult({ status: "unavailable", reason: "unsupported-input" });
      }
      // Load execution only on invocation; the runtime rereads selection and checks live authority.
      const { evaluateDecision, evaluateDecisionV2 } = await import("../../decisions/runtime.js");
      operationSignal.throwIfAborted();
      const currentConfig = getRuntimeConfig();
      const currentSelection = resolveDecisionModelSetting(currentConfig, agentId);
      const currentCapabilities =
        currentSelection &&
        models.find(
          (model) =>
            model.provider === currentSelection.provider && model.id === currentSelection.model,
        )?.capabilities;
      const evaluationOptions = {
        agentId,
        purpose: "decision_evaluate",
        rubricVersion: rubricVersion(request.batch, request.version),
        timeoutMs: 30_000,
        signal: operationSignal,
      };
      const outcome =
        request.version === 2
          ? await evaluateDecisionV2(request.batch, {
              ...evaluationOptions,
              ...(request.reasoning ? { reasoning: request.reasoning } : {}),
            })
          : await evaluateDecision(request.batch, evaluationOptions);

      operationSignal.throwIfAborted();
      return decisionToolResult(outcome, currentCapabilities);
    },
  };
}
