import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { listAgentIds, resolveAgentOperationAgentId } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { isRouteBinding, listRouteBindings } from "../config/bindings.js";
import { replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { AgentRouteBinding } from "../config/types.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { describeBinding, describeBindingConflict } from "./agents.binding-format.js";
import { requireValidConfig, requireValidConfigForWrite } from "./config-validation.js";

type AgentConfig = NonNullable<Awaited<ReturnType<typeof requireValidConfig>>>;

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

function failAgentBinding(message: string): never {
  throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
}

function resolveTargetAgentId(params: {
  cfg: AgentConfig;
  agentInput: string | undefined;
}): string {
  const normalized =
    params.agentInput === undefined ? null : normalizeAgentIdStrict(params.agentInput);
  if (normalized && !normalized.ok) {
    failAgentBinding(
      `Agent "${params.agentInput}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
  }
  const agentId = normalized?.value ?? resolveAgentOperationAgentId(params.cfg);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    failAgentBinding(
      `Agent "${agentId}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
  }
  return agentId;
}

async function resolveParsedBindings(params: {
  cfg: AgentConfig;
  agentId: string;
  bindValues: string[] | undefined;
  emptyMessage: string;
}): Promise<AgentRouteBinding[]> {
  const specs = normalizeStringEntries(params.bindValues);
  if (specs.length === 0) {
    failAgentBinding(params.emptyMessage);
  }

  const { parseBindingSpecs } = await import("./agents.bindings.js");
  const parsed = parseBindingSpecs({ agentId: params.agentId, specs, config: params.cfg });
  if (parsed.errors.length > 0) {
    failAgentBinding(parsed.errors.join("\n"));
  }
  return parsed.bindings;
}

function emitJsonPayload(
  runtime: RuntimeEnv,
  json: boolean | undefined,
  payload: { conflicts: string[] },
): boolean {
  if (!json) {
    return false;
  }
  writeRuntimeJson(runtime, payload);
  if (payload.conflicts.length > 0) {
    runtime.exit(1);
  }
  return true;
}

async function resolveConfigAndTargetAgentId(params: {
  runtime: RuntimeEnv;
  agentInput: string | undefined;
}) {
  const writeSnapshot = await requireValidConfigForWrite(params.runtime);
  if (!writeSnapshot) {
    return null;
  }
  const cfg = writeSnapshot.snapshot.sourceConfig;
  const agentId = resolveTargetAgentId({ cfg, agentInput: params.agentInput });
  return { cfg, agentId, writeSnapshot };
}

export async function agentsBindingsCommand(
  opts: AgentsBindingsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime, { skipPluginValidation: true });
  if (!cfg) {
    return;
  }

  const filterAgentId =
    opts.agent === undefined ? undefined : resolveTargetAgentId({ cfg, agentInput: opts.agent });

  const filtered = listRouteBindings(cfg).filter(
    (binding) => !filterAgentId || normalizeAgentId(binding.agentId) === filterAgentId,
  );
  if (opts.json) {
    writeRuntimeJson(
      runtime,
      filtered.map((binding) => ({
        agentId: normalizeAgentId(binding.agentId),
        match: binding.match,
        description: describeBinding(binding),
      })),
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
      ...filtered.map(
        (binding) => `- ${normalizeAgentId(binding.agentId)} <- ${describeBinding(binding)}`,
      ),
    ].join("\n"),
  );
}

export async function agentsBindCommand(
  opts: AgentsBindOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const resolved = await resolveConfigAndTargetAgentId({
    runtime,
    agentInput: opts.agent,
  });
  if (!resolved) {
    return;
  }
  const { cfg, agentId, writeSnapshot } = resolved;

  const bindings = await resolveParsedBindings({
    cfg,
    agentId,
    bindValues: opts.bind,
    emptyMessage: "Provide at least one --bind <channel[:accountId]>.",
  });

  const { applyAgentBindings } = await import("./agents.bindings.js");
  const result = applyAgentBindings(cfg, bindings);
  if (result.added.length > 0 || result.updated.length > 0) {
    await replaceConfigFile({
      sourceConfig: result.config,
      ...writeSnapshot,
    });
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
  }

  const payload = {
    agentId,
    added: result.added.map(describeBinding),
    updated: result.updated.map(describeBinding),
    skipped: result.skipped.map(describeBinding),
    conflicts: result.conflicts.map(describeBindingConflict),
  };
  if (emitJsonPayload(runtime, opts.json, payload)) {
    return;
  }

  if (result.added.length === 0 && result.updated.length === 0) {
    runtime.log("No new bindings added.");
  }

  for (const [heading, descriptions] of [
    ["Added bindings:", payload.added],
    ["Updated bindings:", payload.updated],
    ["Already present:", payload.skipped],
  ] as const) {
    if (descriptions.length > 0) {
      runtime.log(heading);
      for (const description of descriptions) {
        runtime.log(`- ${description}`);
      }
    }
  }

  if (result.conflicts.length > 0) {
    runtime.error("Skipped bindings already claimed by another agent:");
    for (const conflict of payload.conflicts) {
      runtime.error(`- ${conflict}`);
    }
    runtime.exit(1);
  }
}

export async function agentsUnbindCommand(
  opts: AgentsUnbindOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const resolved = await resolveConfigAndTargetAgentId({
    runtime,
    agentInput: opts.agent,
  });
  if (!resolved) {
    return;
  }
  const { cfg, agentId, writeSnapshot } = resolved;
  if (opts.all && (opts.bind?.length ?? 0) > 0) {
    failAgentBinding("Use either --all or --bind, not both.");
  }

  if (opts.all) {
    const existing = listRouteBindings(cfg);
    const removed = existing.filter((binding) => normalizeAgentId(binding.agentId) === agentId);
    if (removed.length > 0) {
      const keptRoutes = existing.filter(
        (binding) => normalizeAgentId(binding.agentId) !== agentId,
      );
      const nonRoutes = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
      const remaining = [...keptRoutes, ...nonRoutes];
      await replaceConfigFile({
        sourceConfig: { ...cfg, bindings: remaining.length > 0 ? remaining : undefined },
        ...writeSnapshot,
      });
      if (!opts.json) {
        logConfigUpdated(runtime);
      }
    }
    const payload = {
      agentId,
      removed: removed.map(describeBinding),
      missing: [] as string[],
      conflicts: [] as string[],
    };
    if (emitJsonPayload(runtime, opts.json, payload)) {
      return;
    }
    runtime.log(
      removed.length > 0
        ? `Removed ${removed.length} binding(s) for "${agentId}".`
        : `No bindings to remove for agent "${agentId}".`,
    );
    return;
  }

  const bindings = await resolveParsedBindings({
    cfg,
    agentId,
    bindValues: opts.bind,
    emptyMessage: "Provide at least one --bind <channel[:accountId]> or use --all.",
  });

  const { removeAgentBindings } = await import("./agents.bindings.js");
  const result = removeAgentBindings(cfg, bindings);
  if (result.removed.length > 0) {
    await replaceConfigFile({
      sourceConfig: result.config,
      ...writeSnapshot,
    });
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
  }

  const payload = {
    agentId,
    removed: result.removed.map(describeBinding),
    missing: result.missing.map(describeBinding),
    conflicts: result.conflicts.map(describeBindingConflict),
  };
  if (emitJsonPayload(runtime, opts.json, payload)) {
    return;
  }

  if (result.removed.length === 0) {
    runtime.log("No bindings removed.");
  }
  for (const [heading, descriptions] of [
    ["Removed bindings:", payload.removed],
    ["Not found:", payload.missing],
  ] as const) {
    if (descriptions.length > 0) {
      runtime.log(heading);
      for (const description of descriptions) {
        runtime.log(`- ${description}`);
      }
    }
  }
  if (result.conflicts.length > 0) {
    runtime.error("Bindings are owned by another agent:");
    for (const conflict of payload.conflicts) {
      runtime.error(`- ${conflict}`);
    }
    runtime.exit(1);
  }
}
