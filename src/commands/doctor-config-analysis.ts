/** Doctor analysis helpers for config schema cleanup and ambiguous model fallback shapes. */
import path from "node:path";
import { resolvePrimaryStringValue } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  listAgentEntries,
  listAgentEntriesWithSource,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { CONFIG_PATH } from "../config/config.js";
import { INCLUDE_KEY } from "../config/includes.js";
import { logConfigWarningsOnce } from "../config/io.warnings.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import { isPathInside } from "../infra/path-guards.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveCliModelEntry } from "../media-understanding/resolve.js";
import { isRecord } from "../utils.js";
import { sanitizeDoctorNote } from "./doctor/emit-notes.js";

const configLog = createSubsystemLogger("config");

export function noteMediaCliModelWarnings(cfg: OpenClawConfig): void {
  const models = cfg.tools?.media?.models;
  if (!Array.isArray(models)) {
    return;
  }
  const warnings: string[] = [];
  models.forEach((entry, index) => {
    if (!entry || (entry.type ?? (entry.command ? "cli" : "provider")) !== "cli") {
      return;
    }
    const resolved = resolveCliModelEntry(entry);
    if (!resolved.ok) {
      const field = resolved.error.reason === "cli-missing-command" ? "command" : "args";
      warnings.push(
        `- tools.media.models[${index}].${field}: Invalid CLI media model. ${resolved.error.message} Doctor cannot choose a command or attachment arguments; edit this entry.`,
      );
    }
  });
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
}

export function noteDoctorConfigPreflightIssues(
  snapshot: ConfigFileSnapshot,
  options: { invalidConfigNote?: string | false; activeRepair: boolean },
): void {
  const invalidConfigNote =
    options.invalidConfigNote ?? "Config invalid; doctor will run with best-effort config.";
  if (
    invalidConfigNote &&
    snapshot.exists &&
    !snapshot.valid &&
    !options.activeRepair &&
    snapshot.legacyIssues.length === 0
  ) {
    note(invalidConfigNote, "Config");
    noteIncludeConfinementWarning(snapshot);
  }
  const warnings = snapshot.warnings ?? [];
  if (warnings.length > 0) {
    // Non-interactive Gateway stdout is a log stream; preserve its structured logging contract.
    if (process.stdout.isTTY) {
      note(formatConfigIssueLines(warnings, "-").join("\n"), "Config warnings");
    } else {
      logConfigWarningsOnce({ configPath: snapshot.path, warnings, logger: configLog });
    }
  }
}

function collectInvalidHookTransformsDirWarnings(
  cfg: OpenClawConfig,
  configPath: string,
): string[] {
  const transformsDir = cfg.hooks?.transformsDir?.trim();
  if (!transformsDir) {
    return [];
  }
  const configDir = path.dirname(configPath);
  const transformsRoot = path.join(configDir, "hooks", "transforms");
  const resolved = path.isAbsolute(transformsDir)
    ? path.resolve(transformsDir)
    : path.resolve(transformsRoot, transformsDir);
  if (isPathInside(transformsRoot, resolved)) {
    return [];
  }
  return [
    `- hooks.transformsDir: ${transformsDir} is outside ${transformsRoot}. Hook transform modules must live under ${transformsRoot}; move custom transforms there or remove hooks.transformsDir.`,
  ];
}

function collectUnsupportedInternalHookEntryWarnings(cfg: OpenClawConfig): string[] {
  const unsupportedKeysByEntry = Object.entries(cfg.hooks?.internal?.entries ?? {})
    .filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map(([hookKey, entry]) => {
      const unsupportedKeys = ["handler", "module", "extraDirs", "installs"].filter((key) =>
        Object.hasOwn(entry, key),
      );
      return { hookKey, unsupportedKeys };
    })
    .filter(({ unsupportedKeys }) => unsupportedKeys.length > 0);

  return unsupportedKeysByEntry.map(
    ({ hookKey, unsupportedKeys }) =>
      `- hooks.internal.entries.${hookKey}: unsupported loader key${unsupportedKeys.length === 1 ? "" : "s"} ${unsupportedKeys.join(", ")} will not load hook modules. Use bootstrap-extra-files for session bootstrap content, or create a managed/workspace hook directory with HOOK.md + handler.js. Doctor cannot rewrite this automatically because per-hook entry keys are open-ended hook configuration.`,
  );
}

export function noteDoctorHookConfigWarnings(cfg: OpenClawConfig, configPath: string): void {
  const hookTransformsDirWarnings = collectInvalidHookTransformsDirWarnings(cfg, configPath);
  if (hookTransformsDirWarnings.length > 0) {
    note(sanitizeDoctorNote(hookTransformsDirWarnings.join("\n")), "Doctor warnings");
  }
  const unsupportedInternalHookEntryWarnings = collectUnsupportedInternalHookEntryWarnings(cfg);
  if (unsupportedInternalHookEntryWarnings.length > 0) {
    note(sanitizeDoctorNote(unsupportedInternalHookEntryWarnings.join("\n")), "Doctor warnings");
  }
}

