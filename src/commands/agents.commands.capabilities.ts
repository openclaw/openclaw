import fs from "node:fs";
import path from "node:path";
import { resolvePrimaryStringValue } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  buildFleetCapabilityContract,
  type CapabilityCheck,
  type CapabilityStatus,
  type FleetCapabilityContract,
  type FleetServiceInput,
  type ProfileCapabilityInput,
} from "../agents/fleet-capability-contract.js";
import { renderFleetCapabilityMarkdown } from "../agents/fleet-capability-contract.markdown.js";
import { resolveUsableCustomProviderApiKey } from "../agents/model-auth.js";
import { resolveSubagentSpawnModelSelection } from "../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath } from "../cron/store.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveProviderAuthEnvVarCandidates } from "../secrets/provider-env-vars.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveConfigDir } from "../utils.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { listAgentEntries } from "./agents.config.js";

export type AgentsCapabilitiesOptions = {
  json?: boolean;
  markdown?: boolean;
  agent?: string;
};

const STATUS_ICON: Record<CapabilityStatus, string> = {
  green: "[OK]",
  yellow: "[WARN]",
  red: "[FAIL]",
};

/** Derive a provider id from a model string prefix (e.g. "anthropic/claude" -> "anthropic"). */
function deriveProvider(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  const colon = trimmed.indexOf(":");
  const sep = slash === -1 ? colon : colon === -1 ? slash : Math.min(slash, colon);
  if (sep <= 0) {
    return undefined;
  }
  return trimmed.slice(0, sep).trim().toLowerCase() || undefined;
}

/** True when the named env var is set to a non-empty value. Never reads the value out. */
function envVarPresent(name: string, env: NodeJS.ProcessEnv): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read-only credential presence probe.
 *
 * Mirrors the auth-source model used by `openclaw models list` status:
 * a provider counts as credentialed when ANY of these are present —
 *   1. a provider auth env var,
 *   2. a usable entry in the agent's auth profile store (OAuth / static
 *      token / api_key profiles, incl. configured aws-sdk profiles),
 *   3. a config-backed custom-provider api key.
 * Returns a boolean only; it never reads, returns, logs, or renders the
 * underlying secret value.
 */
function makeProviderCredentialProbe(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  store: AuthProfileStore | undefined,
): (provider?: string) => boolean {
  const candidates = resolveProviderAuthEnvVarCandidates();
  return (provider?: string): boolean => {
    if (!provider) {
      return false;
    }
    const canonical = resolveProviderIdForAuth(provider);
    const names = candidates[canonical] ?? candidates[provider] ?? [];
    if (names.some((name) => envVarPresent(name, env))) {
      return true;
    }
    if (store) {
      try {
        if (resolveAuthProfileOrder({ cfg, store, provider }).length > 0) {
          return true;
        }
      } catch {
        // best-effort: a malformed store must not crash the read-only report
      }
    }
    try {
      if (resolveUsableCustomProviderApiKey({ cfg, provider, env })) {
        return true;
      }
    } catch {
      // best-effort: config-backed auth resolution is advisory here
    }
    return false;
  };
}

/** Load an agent's auth profile store read-only; never mutates or syncs external CLIs. */
function loadAuthStoreForAgent(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv,
): AuthProfileStore | undefined {
  try {
    const agentDir = resolveAgentDir(cfg, agentId, env);
    return ensureAuthProfileStoreWithoutExternalProfiles(agentDir, { readOnly: true });
  } catch {
    return undefined;
  }
}

