import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForSecretsRuntime } from "../agents/auth-profiles.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { resolveStateDir, type OpenClawConfig } from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { createSecretsConfigIO } from "./config-io.js";
import { type SecretsApplyPlan, normalizeSecretsPlanOptions } from "./plan.js";
import { listKnownSecretEnvVarNames } from "./provider-env-vars.js";
import { resolveSecretRefValue } from "./resolve.js";
import { prepareSecretsRuntimeSnapshot } from "./runtime.js";
import { isNonEmptyString, isRecord, writeTextFileAtomic } from "./shared.js";

type FileSnapshot = {
  existed: boolean;
  content: string;
  mode: number;
};

type ApplyWrite = {
  path: string;
  content: string;
  mode: number;
};

type ProjectedState = {
  nextConfig: OpenClawConfig;
  configPath: string;
  configWriteOptions: ConfigWriteOptions;
  authStoreByPath: Map<string, Record<string, unknown>>;
  authJsonByPath: Map<string, Record<string, unknown>>;
  envRawByPath: Map<string, string>;
  changedFiles: Set<string>;
  warnings: string[];
};

export type SecretsApplyResult = {
  mode: "dry-run" | "write";
  changed: boolean;
  changedFiles: string[];
  warningCount: number;
  warnings: string[];
};

function parseDotPath(pathname: string): string[] {
  return pathname.split(".").filter(Boolean);
}

function getByDotPath(root: unknown, pathLabel: string): unknown {
  const segments = parseDotPath(pathLabel);
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function setByDotPath(root: OpenClawConfig, pathLabel: string, value: unknown): void {
  const segments = parseDotPath(pathLabel);
  if (segments.length === 0) {
    throw new Error("Target path is empty.");
  }
  let cursor: Record<string, unknown> = root as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!isRecord(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

function deleteByDotPath(root: OpenClawConfig, pathLabel: string): void {
  const segments = parseDotPath(pathLabel);
  if (segments.length === 0) {
    return;
  }
  let cursor: Record<string, unknown> = root as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!isRecord(existing)) {
      return;
    }
    cursor = existing;
  }
  delete cursor[segments[segments.length - 1]];
}

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scrubEnvRaw(
  raw: string,
  migratedValues: Set<string>,
  allowedEnvKeys: Set<string>,
): {
  nextRaw: string;
  removed: number;
} {
  if (migratedValues.size === 0 || allowedEnvKeys.size === 0) {
    return { nextRaw: raw, removed: 0 };
  }
  const lines = raw.split(/\r?\n/);
  const nextLines: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      nextLines.push(line);
      continue;
    }
    const envKey = match[1] ?? "";
    if (!allowedEnvKeys.has(envKey)) {
      nextLines.push(line);
      continue;
    }
    const parsedValue = parseEnvValue(match[2] ?? "");
    if (migratedValues.has(parsedValue)) {
      removed += 1;
      continue;
    }
    nextLines.push(line);
  }
  const hadTrailingNewline = raw.endsWith("\n");
  const joined = nextLines.join("\n");
  return {
    nextRaw:
      hadTrailingNewline || joined.length === 0
        ? `${joined}${joined.endsWith("\n") ? "" : "\n"}`
        : joined,
    removed,
  };
}

function collectAuthStorePaths(config: OpenClawConfig, stateDir: string): string[] {
  const paths = new Set<string>();
  paths.add(resolveUserPath(resolveAuthStorePath()));

  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      paths.add(path.join(agentsRoot, entry.name, "agent", "auth-profiles.json"));
    }
  }

  for (const agentId of listAgentIds(config)) {
    const agentDir = resolveAgentDir(config, agentId);
    paths.add(resolveUserPath(resolveAuthStorePath(agentDir)));
  }

  return [...paths];
}

