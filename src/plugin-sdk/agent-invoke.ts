import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginAgentInvokeOptions, PluginAgentInvokeResult } from "../plugins/types.js";

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type { PluginAgentInvokeOptions as AgentInvokeOptions };
export type { PluginAgentInvokeResult as AgentInvokeResult };

export async function invokeAgent(
  _runtime: PluginRuntime,
  _opts: PluginAgentInvokeOptions,
): Promise<PluginAgentInvokeResult> {
  throw new Error(
    "invokeAgent is implemented in the plugin registry and accessed via api.invokeAgent",
  );
}

export async function invokeAgentStream(
  _runtime: PluginRuntime,
  _opts: PluginAgentInvokeOptions,
): Promise<ReadableStream<Uint8Array>> {
  throw new Error(
    "invokeAgentStream is implemented in the plugin registry and accessed via api.invokeAgentStream",
  );
}
