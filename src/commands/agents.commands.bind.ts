import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { listAgentIds, resolveAgentOperationAgentId } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { throwExpectedCliError } from "../cli/failure-output.js";
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

type AgentsBindingsUpdateOptions = {
  agent?: string;
  bind?: string[];
  all?: boolean;
  json?: boolean;
};

function resolveTargetAgentId(params: {
  cfg: AgentConfig;
  agentInput: string | undefined;
}): string {
  const normalized =
    params.agentInput === undefined ? null : normalizeAgentIdStrict(params.agentInput);
  if (normalized && !normalized.ok) {
    throwExpectedCliError(
      `Agent "${params.agentInput}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
  }
  const agentId = normalized?.value ?? resolveAgentOperationAgentId(params.cfg);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    throwExpectedCliError(
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
    throwExpectedCliError(params.emptyMessage);
  }

  const { parseBindingSpecs } = await import("./agents.bindings.js");
  const parsed = parseBindingSpecs({ agentId: params.agentId, specs, config: params.cfg });
  if (parsed.errors.length > 0) {
    throwExpectedCliError(parsed.errors.join("\n"));
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

export async function agentsUpdateBindingsCommand(
  operation: "bind" | "unbind",
  opts: AgentsBindingsUpdateOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const resolved = await resolveConfigAndTargetAgentId({ runtime, agentInput: opts.agent });
  if (!resolved) {
    return;
  }
  const { cfg, agentId, writeSnapshot } = resolved;
  if (operation === "unbind" && opts.all && (opts.bind?.length ?? 0) > 0) {
    throwExpectedCliError("Use either --all or --bind, not both.");
  }

  const removeAll = operation === "unbind" && opts.all;
  const binding = operation === "bind";
  let result: ReturnType<
    | (typeof import("./agents.bindings.js"))["applyAgentBindings"]
    | (typeof import("./agents.bindings.js"))["removeAgentBindings"]
  >;
  if (removeAll) {
    const existing = listRouteBindings(cfg);
    const removed = existing.filter((entry) => normalizeAgentId(entry.agentId) === agentId);
    const remaining = [
      ...existing.filter((entry) => normalizeAgentId(entry.agentId) !== agentId),
      ...(cfg.bindings ?? []).filter((entry) => !isRouteBinding(entry)),
    ];
    result = {
      config: { ...cfg, bindings: remaining.length > 0 ? remaining : undefined },
      removed,
      missing: [],
      conflicts: [],
    };
  } else {
    const bindings = await resolveParsedBindings({
      cfg,
      agentId,
      bindValues: opts.bind,
      emptyMessage: binding
        ? "Provide at least one --bind <channel[:accountId]>."
        : "Provide at least one --bind <channel[:accountId]> or use --all.",
    });
    const { applyAgentBindings, removeAgentBindings } = await import("./agents.bindings.js");
    result = binding ? applyAgentBindings(cfg, bindings) : removeAgentBindings(cfg, bindings);
  }
  const changed =
    "added" in result
      ? result.added.length > 0 || result.updated.length > 0
      : result.removed.length > 0;
  if (changed) {
    await replaceConfigFile({ sourceConfig: result.config, ...writeSnapshot });
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
  }

  const payload = {
    agentId,
    ...("added" in result
      ? {
          added: result.added.map(describeBinding),
          updated: result.updated.map(describeBinding),
          skipped: result.skipped.map(describeBinding),
        }
      : {
          removed: result.removed.map(describeBinding),
          missing: result.missing.map(describeBinding),
        }),
    conflicts: result.conflicts.map(describeBindingConflict),
  };
  if (emitJsonPayload(runtime, opts.json, payload)) {
    return;
  }
  if (removeAll && "removed" in payload) {
    runtime.log(
      payload.removed.length > 0
        ? `Removed ${payload.removed.length} binding(s) for "${agentId}".`
        : `No bindings to remove for agent "${agentId}".`,
    );
    return;
  }
  if (!changed) {
    runtime.log(binding ? "No new bindings added." : "No bindings removed.");
  }
  const sections =
    "added" in payload
      ? ([
          ["Added bindings:", payload.added],
          ["Updated bindings:", payload.updated],
          ["Already present:", payload.skipped],
        ] as const)
      : ([
          ["Removed bindings:", payload.removed],
          ["Not found:", payload.missing],
        ] as const);
  for (const [heading, descriptions] of sections) {
    if (descriptions.length > 0) {
      runtime.log(heading);
      for (const description of descriptions) {
        runtime.log(`- ${description}`);
      }
    }
  }
  if (payload.conflicts.length > 0) {
    runtime.error(
      binding
        ? "Skipped bindings already claimed by another agent:"
        : "Bindings are owned by another agent:",
    );
    for (const conflict of payload.conflicts) {
      runtime.error(`- ${conflict}`);
    }
    runtime.exit(1);
  }
}