export function noteMissingDefaultAgentOwner(cfg: OpenClawConfig): void {
  if (
    cfg.agents?.ownership === "explicit" &&
    listAgentEntries(cfg).length > 1 &&
    !tryResolveLegacyCompatibilityAgentId(cfg)
  ) {
    note(
      `No default agent is designated. Set a configured agent with "${formatCliCommand("openclaw config set agents.defaults.systemAgent.agentId <id>")}".`,
      "Agent ownership",
    );
  }
}

/** Formats a parsed config issue path into a user-facing dotted path. */
export function formatConfigKeyPath(parts: Array<string | number>): string {
  if (parts.length === 0) {
    return "<root>";
  }
  let out = "";
  for (const part of parts) {
    if (typeof part === "number") {
      out += `[${part}]`;
      continue;
    }
    out = out ? `${out}.${part}` : part;
  }
  return out || "<root>";
}

/** Resolves a config path against a loose config tree, returning null for invalid traversal. */
export function resolveConfigPathTarget(root: unknown, pathLocal: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of pathLocal) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        return null;
      }
      if (part < 0 || part >= current.length) {
        return null;
      }
      current = current[part];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (!(part in record)) {
      return null;
    }
    current = record[part];
  }
  return current;
}

function isUpdateInProgress(): boolean {
  const value = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  return value === "1" || value === "true";
}

const STRIP_PROTECTED_KEYS: Record<string, Set<string>> = {
  plugins: new Set(["installs"]),
};

/**
 * Removes unknown config keys reported by schema validation, except protected migration keys.
 *
 * Doctor skips this while an update is in progress so partially written upgrade state is not
 * stripped before its migration can finish.
 */
export function stripUnknownConfigKeys(config: OpenClawConfig): {
  config: OpenClawConfig;
  removed: string[];
} {
  if (isUpdateInProgress()) {
    return { config, removed: [] };
  }

  const parsed = OpenClawSchema.safeParse(config);
  if (parsed.success) {
    return { config, removed: [] };
  }

  const next = structuredClone(config);
  const removed: string[] = [];
  for (const issue of parsed.error.issues) {
    if (issue.code !== "unrecognized_keys") {
      continue;
    }
    const issuePath = issue.path.filter((part) => typeof part !== "symbol");
    const target = resolveConfigPathTarget(next, issuePath);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }
    const record = target as Record<string, unknown>;
    const parentKey =
      issuePath.length === 1 && typeof issuePath[0] === "string" ? issuePath[0] : undefined;
    const protectedSet =
      issuePath.length === 0 ? undefined : parentKey ? STRIP_PROTECTED_KEYS[parentKey] : undefined;
    for (const key of issue.keys) {
      if (typeof key !== "string" || !(key in record)) {
        continue;
      }
      // $include is authored parser syntax at every object depth, not a schema field.
      // Doctor validates raw source, so stripping it would destroy include-owned config.
      if (key === INCLUDE_KEY) {
        continue;
      }
      if (protectedSet?.has(key)) {
        continue;
      }
      delete record[key];
      removed.push(formatConfigKeyPath([...issuePath, key]));
    }
  }

  return { config: next, removed };
}

/** Warns when legacy OpenCode overrides shadow an active plugin-provided catalog. */
export function noteOpencodeProviderOverrides(
  cfg: OpenClawConfig,
  options: { opencodePluginActive?: boolean; opencodeGoPluginActive?: boolean } = {},
): void {
  const providers = cfg.models?.providers;
  if (!providers) {
    return;
  }

  const overrides: string[] = [];
  if (options.opencodePluginActive === true && providers.opencode) {
    overrides.push("opencode");
  }
  if (options.opencodePluginActive === true && providers["opencode-zen"]) {
    overrides.push("opencode-zen");
  }
  if (options.opencodeGoPluginActive === true && providers["opencode-go"]) {
    overrides.push("opencode-go");
  }
  if (overrides.length === 0) {
    return;
  }

  const lines = overrides.flatMap((id) => {
    const providerLabel = id === "opencode-go" ? "OpenCode Go" : "OpenCode Zen";
    const providerEntry = providers[id];
    const api =
      isRecord(providerEntry) && typeof providerEntry.api === "string"
        ? providerEntry.api
        : undefined;
    return [
      `- models.providers.${id} is set; this overrides the plugin-provided ${providerLabel} catalog.`,
      api ? `- models.providers.${id}.api=${api}` : null,
    ].filter((line): line is string => Boolean(line));
  });

  lines.push(
    "- Remove these entries to restore per-model API routing + costs (then re-run setup if needed).",
  );
  note(lines.join("\n"), "OpenCode");
}

