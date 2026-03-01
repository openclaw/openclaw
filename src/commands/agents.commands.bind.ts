import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { AgentBinding } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  applyAgentBindings,
  describeBinding,
  parseBindingSpecs,
  removeAgentBindings,
} from "./agents.bindings.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { buildAgentSummaries } from "./agents.config.js";

type AgentsBindingsListOptions = {
  agent?: string;
  json?: boolean;
};

type AgentsBindOptions = {
  agent?: string;
  bind?: string[];
  json?: boolean;
};

type AgentsUnbindOptions = {
  agent?: string;
  bind?: string[];
  all?: boolean;
  json?: boolean;
};

function resolveAgentId(
  cfg: Awaited<ReturnType<typeof requireValidConfig>>,
  agentInput: string | undefined,
  params?: { fallbackToDefault?: boolean },
): string | null {
  if (!cfg) {
    return null;
  }
  if (agentInput?.trim()) {
    return normalizeAgentId(agentInput);
  }
  if (params?.fallbackToDefault) {
    return resolveDefaultAgentId(cfg);
  }
  return null;
}

function hasAgent(cfg: Awaited<ReturnType<typeof requireValidConfig>>, agentId: string): boolean {
  if (!cfg) {
    return false;
  }
  return buildAgentSummaries(cfg).some((summary) => summary.id === agentId);
}

function formatBindingOwnerLine(binding: AgentBinding): string {
  return `${normalizeAgentId(binding.agentId)} <- ${describeBinding(binding)}`;
}

