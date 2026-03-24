import { listAllAgentEntries } from "../agents/agent-scope.js";
import { writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { findAgentEntryIndex } from "./agents.config.js";

type AgentsEnableOptions = {
  id: string;
  json?: boolean;
};

export async function agentsEnableCommand(
  opts: AgentsEnableOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const input = opts.id?.trim();
  if (!input) {
    runtime.error("Agent id is required.");
    runtime.exit(1);
    return;
  }

  const agentId = normalizeAgentId(input);
  if (agentId !== input) {
    runtime.log(`Normalized agent id to "${agentId}".`);
  }

  const allAgents = listAllAgentEntries(cfg);
  const index = findAgentEntryIndex(allAgents, agentId);
  if (index < 0) {
    runtime.error(`Agent "${agentId}" not found.`);
    runtime.exit(1);
    return;
  }

  const entry = allAgents[index];
  if (entry.enabled !== false) {
    runtime.log(`Agent "${agentId}" is already enabled.`);
    return;
  }

  // Remove the enabled field entirely (defaults to active)
  const { enabled: _, ...rest } = entry;
  const nextList = [...allAgents];
  nextList[index] = rest;

  const nextConfig: typeof cfg = {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: nextList,
    },
  };
  await writeConfigFile(nextConfig);
  logConfigUpdated(runtime);

  if (opts.json) {
    writeRuntimeJson(runtime, { agentId, enabled: true });
  } else {
    runtime.log(`Enabled agent: ${agentId}`);
    runtime.log("Restart the gateway for changes to take effect.");
  }
}
