import { styleSelectParams } from "../../packages/terminal-core/src/prompt-select-styled-params.js";
import {
  AgentSelectionRequiredError,
  listAgentEntries,
  listAgentIds,
  tryResolveSoleAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { guardCancel } from "./onboard-helpers.js";

export type CliAgentSelectionDeps = {
  interactive?: boolean;
  selectAgent?: (params: {
    message: string;
    options: Array<{ value: string; label: string }>;
  }) => Promise<string>;
};

async function selectAgentWithClack(params: {
  message: string;
  options: Array<{ value: string; label: string }>;
  runtime: RuntimeEnv;
}): Promise<string> {
  const { select } = await import("@clack/prompts");
  return guardCancel(
    await select(styleSelectParams({ message: params.message, options: params.options })),
    params.runtime,
    130,
  ) as string;
}

/** Resolves an explicit/sole CLI agent and prompts only on an interactive multi-agent terminal. */
export async function resolveCliAgentId(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  agentInput?: string;
  surface: string;
  flagName?: string;
  requireExplicit?: boolean;
  deps?: CliAgentSelectionDeps;
}): Promise<string> {
  const explicit = params.agentInput?.trim();
  const agentIds = listAgentIds(params.cfg);
  const soleAgentId = tryResolveSoleAgentId(params.cfg);
  if (explicit) {
    const normalized = normalizeAgentId(explicit);
    if (!agentIds.includes(normalized) && normalized !== soleAgentId) {
      throw new Error(`Unknown agent id "${explicit}". Run "openclaw agents list" to choose one.`);
    }
    return normalized;
  }
  // Sole-agent ownership resolves implicitly regardless of agents.ownership. This mirrors
  // resolveGatewayAgentSelectionState's `sole` projection and selectionRequired=false contract.
  if (soleAgentId && params.requireExplicit !== true) {
    return soleAgentId;
  }
  const flagName = params.flagName ?? "--agent <id>";
  const interactive = params.deps?.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new AgentSelectionRequiredError(agentIds, {
      surface: params.surface,
      hint: `Pass ${flagName} to select one of: ${agentIds.join(", ")}.`,
    });
  }
  const entries = listAgentEntries(params.cfg);
  const options = entries.map((entry) => {
    const id = normalizeAgentId(entry.id);
    return { value: id, label: entry.name?.trim() ? `${entry.name.trim()} (${id})` : id };
  });
  const selectAgent =
    params.deps?.selectAgent ??
    ((selection) => selectAgentWithClack({ ...selection, runtime: params.runtime }));
  return normalizeAgentId(
    await selectAgent({ message: `Select an agent for ${params.surface}`, options }),
  );
}
