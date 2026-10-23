import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { captureMemoryExactSessionReader } from "../config/sessions/session-accessor.memory-exact-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";

/** Read plugin ownership from the memory actor or the durable worker. */
export function createPluginSessionOwnershipReads({
  runtime,
  currentSessionConfig,
  assertRuntimeOwnerCurrent,
}: {
  runtime: PluginRuntime;
  currentSessionConfig: () => OpenClawConfig;
  assertRuntimeOwnerCurrent: () => void;
}) {
  const readOwnershipEntry = async (
    params: Parameters<PluginRuntime["agent"]["session"]["getSessionEntryAsync"]>[0],
  ) => {
    const memory = captureMemoryExactSessionReader(params, assertRuntimeOwnerCurrent);
    if (memory) {
      return memory.read(params.sessionKey);
    }
    const entry = await runtime.agent.session.getSessionEntryAsync(params);
    assertRuntimeOwnerCurrent();
    return entry;
  };
  const listOwnershipEntries = async (params: { agentId?: string; storePath?: string }) => {
    const memory = captureMemoryExactSessionReader(params, assertRuntimeOwnerCurrent);
    if (memory) {
      return memory.entries("list");
    }
    const selectedAgentId = params.agentId ?? resolveDefaultAgentId(currentSessionConfig());
    const entries = await runtime.agent.session.listSessionEntriesAsync({
      ...params,
      agentId: selectedAgentId,
    });
    assertRuntimeOwnerCurrent();
    return entries;
  };
  return { readOwnershipEntry, listOwnershipEntries };
}