export async function agentsBindingsCommand(
  opts: AgentsBindingsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const filterAgentId = resolveAgentId(cfg, opts.agent?.trim());
  if (opts.agent && !filterAgentId) {
    runtime.error("Agent id is required.");
    runtime.exit(1);
    return;
  }
  if (filterAgentId && !hasAgent(cfg, filterAgentId)) {
    runtime.error(`Agent "${filterAgentId}" not found.`);
    runtime.exit(1);
    return;
  }

  const filtered = (cfg.bindings ?? []).filter(
    (binding) => !filterAgentId || normalizeAgentId(binding.agentId) === filterAgentId,
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        filtered.map((binding) => ({
          agentId: normalizeAgentId(binding.agentId),
          match: binding.match,
          description: describeBinding(binding),
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (filtered.length === 0) {
    runtime.log(
      filterAgentId ? `No routing bindings for agent "${filterAgentId}".` : "No routing bindings.",
    );
    return;
  }

  runtime.log(
    [
      "Routing bindings:",
      ...filtered.map((binding) => `- ${formatBindingOwnerLine(binding)}`),
    ].join("\n"),
  );
}

export async function agentsBindCommand(
  opts: AgentsBindOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const agentId = resolveAgentId(cfg, opts.agent?.trim(), { fallbackToDefault: true });
  if (!agentId) {
    runtime.error("Unable to resolve agent id.");
    runtime.exit(1);
    return;
  }
  if (!hasAgent(cfg, agentId)) {
    runtime.error(`Agent "${agentId}" not found.`);
    runtime.exit(1);
    return;
  }

  const specs = (opts.bind ?? []).map((value) => value.trim()).filter(Boolean);
  if (specs.length === 0) {
    runtime.error("Provide at least one --bind <channel[:accountId]>.");
    runtime.exit(1);
    return;
  }

  const parsed = parseBindingSpecs({ agentId, specs, config: cfg });
  if (parsed.errors.length > 0) {
    runtime.error(parsed.errors.join("\n"));
    runtime.exit(1);
    return;
  }

  const result = applyAgentBindings(cfg, parsed.bindings);
  if (result.added.length > 0 || result.updated.length > 0) {
    await writeConfigFile(result.config);
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
  }

  const payload = {
    agentId,
    added: result.added.map(describeBinding),
    updated: result.updated.map(describeBinding),
    skipped: result.skipped.map(describeBinding),
    conflicts: result.conflicts.map(
      (conflict) => `${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
    ),
  };
  if (opts.json) {
    runtime.log(JSON.stringify(payload, null, 2));
    if (result.conflicts.length > 0) {
      runtime.exit(1);
    }
    return;
  }

  if (result.added.length > 0) {
    runtime.log("Added bindings:");
    for (const binding of result.added) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  } else if (result.updated.length === 0) {
    runtime.log("No new bindings added.");
  }

  if (result.updated.length > 0) {
    runtime.log("Updated bindings:");
    for (const binding of result.updated) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  }

  if (result.skipped.length > 0) {
    runtime.log("Already present:");
    for (const binding of result.skipped) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  }

  if (result.conflicts.length > 0) {
    runtime.error("Skipped bindings already claimed by another agent:");
    for (const conflict of result.conflicts) {
      runtime.error(`- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`);
    }
    runtime.exit(1);
  }
}

export async function agentsUnbindCommand(
  opts: AgentsUnbindOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const agentId = resolveAgentId(cfg, opts.agent?.trim(), { fallbackToDefault: true });
  if (!agentId) {
    runtime.error("Unable to resolve agent id.");
    runtime.exit(1);
    return;
  }
  if (!hasAgent(cfg, agentId)) {
    runtime.error(`Agent "${agentId}" not found.`);
    runtime.exit(1);
    return;
  }
  if (opts.all && (opts.bind?.length ?? 0) > 0) {
    runtime.error("Use either --all or --bind, not both.");
    runtime.exit(1);
    return;
  }

  if (opts.all) {
    const existing = cfg.bindings ?? [];
    const removed = existing.filter((binding) => normalizeAgentId(binding.agentId) === agentId);
    const kept = existing.filter((binding) => normalizeAgentId(binding.agentId) !== agentId);
    if (removed.length === 0) {
      runtime.log(`No bindings to remove for agent "${agentId}".`);
      return;
    }
    const next = {
      ...cfg,
      bindings: kept.length > 0 ? kept : undefined,
    };
    await writeConfigFile(next);
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
    const payload = {
      agentId,
      removed: removed.map(describeBinding),
      missing: [] as string[],
      conflicts: [] as string[],
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
      return;
    }
    runtime.log(`Removed ${removed.length} binding(s) for "${agentId}".`);
    return;
  }

  const specs = (opts.bind ?? []).map((value) => value.trim()).filter(Boolean);
  if (specs.length === 0) {
    runtime.error("Provide at least one --bind <channel[:accountId]> or use --all.");
    runtime.exit(1);
    return;
  }

  const parsed = parseBindingSpecs({ agentId, specs, config: cfg });
  if (parsed.errors.length > 0) {
    runtime.error(parsed.errors.join("\n"));
    runtime.exit(1);
    return;
  }

  const result = removeAgentBindings(cfg, parsed.bindings);
  if (result.removed.length > 0) {
    await writeConfigFile(result.config);
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
  }

  const payload = {
    agentId,
    removed: result.removed.map(describeBinding),
    missing: result.missing.map(describeBinding),
    conflicts: result.conflicts.map(
      (conflict) => `${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
    ),
  };
  if (opts.json) {
    runtime.log(JSON.stringify(payload, null, 2));
    if (result.conflicts.length > 0) {
      runtime.exit(1);
    }
    return;
  }

  if (result.removed.length > 0) {
    runtime.log("Removed bindings:");
    for (const binding of result.removed) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  } else {
    runtime.log("No bindings removed.");
  }
  if (result.missing.length > 0) {
    runtime.log("Not found:");
    for (const binding of result.missing) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  }
  if (result.conflicts.length > 0) {
    runtime.error("Bindings are owned by another agent:");
    for (const conflict of result.conflicts) {
      runtime.error(`- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`);
    }
    runtime.exit(1);
  }
}
