import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import { buildSubagentSpawnEnvelope } from "./subagent-system-prompt.js";

const STRUCTURED_OUTPUT_INSTRUCTION =
  'Call structured_output with {"result": <your final result>} until one payload is accepted, with at most one retry after a rejected attempt. The result value must match the requested JSON Schema. Do not call structured_output again after acceptance.';

/** One resolved native spawn's model-facing envelope and child system prompt. */
export function buildSubagentChildPrompt(params: {
  envelope: Omit<
    Parameters<typeof buildSubagentSpawnEnvelope>[0],
    "acpEnabled" | "nativeCommandGuidanceLines"
  >;
  config: OpenClawConfig;
  sandboxed: boolean;
  structuredOutput: boolean;
  /** Adds the captured plugin profile's instructions to the envelope rules. */
  applyProfile: (systemPrompt: string) => string;
}) {
  const envelope = buildSubagentSpawnEnvelope({
    ...params.envelope,
    acpEnabled: isAcpRuntimeSpawnAvailable({ config: params.config, sandboxed: params.sandboxed }),
    nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({ surface: "subagent" }),
  });
  const systemPrompt = params.applyProfile(envelope.systemPrompt);
  return {
    envelope,
    systemPrompt: params.structuredOutput
      ? `${systemPrompt}\n\n${STRUCTURED_OUTPUT_INSTRUCTION}`
      : systemPrompt,
  };
}
