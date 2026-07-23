// Lazy runtime boundary for Gateway-owned realtime agent consultation.
import { createRuntimeAgent } from "../plugins/runtime/runtime-agent.js";
import { consultRealtimeVoiceAgent } from "../talk/agent-consult-runtime.js";

const agentRuntime = createRuntimeAgent();

export async function consultTalkManagedAgent(
  params: Omit<Parameters<typeof consultRealtimeVoiceAgent>[0], "agentRuntime">,
) {
  return await consultRealtimeVoiceAgent({ ...params, agentRuntime });
}
