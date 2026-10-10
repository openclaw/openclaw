import { getRuntimeConfig } from "../../config/config.js";
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
  parseDecisionEvaluateToolInput,
  rubricVersion,
} from "./decision-tool-contract.js";
import { loadDecisionImages } from "./decision-tool.images.js";
import type { MediaToolSandbox } from "./media-tool-shared.js";

/** Bind a conditional core tool to its trusted agent; provider health never changes eligibility. */
export function createDecisionTool(
  agentId: string,
  options?: Pick<
    OpenClawToolsOptions,
    "config" | "preparedModelRuntime" | "workspaceDir" | "cwd" | "fsPolicy"
  > & { sandbox?: MediaToolSandbox },
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
    snapshot && config.plugins?.enabled !== false
      ? listAvailableManifestContractPlugins({
          snapshot,
          config,
          contract: "decisionProviders",
        }).flatMap((plugin) => plugin.decisionModels ?? [])
      : [];
  const resolveCapabilities = (selection: ReturnType<typeof resolveDecisionModelSetting>) =>
    selection &&
    models.find((model) => model.provider === selection.provider && model.id === selection.model)
      ?.capabilities;
  const capabilities = resolveCapabilities(selected);
  return {
    name: "decision_evaluate",
    label: "Decision evaluation",
    description:
      "Evaluate only supplied state with this agent's selected decision model. Ask independent boolean (probabilityTrue, not a thresholded answer), choice (competing alternatives), or score (fractional zero-based rubric position) questions. Instructions and criteria accept text, JSON objects/arrays, or null. Image-capable selected models may also inspect explicit local image paths; images are sent only to that selected provider. Preserve distributions and optional provider-specific confidence/usage; confidence is not demonstrated accuracy. Dependent questions require another call with the previous result explicitly supplied. Sends no ambient conversation or unreferenced files. Hosted providers may charge. Results never authorize actions." +
      (capabilities
        ? ` ${capabilityGuidance(capabilities)}`
        : " Provider limits are undeclared; use concise evidence and explicit true/false descriptions."),
    parameters: DecisionEvaluateInput,
    outputSchema: DecisionEvaluateOutput,
    resultContentSource: "network",
    async execute(_id, params, signal) {
      const operationSignal = signal ?? new AbortController().signal;
      operationSignal.throwIfAborted();
      const { batch, imageRefs } = parseDecisionEvaluateToolInput(params);
      if (!batch) {
        // Host bounds are independent of the provider selected after this definition was built.
        return decisionToolResult({ status: "unavailable", reason: "unsupported-input" });
      }
      // Load execution only on invocation; the runtime rereads selection and checks live authority.
      const { evaluateDecisionForTool } = await import("../../decisions/runtime.js");
      operationSignal.throwIfAborted();
      const currentConfig = getRuntimeConfig();
      const currentSelection = resolveDecisionModelSetting(currentConfig, agentId);
      const currentCapabilities = resolveCapabilities(currentSelection);
      if (imageRefs.length && !currentCapabilities?.inputModalities?.includes("image")) {
        return decisionToolResult({ status: "unavailable", reason: "unsupported-input" });
      }
      const images = imageRefs.length
        ? await loadDecisionImages({
            paths: imageRefs,
            workspaceDir: options?.workspaceDir,
            cwd: options?.cwd,
            fsPolicy: options?.fsPolicy,
            sandbox: options?.sandbox,
            signal: operationSignal,
          })
        : undefined;
      const outcome = await evaluateDecisionForTool(
        images ? { ...batch, images } : batch,
        {
          agentId,
          purpose: "decision_evaluate",
          rubricVersion: rubricVersion(batch),
          timeoutMs: 30_000,
          signal: operationSignal,
        },
        currentSelection ?? null,
      );
      operationSignal.throwIfAborted();
      return decisionToolResult(outcome, currentCapabilities);
    },
  };
}