/** Best-effort PATH scan for an executable. Read-only; never executes it. */
function isOnPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  const pathVar = env.PATH ?? env.Path ?? "";
  if (!pathVar) {
    return false;
  }
  const isWin = process.platform === "win32";
  const exts = isWin
    ? [
        "",
        ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((e) => e.trim())
          .filter(Boolean),
      ]
    : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`);
      try {
        if (fs.existsSync(candidate)) {
          return true;
        }
      } catch {
        // best-effort: ignore unreadable PATH entries
      }
    }
  }
  return false;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function gatherServiceInput(env: NodeJS.ProcessEnv): FleetServiceInput {
  let stateDbPresent = false;
  try {
    stateDbPresent = fileExists(resolveOpenClawStateSqlitePath(env));
  } catch {
    stateDbPresent = false;
  }

  let cronStorePresent = false;
  try {
    cronStorePresent =
      fileExists(resolveCronStorePath()) || fileExists(path.join(resolveConfigDir(env), "cron"));
  } catch {
    cronStorePresent = false;
  }

  return {
    gatewayConfigured: false, // filled in by caller (needs cfg)
    stateDbPresent,
    cronStorePresent,
    githubCliPresent: isOnPath("gh", env),
    githubAuthPresent: envVarPresent("GH_TOKEN", env) || envVarPresent("GITHUB_TOKEN", env),
    linearAuthPresent: envVarPresent("LINEAR_API_KEY", env),
    deliveryBridgePresent: isOnPath("rclone", env),
  };
}

function gatherProfileInputs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  filterAgentId?: string,
): ProfileCapabilityInput[] {
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const defaultModel = resolvePrimaryStringValue(cfg.agents?.defaults?.model);
  const entries = listAgentEntries(cfg);
  const wanted = filterAgentId ? normalizeAgentId(filterAgentId) : undefined;

  const source = (entries.length > 0 ? entries : [{ id: defaultAgentId }]).filter((entry) =>
    wanted ? normalizeAgentId(entry.id) === wanted : true,
  );

  return source.map((entry): ProfileCapabilityInput => {
    const agentId = normalizeAgentId(entry.id);
    const store = loadAuthStoreForAgent(cfg, agentId, env);
    const credsPresent = makeProviderCredentialProbe(cfg, env, store);
    const model = resolvePrimaryStringValue(entry.model) ?? defaultModel;
    const provider = deriveProvider(model);
    const tools = entry.tools;
    const allow = tools?.allow ?? [];
    const alsoAllow = tools?.alsoAllow ?? [];
    const deny = tools?.deny ?? [];
    const toolsConfigured = Boolean(tools?.profile) || allow.length > 0 || alsoAllow.length > 0;
    // Resolve the subagent model through the EXACT runtime spawn path so the
    // report matches what delegation would actually run. This mirrors
    // resolveSubagentSpawnModelSelection's full behavior: agent subagents.model
    // > agents.defaults.subagents.model > agent/default primary model, with
    // config-defined aliases (e.g. "gpt") resolved to a fully-qualified
    // provider/model string. Runtime always resolves a model for spawning, so
    // delegation is effectively always configured; credentials are then checked
    // for the resolved delegation provider (not the agent's primary).
    const delegationModel = resolveSubagentSpawnModelSelection({ cfg, agentId });
    const delegationConfigured = Boolean(delegationModel && delegationModel.trim());
    const delegationProvider = deriveProvider(delegationModel);
    return {
      agentId,
      name: entry.name?.trim() || undefined,
      isDefault: agentId === defaultAgentId,
      configPresent: entries.length > 0,
      model,
      provider,
      providerCredentialsPresent: credsPresent(provider),
      delegationConfigured,
      delegationModel,
      delegationProvider,
      delegationCredentialsPresent: credsPresent(delegationProvider),
      toolsConfigured,
      toolKeys: [...allow, ...alsoAllow, ...deny],
    };
  });
}

function renderCheckLine(check: CapabilityCheck): string {
  const detail = check.detail ? ` — ${check.detail}` : "";
  return `    ${STATUS_ICON[check.status]} ${check.label} (${check.reason})${detail}`;
}

function renderText(contract: FleetCapabilityContract): string {
  const lines: string[] = [];
  lines.push("Fleet Capability Contract v1");
  lines.push(
    `Rollup: ${STATUS_ICON[contract.rollup.status]} ${contract.rollup.status} ` +
      `(green ${contract.rollup.green}, yellow ${contract.rollup.yellow}, red ${contract.rollup.red})`,
  );
  lines.push(`Generated: ${contract.now}`);
  lines.push("");
  lines.push("Fleet services:");
  for (const check of contract.services) {
    lines.push(renderCheckLine(check));
  }
  lines.push("");
  lines.push("Profiles:");
  if (contract.profiles.length === 0) {
    lines.push("  (no agent profiles configured)");
  }
  for (const profile of contract.profiles) {
    const heading =
      profile.name && profile.name !== profile.agentId
        ? `${profile.agentId} (${profile.name})`
        : profile.agentId;
    const defaultTag = profile.isDefault ? " (default)" : "";
    lines.push(`  ${STATUS_ICON[profile.status]} ${heading}${defaultTag}`);
    for (const check of profile.checks) {
      lines.push(renderCheckLine(check));
    }
  }
  return lines.join("\n");
}

export async function agentsCapabilitiesCommand(
  opts: AgentsCapabilitiesOptions,
  runtime: RuntimeEnv = defaultRuntime,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (opts.json && opts.markdown) {
    runtime.error("Cannot combine --json and --markdown; choose one output format.");
    runtime.exit(1);
    return;
  }

  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const services = gatherServiceInput(env);
  services.gatewayConfigured = Boolean(cfg.gateway);

  const profiles = gatherProfileInputs(cfg, env, opts.agent);

  const contract = buildFleetCapabilityContract({
    now: new Date().toISOString(),
    profiles,
    services,
  });

  if (opts.json) {
    writeRuntimeJson(runtime, contract);
    return;
  }
  if (opts.markdown) {
    runtime.log(renderFleetCapabilityMarkdown(contract));
    return;
  }
  runtime.log(renderText(contract));
}