function isImplicitFallbackClobber(model: unknown): boolean {
  const primary = resolvePrimaryStringValue(model);
  if (typeof model === "string") {
    return primary !== undefined;
  }
  if (model !== null && typeof model === "object" && !Array.isArray(model)) {
    const obj = model as Record<string, unknown>;
    // Object with primary but no fallbacks key — intent is ambiguous; warn.
    // Object with fallbacks: [] — explicit no-fallbacks; no warn.
    return (
      Object.hasOwn(obj, "primary") && !Object.hasOwn(obj, "fallbacks") && primary !== undefined
    );
  }
  return false;
}

/** Collects warnings for agent model shapes that unintentionally drop default fallbacks. */
function collectImplicitFallbackClobberWarnings(cfg: OpenClawConfig): string[] {
  const defaultFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  if (defaultFallbacks.length === 0) {
    return [];
  }
  const warnings: string[] = [];
  for (const { entry: agent, source } of listAgentEntriesWithSource(cfg)) {
    if (!agent || !isImplicitFallbackClobber(agent.model)) {
      continue;
    }
    const id = agent.id?.trim() || (source.kind === "list" ? String(source.index) : source.key);
    const primary = resolvePrimaryStringValue(agent.model);
    const location =
      source.kind === "entries"
        ? `agents.entries.${source.key}.model`
        : `agents.list[${source.index}].model (id=${id})`;
    const modelStr =
      typeof agent.model === "string" ? `"${agent.model}"` : `{ primary: "${primary}" }`;
    const shape =
      typeof agent.model === "string"
        ? "bare string with no fallbacks"
        : 'object with no explicit "fallbacks" key';
    warnings.push(
      [
        `- ${location} is ${modelStr}, a ${shape}. At runtime this clobbers agents.defaults.model.fallbacks (${defaultFallbacks.join(", ")}), leaving the agent with no fallbacks.`,
        `  Fix: add "fallbacks": [...] to inherit or override, or "fallbacks": [] to explicitly disable.`,
      ].join("\n"),
    );
  }
  return warnings;
}

/** Emits doctor notes for model fallback clobber warnings. */
export function noteImplicitFallbackClobberWarnings(cfg: OpenClawConfig): void {
  const warnings = collectImplicitFallbackClobberWarnings(cfg);
  if (warnings.length === 0) {
    return;
  }
  note(warnings.join("\n"), "Doctor warnings");
}

/** Emits a config include warning when an include path escapes the config directory. */
function noteIncludeConfinementWarning(snapshot: {
  path?: string | null;
  issues?: Array<{ message: string }>;
}): void {
  const issues = snapshot.issues ?? [];
  const includeIssue = issues.find(
    (issue) =>
      issue.message.includes("Include path escapes config directory") ||
      issue.message.includes("Include path resolves outside config directory"),
  );
  if (!includeIssue) {
    return;
  }
  const configRoot = path.dirname(snapshot.path ?? CONFIG_PATH);
  note(
    [
      `- $include paths must stay under: ${configRoot}`,
      '- Move shared include files under that directory and update to relative paths like "./shared/common.json".',
      `- Error: ${includeIssue.message}`,
    ].join("\n"),
    "Doctor warnings",
  );
}

/** Warns when a trusted-proxy gateway has no public sandbox origin for widget/MCP-app frames. */
export function noteSandboxOriginProxyWarning(cfg: OpenClawConfig): void {
  // trusted-proxy auth means the Control UI is reached through a reverse proxy
  // or tunnel. Widget and MCP-app frames load from a separate sandbox listener
  // (gateway port + 1); without mcp.apps.sandboxOrigin the browser derives that
  // URL by port substitution, which such proxies do not route, and every
  // pinned widget fails to render.
  if (cfg.gateway?.auth?.mode !== "trusted-proxy" || cfg.mcp?.apps?.sandboxOrigin) {
    return;
  }
  note(
    [
      '- gateway.auth.mode is "trusted-proxy" but mcp.apps.sandboxOrigin is not set.',
      "  Dashboard widgets and MCP apps render from a separate sandbox listener (gateway port + 1). If your proxy or tunnel does not also route that port, widget frames cannot load.",
      "  Check: either route the sandbox port through your proxy, or set mcp.apps.sandboxOrigin to a dedicated public origin routed to the sandbox listener (see docs/cli/mcp/apps.md).",
    ].join("\n"),
    "Doctor warnings",
  );
}

/** Warns when per-requester MCP OAuth cannot build a public callback URL. */
export function noteMcpOriginWarning(cfg: OpenClawConfig): void {
  const hasPerRequesterOAuth = Object.values(cfg.mcp?.servers ?? {}).some(
    (server) => server.oauth?.identity === "per-requester",
  );
  if (!hasPerRequesterOAuth || cfg.gateway?.publicOrigin) {
    return;
  }
  note(
    [
      '- An MCP server uses oauth.identity "per-requester", but gateway.publicOrigin is not set.',
      "  Set gateway.publicOrigin to the externally reachable Gateway origin so senders can complete MCP sign-in.",
    ].join("\n"),
    "Doctor warnings",
  );
}