function collectAuthJsonPaths(stateDir: string): string[] {
  const out: string[] = [];
  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (!fs.existsSync(agentsRoot)) {
    return out;
  }
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(agentsRoot, entry.name, "agent", "auth.json");
    if (fs.existsSync(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

function resolveGoogleChatRefPath(pathLabel: string): string {
  if (pathLabel.endsWith(".serviceAccount")) {
    return `${pathLabel}Ref`;
  }
  throw new Error(`Google Chat target path must end with ".serviceAccount": ${pathLabel}`);
}

async function projectPlanState(params: {
  plan: SecretsApplyPlan;
  env: NodeJS.ProcessEnv;
}): Promise<ProjectedState> {
  const io = createSecretsConfigIO({ env: params.env });
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Cannot apply secrets plan: config is invalid.");
  }
  const options = normalizeSecretsPlanOptions(params.plan.options);
  const nextConfig = structuredClone(snapshot.config);
  const stateDir = resolveStateDir(params.env, os.homedir);
  const changedFiles = new Set<string>();
  const warnings: string[] = [];
  const scrubbedValues = new Set<string>();
  const providerTargets = new Set<string>();

  for (const target of params.plan.targets) {
    if (target.type === "channels.googlechat.serviceAccount") {
      const previous = getByDotPath(nextConfig, target.path);
      if (isNonEmptyString(previous)) {
        scrubbedValues.add(previous.trim());
      }
      const refPath = resolveGoogleChatRefPath(target.path);
      setByDotPath(nextConfig, refPath, target.ref);
      deleteByDotPath(nextConfig, target.path);
      changedFiles.add(resolveUserPath(snapshot.path));
      continue;
    }

    const previous = getByDotPath(nextConfig, target.path);
    if (isNonEmptyString(previous)) {
      scrubbedValues.add(previous.trim());
    }
    setByDotPath(nextConfig, target.path, target.ref);
    changedFiles.add(resolveUserPath(snapshot.path));
    if (target.type === "models.providers.apiKey" && target.providerId) {
      providerTargets.add(normalizeProviderId(target.providerId));
    }
  }

  const authStoreByPath = new Map<string, Record<string, unknown>>();
  if (options.scrubAuthProfilesForProviderTargets && providerTargets.size > 0) {
    for (const authStorePath of collectAuthStorePaths(nextConfig, stateDir)) {
      if (!fs.existsSync(authStorePath)) {
        continue;
      }
      const raw = fs.readFileSync(authStorePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.profiles)) {
        continue;
      }
      const nextStore = structuredClone(parsed) as Record<string, unknown> & {
        profiles: Record<string, unknown>;
      };
      let mutated = false;
      for (const profileValue of Object.values(nextStore.profiles)) {
        if (!isRecord(profileValue) || !isNonEmptyString(profileValue.provider)) {
          continue;
        }
        const provider = normalizeProviderId(String(profileValue.provider));
        if (!providerTargets.has(provider)) {
          continue;
        }
        if (profileValue.type === "api_key") {
          if (isNonEmptyString(profileValue.key)) {
            scrubbedValues.add(profileValue.key.trim());
          }
          if ("key" in profileValue) {
            delete profileValue.key;
            mutated = true;
          }
          if ("keyRef" in profileValue) {
            delete profileValue.keyRef;
            mutated = true;
          }
          continue;
        }
        if (profileValue.type === "token") {
          if (isNonEmptyString(profileValue.token)) {
            scrubbedValues.add(profileValue.token.trim());
          }
          if ("token" in profileValue) {
            delete profileValue.token;
            mutated = true;
          }
          if ("tokenRef" in profileValue) {
            delete profileValue.tokenRef;
            mutated = true;
          }
          continue;
        }
        if (profileValue.type === "oauth") {
          warnings.push(
            `Provider "${provider}" has OAuth credentials in ${authStorePath}; those still take precedence and are out of scope for static SecretRef migration.`,
          );
        }
      }
      if (mutated) {
        authStoreByPath.set(authStorePath, nextStore);
        changedFiles.add(authStorePath);
      }
    }
  }

  const authJsonByPath = new Map<string, Record<string, unknown>>();
  if (options.scrubLegacyAuthJson) {
    for (const authJsonPath of collectAuthJsonPaths(stateDir)) {
      const raw = fs.readFileSync(authJsonPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      let mutated = false;
      const nextParsed = structuredClone(parsed);
      for (const [providerId, value] of Object.entries(nextParsed)) {
        if (!isRecord(value)) {
          continue;
        }
        if (value.type === "api_key" && isNonEmptyString(value.key)) {
          delete nextParsed[providerId];
          mutated = true;
        }
      }
      if (mutated) {
        authJsonByPath.set(authJsonPath, nextParsed);
        changedFiles.add(authJsonPath);
      }
    }
  }

  const envRawByPath = new Map<string, string>();
  if (options.scrubEnv && scrubbedValues.size > 0) {
    const envPath = path.join(resolveConfigDir(params.env, os.homedir), ".env");
    if (fs.existsSync(envPath)) {
      const current = fs.readFileSync(envPath, "utf8");
      const scrubbed = scrubEnvRaw(current, scrubbedValues, new Set(listKnownSecretEnvVarNames()));
      if (scrubbed.removed > 0 && scrubbed.nextRaw !== current) {
        envRawByPath.set(envPath, scrubbed.nextRaw);
        changedFiles.add(envPath);
      }
    }
  }

  const cache = {};
  for (const target of params.plan.targets) {
    const resolved = await resolveSecretRefValue(target.ref, {
      config: nextConfig,
      env: params.env,
      cache,
    });
    if (target.type === "channels.googlechat.serviceAccount") {
      if (!(isNonEmptyString(resolved) || isRecord(resolved))) {
        throw new Error(
          `Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not string/object.`,
        );
      }
      continue;
    }
    if (!isNonEmptyString(resolved)) {
      throw new Error(
        `Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not a non-empty string.`,
      );
    }
  }

  const authStoreLookup = new Map<string, Record<string, unknown>>();
  for (const [authStorePath, store] of authStoreByPath.entries()) {
    authStoreLookup.set(resolveUserPath(authStorePath), store);
  }
  await prepareSecretsRuntimeSnapshot({
    config: nextConfig,
    env: params.env,
    loadAuthStore: (agentDir?: string) => {
      const storePath = resolveUserPath(resolveAuthStorePath(agentDir));
      const override = authStoreLookup.get(storePath);
      if (override) {
        return structuredClone(override) as unknown as ReturnType<
          typeof loadAuthProfileStoreForSecretsRuntime
        >;
      }
      return loadAuthProfileStoreForSecretsRuntime(agentDir);
    },
  });

  return {
    nextConfig,
    configPath: resolveUserPath(snapshot.path),
    configWriteOptions: writeOptions,
    authStoreByPath,
    authJsonByPath,
    envRawByPath,
    changedFiles,
    warnings,
  };
}

function captureFileSnapshot(pathname: string): FileSnapshot {
  if (!fs.existsSync(pathname)) {
    return { existed: false, content: "", mode: 0o600 };
  }
  const stat = fs.statSync(pathname);
  return {
    existed: true,
    content: fs.readFileSync(pathname, "utf8"),
    mode: stat.mode & 0o777,
  };
}

function restoreFileSnapshot(pathname: string, snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    if (fs.existsSync(pathname)) {
      fs.rmSync(pathname, { force: true });
    }
    return;
  }
  writeTextFileAtomic(pathname, snapshot.content, snapshot.mode || 0o600);
}

function toJsonWrite(pathname: string, value: Record<string, unknown>): ApplyWrite {
  return {
    path: pathname,
    content: `${JSON.stringify(value, null, 2)}\n`,
    mode: 0o600,
  };
}

export async function runSecretsApply(params: {
  plan: SecretsApplyPlan;
  env?: NodeJS.ProcessEnv;
  write?: boolean;
}): Promise<SecretsApplyResult> {
  const env = params.env ?? process.env;
  const projected = await projectPlanState({ plan: params.plan, env });
  const changedFiles = [...projected.changedFiles].toSorted();
  if (!params.write) {
    return {
      mode: "dry-run",
      changed: changedFiles.length > 0,
      changedFiles,
      warningCount: projected.warnings.length,
      warnings: projected.warnings,
    };
  }

  const io = createSecretsConfigIO({ env });
  const snapshots = new Map<string, FileSnapshot>();
  const capture = (pathname: string) => {
    if (!snapshots.has(pathname)) {
      snapshots.set(pathname, captureFileSnapshot(pathname));
    }
  };

  capture(projected.configPath);
  const writes: ApplyWrite[] = [];
  for (const [pathname, value] of projected.authStoreByPath.entries()) {
    capture(pathname);
    writes.push(toJsonWrite(pathname, value));
  }
  for (const [pathname, value] of projected.authJsonByPath.entries()) {
    capture(pathname);
    writes.push(toJsonWrite(pathname, value));
  }
  for (const [pathname, raw] of projected.envRawByPath.entries()) {
    capture(pathname);
    writes.push({
      path: pathname,
      content: raw,
      mode: 0o600,
    });
  }

  try {
    await io.writeConfigFile(projected.nextConfig, projected.configWriteOptions);
    for (const write of writes) {
      writeTextFileAtomic(write.path, write.content, write.mode);
    }
  } catch (err) {
    for (const [pathname, snapshot] of snapshots.entries()) {
      try {
        restoreFileSnapshot(pathname, snapshot);
      } catch {
        // Best effort only; preserve original error.
      }
    }
    throw new Error(`Secrets apply failed: ${String(err)}`, { cause: err });
  }

  return {
    mode: "write",
    changed: changedFiles.length > 0,
    changedFiles,
    warningCount: projected.warnings.length,
    warnings: projected.warnings,
  };
}
