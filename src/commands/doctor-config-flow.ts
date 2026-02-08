import type { ZodIssue } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  OpenClawSchema,
  CONFIG_PATH,
  migrateLegacyConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
} from "../config/config.js";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { note } from "../terminal/note.js";
import { resolveHomeDir } from "../utils.js";
import { normalizeLegacyConfigValues } from "./doctor-legacy-config.js";
import { autoMigrateLegacyStateDir } from "./doctor-state-migrations.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

type JsonPathPart = string | number;

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

function formatPath(parts: Array<string | number>): string {
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

function resolvePathTarget(root: unknown, path: Array<string | number>): unknown {
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

type EnvTemplateEntry = {
  path: JsonPathPart[];
  template: string;
  resolved: string;
};

function collectEnvTemplateEntries(
  value: unknown,
  env: NodeJS.ProcessEnv,
  path: JsonPathPart[] = [],
  out: EnvTemplateEntry[] = [],
): EnvTemplateEntry[] {
  if (typeof value === "string") {
    try {
      const resolved = resolveConfigEnvVars(value, env);
      if (typeof resolved === "string" && resolved !== value) {
        out.push({ path, template: value, resolved });
      }
    } catch {
      // If substitution fails for this string, skip it and keep the resolved runtime value.
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectEnvTemplateEntries(item, env, [...path, index], out);
    }
    return out;
  }
  if (!isRecord(value)) {
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    collectEnvTemplateEntries(child, env, [...path, key], out);
  }
  return out;
}

function getValueAtPath(root: unknown, path: JsonPathPart[]): unknown {
  let current = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current) || part < 0 || part >= current.length) {
        return undefined;
      }
      current = current[part];
      continue;
    }
    if (!isRecord(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setValueAtPath(root: unknown, path: JsonPathPart[], value: string): boolean {
  if (path.length === 0) {
    return false;
  }
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index];
    if (typeof part === "number") {
      if (!Array.isArray(current) || part < 0 || part >= current.length) {
        return false;
      }
      current = current[part];
      continue;
    }
    if (!isRecord(current) || !(part in current)) {
      return false;
    }
    current = current[part];
  }
  const leaf = path[path.length - 1];
  if (typeof leaf === "number") {
    if (!Array.isArray(current) || leaf < 0) {
      return false;
    }
    current[leaf] = value;
    return true;
  }
  if (!isRecord(current)) {
    return false;
  }
  current[leaf] = value;
  return true;
}

export function restoreConfigEnvTemplates(params: {
  rawConfig: unknown;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  blockedPaths?: string[];
}): OpenClawConfig {
  const templateEntries = collectEnvTemplateEntries(params.rawConfig, params.env ?? process.env);
  if (templateEntries.length === 0) {
    return params.config;
  }
  const blocked = new Set(params.blockedPaths ?? []);

  const next = structuredClone(params.config);
  for (const entry of templateEntries) {
    if (blocked.has(formatPath(entry.path))) {
      continue;
    }
    const currentValue = getValueAtPath(next, entry.path);
    if (currentValue !== entry.resolved && currentValue !== undefined) {
      continue;
    }
    setValueAtPath(next, entry.path, entry.template);
  }
  return next;
}

function stripUnknownConfigKeys(config: OpenClawConfig): {
  config: OpenClawConfig;
  removed: string[];
} {
  const parsed = OpenClawSchema.safeParse(config);
  if (parsed.success) {
    return { config, removed: [] };
  }

  const next = structuredClone(config);
  const removed: string[] = [];
  for (const issue of parsed.error.issues) {
    if (!isUnrecognizedKeysIssue(issue)) {
      continue;
    }
    const path = normalizeIssuePath(issue.path);
    const target = resolvePathTarget(next, path);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }
    const record = target as Record<string, unknown>;
    for (const key of issue.keys) {
      if (typeof key !== "string") {
        continue;
      }
      if (!(key in record)) {
        continue;
      }
      delete record[key];
      removed.push(formatPath([...path, key]));
    }
  }

  return { config: next, removed };
}

function noteOpencodeProviderOverrides(cfg: OpenClawConfig) {
  const providers = cfg.models?.providers;
  if (!providers) {
    return;
  }

  // 2026-01-10: warn when OpenCode Zen overrides mask built-in routing/costs (8a194b4abc360c6098f157956bb9322576b44d51, 2d105d16f8a099276114173836d46b46cdfbdbae).
  const overrides: string[] = [];
  if (providers.opencode) {
    overrides.push("opencode");
  }
  if (providers["opencode-zen"]) {
    overrides.push("opencode-zen");
  }
  if (overrides.length === 0) {
    return;
  }

  const lines = overrides.flatMap((id) => {
    const providerEntry = providers[id];
    const api =
      isRecord(providerEntry) && typeof providerEntry.api === "string"
        ? providerEntry.api
        : undefined;
    return [
      `- models.providers.${id} is set; this overrides the built-in OpenCode Zen catalog.`,
      api ? `- models.providers.${id}.api=${api}` : null,
    ].filter((line): line is string => Boolean(line));
  });

  lines.push(
    "- Remove these entries to restore per-model API routing + costs (then re-run onboarding if needed).",
  );

  note(lines.join("\n"), "OpenCode Zen");
}

