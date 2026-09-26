import { getRuntimeConfig } from "../../config/config.js";
import { CORE_DECISION_TASK_ID } from "../../decisions/task-ids.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { listAvailableManifestContractPlugins } from "../../plugins/manifest-contract-eligibility.js";
import { resolveDecisionModelSetting } from "../decision-model-setting.js";
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
  const selected = resolveDecisionModelSetting(config, agentId, CORE_DECISION_TASK_ID);
  if (!agentId.trim() || !selected) {
    return null;
  }
  // Prepared declarations follow the existing tool/context refresh lifecycle.
  const snapshot =
    options?.preparedModelRuntime?.metadataSnapshot ?? getGatewayPluginMetadataSnapshot();
  const models =
    snapshot && config.plugins?.enabled !== false
      ? listAvailableManifestContractPlugins({
          snapshot,
          config,
          contract: "decisionProviders",
        }).flatMap((plugin) => plugin.decisionModels ?? [])
      : [];
  const capabilities = models.find(
    (model) => model.provider === selected.provider && model.id === selected.model,
  )?.capabilities;
  return {
    name: "decision_evaluate",
    label: "Decision evaluation",
    description:
      "Evaluate only supplied state with this agent's selected decision model. Ask independent boolean (probabilityTrue, not a thresholded answer), choice (competing alternatives), or score (fractional zero-based rubric position) questions. Instructions and criteria accept text, JSON objects/arrays, or null. Preserve distributions and optional provider-specific confidence/usage; confidence is not demonstrated accuracy. Dependent questions require another call with the previous result explicitly supplied. Sends no ambient conversation or files. Hosted providers may charge. Results never authorize actions." +
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
      const { evaluateDecision } = await import("../../decisions/runtime.js");
      operationSignal.throwIfAborted();
      const currentConfig = getRuntimeConfig();
      const currentSelection = resolveDecisionModelSetting(
        currentConfig,
        agentId,
        CORE_DECISION_TASK_ID,
      );
      const currentCapabilities =
        currentSelection &&
        models.find(
          (model) =>
            model.provider === currentSelection.provider && model.id === currentSelection.model,
        )?.capabilities;
      const outcome = await evaluateDecision(batch, {
        agentId,
        taskId: CORE_DECISION_TASK_ID,
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
