import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import { listRouteBindings } from "../config/bindings.js";
import type { AgentRouteBinding } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson, defaultRuntime } from "../runtime.js";
import {
  evaluateAgentDatabaseAdmissions,
  hasAgentDatabaseAdmissions,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import {
  listAgentProvenance,
  readAgentProvenanceForDisplay,
  type AgentProvenance,
} from "../state/agent-provenance.js";
import { shortenHomePath } from "../utils.js";
import { describeBinding } from "./agents.bindings.js";
import type { AgentSummary } from "./agents.config.js";
import { buildAgentSummaries } from "./agents.config.js";
import {
  buildProviderStatusIndex,
  buildProviderSummaryMetadataIndex,
  listProvidersForAgent,
  summarizeBindings,
} from "./agents.providers.js";
import { requireValidConfig } from "./config-validation.js";

type AgentsListOptions = {
  json?: boolean;
  bindings?: boolean;
  tree?: boolean;
};

function formatSummaryHeader(summary: AgentSummary): string {
  const safe = sanitizeTerminalText;
  const defaultTag = `${summary.isDefault ? " (default)" : ""}${summary.status === "degraded" ? " (degraded)" : ""}`;
  return summary.name && summary.name !== summary.id
    ? `${safe(summary.id)}${defaultTag} (${safe(summary.name)})`
    : `${safe(summary.id)}${defaultTag}`;
}

function formatSummary(summary: AgentSummary) {
  const safe = sanitizeTerminalText;
  const header = formatSummaryHeader(summary);

  const identityParts = [summary.identityEmoji, summary.identityName]
    .filter((part): part is string => Boolean(part))
    .map(safe);
  const identityLine = identityParts.length > 0 ? identityParts.join(" ") : null;
  const identitySource =
    summary.identitySource === "identity"
      ? "IDENTITY.md"
      : summary.identitySource === "config"
        ? "config"
        : null;

  const lines = [`- ${header}`];
  if (summary.admissionRefusal) {
    lines.push(`  Refused: ${safe(summary.admissionRefusal.reason)}`);
    lines.push(`  Repair: ${safe(summary.admissionRefusal.repairHint)}`);
  }
  if (identityLine) {
    lines.push(`  Identity: ${identityLine}${identitySource ? ` (${identitySource})` : ""}`);
  }
  lines.push(`  Workspace: ${safe(shortenHomePath(summary.workspace))}`);
  lines.push(`  Agent dir: ${safe(shortenHomePath(summary.agentDir))}`);
  if (summary.model) {
    lines.push(`  Model: ${safe(summary.model)}`);
  }
  lines.push(`  Routing rules: ${summary.bindings}`);

  if (summary.routes?.length) {
    lines.push(`  Routing: ${summary.routes.map(safe).join(", ")}`);
  }
  for (const [heading, entries] of [
    ["  Providers:", summary.providers],
    ["  Routing rules:", summary.bindingDetails],
  ] as const) {
    if (entries?.length) {
      lines.push(heading);
      for (const entry of entries) {
        lines.push(`    - ${safe(entry)}`);
      }
    }
  }
  return lines.join("\n");
}

function formatAgentTree(summaries: AgentSummary[], provenance: AgentProvenance[]): string[] {
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const provenanceById = new Map(provenance.map((record) => [record.agentId, record]));
  const childrenById = new Map<string, AgentSummary[]>();
  const roots: AgentSummary[] = [];

  for (const summary of summaries) {
    const creatorAgentId = provenanceById.get(summary.id)?.creatorAgentId;
    if (creatorAgentId && creatorAgentId !== summary.id && summaryById.has(creatorAgentId)) {
      const children = childrenById.get(creatorAgentId) ?? [];
      children.push(summary);
      childrenById.set(creatorAgentId, children);
    } else {
      roots.push(summary);
    }
  }

  const lines: string[] = [];
  const visited = new Set<string>();
  const append = (summary: AgentSummary, depth: number): void => {
    if (visited.has(summary.id)) {
      return;
    }
    visited.add(summary.id);
    lines.push(`${"  ".repeat(depth)}- ${formatSummaryHeader(summary)}`);
    for (const child of childrenById.get(summary.id) ?? []) {
      append(child, depth + 1);
    }
  };
  roots.forEach((summary) => append(summary, 0));
  // Corrupt or manually rewritten provenance can form a cycle. Keep every
  // configured agent visible by promoting the first unseen member to a root.
  summaries.forEach((summary) => append(summary, 0));
  return lines;
}

export async function agentsListCommand(
  opts: AgentsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime, { adoptPluginMetadata: true });
  if (!cfg) {
    return;
  }

  if (!hasAgentDatabaseAdmissions()) {
    recordAgentDatabaseAdmissions(await evaluateAgentDatabaseAdmissions(cfg));
  }
  const summaries = await buildAgentSummaries(cfg);
  const provenance = opts.tree ? await listAgentProvenance() : [];
  if (opts.json) {
    const records = await readAgentProvenanceForDisplay(summaries.map((summary) => summary.id));
    const recordsById = new Map(records.map((record) => [record.agentId, record]));
    for (const summary of summaries) {
      const record = recordsById.get(summary.id);
      if (record) {
        summary.createdVia = record.createdVia;
        summary.creatorAgentId = record.creatorAgentId;
        summary.createdAt = record.createdAtMs;
      }
    }
  }
  const bindingMap = new Map<string, AgentRouteBinding[]>();
  for (const binding of listRouteBindings(cfg)) {
    const agentId = normalizeAgentId(binding.agentId);
    const list = bindingMap.get(agentId) ?? [];
    list.push(binding);
    bindingMap.set(agentId, list);
  }

  if (opts.bindings) {
    for (const summary of summaries) {
      const bindings = bindingMap.get(summary.id) ?? [];
      if (bindings.length > 0) {
        summary.bindingDetails = bindings.map((binding) => describeBinding(binding));
      }
    }
  }

  // JSON and tree queries avoid plugin runtime unless --bindings requests provider enrichment.
  const includeProviderDetails = (!opts.json && !opts.tree) || opts.bindings === true;
  const providerStatus = includeProviderDetails ? await buildProviderStatusIndex(cfg) : null;
  const providerMetadata = includeProviderDetails ? buildProviderSummaryMetadataIndex(cfg) : null;

  for (const summary of summaries) {
    const bindings = bindingMap.get(summary.id) ?? [];
    if (includeProviderDetails && providerStatus && providerMetadata) {
      const routes = summarizeBindings(cfg, bindings, providerMetadata);
      if (routes.length > 0) {
        summary.routes = routes;
      } else if (summary.isDefault) {
        summary.routes = ["default (no explicit rules)"];
      }

      const providerLines = listProvidersForAgent({
        summaryIsDefault: summary.isDefault,
        cfg,
        bindings,
        providerStatus,
        providerMetadata,
      });
      if (providerLines.length > 0) {
        summary.providers = providerLines;
      }
    }
  }

  if (opts.json) {
    writeRuntimeJson(runtime, summaries);
    return;
  }

  if (opts.tree) {
    runtime.log(["Agents:", ...formatAgentTree(summaries, provenance)].join("\n"));
    return;
  }

  const lines = ["Agents:", ...summaries.map(formatSummary)];
  lines.push("Routing rules map channel/account/peer to an agent. Use --bindings for full rules.");
  lines.push(
    `Channel status reflects local config/creds. For live health: ${formatCliCommand("openclaw channels status --probe")}.`,
  );
  runtime.log(lines.join("\n"));
}
