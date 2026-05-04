import path from "node:path";
import type { ZodIssue } from "zod";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { parseModelRef, normalizeProviderId } from "../agents/model-selection.js";
import { CONFIG_PATH } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import { note } from "../terminal/note.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";

type UnrecognizedKeysIssue = ZodIssue & {
  code: "unrecognized_keys";
  keys: PropertyKey[];
};

function normalizeIssuePath(path: PropertyKey[]): Array<string | number> {
  return path.filter((part): part is string | number => typeof part !== "symbol");
}

function isUnrecognizedKeysIssue(issue: ZodIssue): issue is UnrecognizedKeysIssue {
  return issue.code === "unrecognized_keys";
}

function collectActiveProviderIdsFromModelConfig(
  value: unknown,
  defaultProvider: string,
  activeProviders: Set<string>,
): void {
  if (typeof value === "string") {
    const parsed = parseModelRef(value.trim(), defaultProvider);
    if (parsed) {
      activeProviders.add(normalizeProviderId(parsed.provider));
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const primary = normalizeOptionalString(value.primary);
  let nextDefaultProvider = defaultProvider;
  if (primary) {
    const parsedPrimary = parseModelRef(primary, defaultProvider);
    if (parsedPrimary) {
      activeProviders.add(normalizeProviderId(parsedPrimary.provider));
      nextDefaultProvider = parsedPrimary.provider;
    }
  }
  if (Array.isArray(value.fallbacks)) {
    for (const fallback of value.fallbacks) {
      if (typeof fallback !== "string") {
        continue;
      }
      const parsedFallback = parseModelRef(fallback.trim(), nextDefaultProvider);
      if (parsedFallback) {
        activeProviders.add(normalizeProviderId(parsedFallback.provider));
      }
    }
  }
}

function collectActiveProviderIds(cfg: OpenClawConfig): Set<string> {
  const activeProviders = new Set<string>();

  for (const [providerId, provider] of Object.entries(cfg.models?.providers ?? {})) {
    if (hasConfiguredSecretInput((provider as Record<string, unknown>).apiKey)) {
      activeProviders.add(normalizeProviderId(providerId));
    }
  }

  const collectFromAgent = (agent: unknown): void => {
    if (!isRecord(agent)) {
      return;
    }
    for (const key of [
      "model",
      "imageModel",
      "imageGenerationModel",
      "videoGenerationModel",
      "musicGenerationModel",
      "pdfModel",
    ]) {
      collectActiveProviderIdsFromModelConfig(agent[key], DEFAULT_PROVIDER, activeProviders);
    }
    if (isRecord(agent.models)) {
      for (const modelRef of Object.keys(agent.models)) {
        collectActiveProviderIdsFromModelConfig(modelRef, DEFAULT_PROVIDER, activeProviders);
      }
    }
  };

  collectFromAgent(cfg.agents?.defaults);
  for (const entry of cfg.agents?.list ?? []) {
    collectFromAgent(entry);
  }

  return activeProviders;
}

function collectProtectedAuthProfileReasons(cfg: OpenClawConfig): Map<string, string> {
  const protectedProfiles = new Map<string, string>();
  const activeProviders = collectActiveProviderIds(cfg);
  const authProfiles = cfg.auth?.profiles;
  if (!authProfiles) {
    return protectedProfiles;
  }

  for (const [provider, profileIds] of Object.entries(cfg.auth?.order ?? {})) {
    for (const profileId of profileIds) {
      if (!protectedProfiles.has(profileId)) {
        protectedProfiles.set(profileId, `referenced by auth.order.${provider}`);
      }
    }
  }

  for (const [profileId, profile] of Object.entries(authProfiles)) {
    if (activeProviders.has(normalizeProviderId(profile.provider))) {
      protectedProfiles.set(
        profileId,
        `provider ${profile.provider} is still active via models.providers or model fallbacks`,
      );
    }
  }

  return protectedProfiles;
}

export function formatConfigPath(parts: Array<string | number>): string {
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

export function resolveConfigPathTarget(root: unknown, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of path) {
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

export function stripUnknownConfigKeys(config: OpenClawConfig): {
  config: OpenClawConfig;
  removed: string[];
} {
  const parsed = OpenClawSchema.safeParse(config);
  if (parsed.success) {
    return { config, removed: [] };
  }

  const next = structuredClone(config);
  const removed: string[] = [];
  const warnings = new Map<string, string>();
  const protectedAuthProfiles = collectProtectedAuthProfileReasons(config);
  for (const issue of parsed.error.issues) {
    if (!isUnrecognizedKeysIssue(issue)) {
      continue;
    }
    const issuePath = normalizeIssuePath(issue.path);
    const target = resolveConfigPathTarget(next, issuePath);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }
    const record = target as Record<string, unknown>;
    const authProfileId =
      issuePath[0] === "auth" && issuePath[1] === "profiles" && typeof issuePath[2] === "string"
        ? issuePath[2]
        : undefined;
    const protectedReason = authProfileId ? protectedAuthProfiles.get(authProfileId) : undefined;
    for (const key of issue.keys) {
      if (typeof key !== "string" || !(key in record)) {
        continue;
      }
      if (protectedReason) {
        warnings.set(
          formatConfigPath([...issuePath, key]),
          `- ${formatConfigPath([...issuePath, key])} preserved during doctor repair because ${protectedReason}.`,
        );
        continue;
      }
      delete record[key];
      removed.push(formatConfigPath([...issuePath, key]));
    }
  }

  if (warnings.size > 0) {
    note([...warnings.values()].join("\n"), "Doctor warnings");
  }

  return { config: next, removed };
}

export function noteOpencodeProviderOverrides(cfg: OpenClawConfig): void {
  const providers = cfg.models?.providers;
  if (!providers) {
    return;
  }

  const overrides: string[] = [];
  if (providers.opencode) {
    overrides.push("opencode");
  }
  if (providers["opencode-zen"]) {
    overrides.push("opencode-zen");
  }
  if (providers["opencode-go"]) {
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
      `- models.providers.${id} is set; this overrides the built-in ${providerLabel} catalog.`,
      api ? `- models.providers.${id}.api=${api}` : null,
    ].filter((line): line is string => Boolean(line));
  });

  lines.push(
    "- Remove these entries to restore per-model API routing + costs (then re-run setup if needed).",
  );
  note(lines.join("\n"), "OpenCode");
}

export function noteIncludeConfinementWarning(snapshot: {
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