async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetDir = path.join(home, ".openclaw");
  const targetPath = path.join(targetDir, "openclaw.json");
  try {
    await fs.access(targetPath);
    return changes;
  } catch {
    // missing config
  }

  const legacyCandidates = [
    path.join(home, ".clawdbot", "clawdbot.json"),
    path.join(home, ".moltbot", "moltbot.json"),
    path.join(home, ".moldbot", "moldbot.json"),
  ];

  let legacyPath: string | null = null;
  for (const candidate of legacyCandidates) {
    try {
      await fs.access(candidate);
      legacyPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  if (!legacyPath) {
    return changes;
  }

  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch {
    // If it already exists, skip silently.
  }

  return changes;
}

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}) {
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
  if (stateDirResult.changes.length > 0) {
    note(stateDirResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  if (stateDirResult.warnings.length > 0) {
    note(stateDirResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
  }

  const legacyConfigChanges = await maybeMigrateLegacyConfig();
  if (legacyConfigChanges.length > 0) {
    note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }

  let snapshot = await readConfigFileSnapshot();
  const baseCfg = snapshot.config ?? {};
  let cfg: OpenClawConfig = baseCfg;
  let candidate = structuredClone(baseCfg);
  let pendingChanges = false;
  let shouldWriteConfig = false;
  let removedUnknownPaths: string[] = [];
  const fixHints: string[] = [];
  if (snapshot.exists && !snapshot.valid && snapshot.legacyIssues.length === 0) {
    note("Config invalid; doctor will run with best-effort config.", "Config");
  }
  const warnings = snapshot.warnings ?? [];
  if (warnings.length > 0) {
    const lines = warnings.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    note(lines, "Config warnings");
  }

  if (snapshot.legacyIssues.length > 0) {
    note(
      snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"),
      "Legacy config keys detected",
    );
    const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
    if (changes.length > 0) {
      note(changes.join("\n"), "Doctor changes");
    }
    if (migrated) {
      candidate = migrated;
      pendingChanges = pendingChanges || changes.length > 0;
    }
    if (shouldRepair) {
      // Legacy migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into channels.whatsapp.allowFrom.
      if (migrated) {
        cfg = migrated;
      }
    } else {
      fixHints.push(
        `Run "${formatCliCommand("openclaw doctor --fix")}" to apply legacy migrations.`,
      );
    }
  }

  const normalized = normalizeLegacyConfigValues(candidate);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    candidate = normalized.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = normalized.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
    }
  }

  const autoEnable = applyPluginAutoEnable({ config: candidate, env: process.env });
  if (autoEnable.changes.length > 0) {
    note(autoEnable.changes.join("\n"), "Doctor changes");
    candidate = autoEnable.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = autoEnable.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
    }
  }

  const unknown = stripUnknownConfigKeys(candidate);
  if (unknown.removed.length > 0) {
    removedUnknownPaths = unknown.removed;
    const lines = unknown.removed.map((path) => `- ${path}`).join("\n");
    candidate = unknown.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = unknown.config;
      note(lines, "Doctor changes");
    } else {
      note(lines, "Unknown config keys");
      fixHints.push('Run "openclaw doctor --fix" to remove these keys.');
    }
  }

  if (!shouldRepair && pendingChanges) {
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      cfg = candidate;
      shouldWriteConfig = true;
    } else if (fixHints.length > 0) {
      note(fixHints.join("\n"), "Doctor");
    }
  }

  noteOpencodeProviderOverrides(cfg);

  let sourceTemplateConfig: unknown = snapshot.parsed;
  if (
    sourceTemplateConfig === undefined ||
    sourceTemplateConfig === null ||
    typeof sourceTemplateConfig !== "object"
  ) {
    const parsed = typeof snapshot.raw === "string" ? parseConfigJson5(snapshot.raw) : null;
    sourceTemplateConfig = parsed?.ok ? parsed.parsed : {};
  }

  return {
    cfg,
    path: snapshot.path ?? CONFIG_PATH,
    shouldWriteConfig,
    sourceTemplateConfig,
    removedUnknownPaths,
  };
}
