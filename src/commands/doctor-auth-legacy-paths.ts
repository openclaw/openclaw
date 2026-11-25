import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { isLegacyOAuthRef } from "../agents/auth-profiles/legacy-oauth-ref.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { resolveLegacyInheritedAuthAgentDir } from "../agents/legacy-inherited-auth-dir.js";
import {
  cloneEnvWithPlatformSemantics,
  createConfigRuntimeEnv,
} from "../config/config-env-vars.js";
import { createConfigIoContext } from "../config/io.context.js";
import {
  coerceConfig,
  parseConfigJson5,
  readConfigFileIfPresent,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
} from "../config/io.read-helpers.js";
import { inspectConfigJsonRootSuffixWithContext } from "../config/io.recovery.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseCandidatePaths } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  createRetiredStateInspectionError,
  listExistingRetiredStateFiles,
} from "../infra/state-migrations.retired-files.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import { resolveUserPath } from "../utils.js";

function resolveLegacyAuthAgentDir(agentDir?: string): string {
  return agentDir ? resolveUserPath(agentDir) : resolveSharedMainAuthAgentDir();
}

export type AuthProfileRepairCandidate = {
  agentDir?: string;
  authPath: string;
};

function listExistingAgentDirsFromState(
  env: NodeJS.ProcessEnv,
  onUnavailable?: (pathname: string) => void,
): string[] {
  const root = path.join(resolveStateDir(env), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      onUnavailable?.(root);
    }
    return [];
  }
  return (
    entries
      // Symlinked state agent dirs must repair like real ones; statSync follows.
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name, "agent"))
      .filter((agentDir) => {
        try {
          const directory = fs.statSync(agentDir).isDirectory();
          if (!directory) {
            onUnavailable?.(agentDir);
          }
          return directory;
        } catch (error) {
          if (!onUnavailable) {
            return false;
          }
          if (!hasErrnoCode(error, "ENOENT")) {
            onUnavailable?.(agentDir);
            return false;
          }
          try {
            fs.lstatSync(agentDir);
            onUnavailable?.(agentDir);
          } catch (missing) {
            if (!hasErrnoCode(missing, "ENOENT")) {
              onUnavailable?.(agentDir);
            } else {
              try {
                fs.statSync(path.dirname(agentDir));
              } catch {
                onUnavailable?.(agentDir);
              }
            }
          }
          return false;
        }
      })
  );
}

function listAuthProfileStoreCandidates(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  onUnavailable?: (pathname: string) => void,
): AuthProfileRepairCandidate[] {
  const candidates = new Map<string, AuthProfileRepairCandidate>();
  const addCandidate = (agentDir: string | undefined): void => {
    // Retain the selected home's expanded directory for later SQLite writes too.
    const resolvedAgentDir = agentDir ? resolveUserPath(agentDir, env) : undefined;
    const authPath = resolveLegacyAuthProfilesPath(
      resolvedAgentDir ?? resolveSharedMainAuthAgentDir(env),
    );
    const existing = candidates.get(authPath);
    // Shared-main owns aliases of its source; do not demote it to a per-agent import.
    if (!existing || agentDir === undefined) {
      candidates.set(authPath, { agentDir: resolvedAgentDir, authPath });
    }
  };
  // The shared-main default store (undefined agentDir) must stay first so the
  // canonical location wins the per-path dedupe over agent-scoped aliases.
  addCandidate(undefined);
  addCandidate(resolveLegacyInheritedAuthAgentDir(cfg, env));
  const envAgentDir =
    readNonBlankString(env.OPENCLAW_AGENT_DIR) ?? readNonBlankString(env.PI_CODING_AGENT_DIR);
  if (envAgentDir) {
    addCandidate(envAgentDir);
  }
  for (const agentId of listAgentIds(cfg)) {
    addCandidate(resolveAgentDir(cfg, agentId, env));
  }
  for (const agentDir of listExistingAgentDirsFromState(env, onUnavailable)) {
    addCandidate(agentDir);
  }
  return [...candidates.values()];
}

/** Keep auth import and repair on the same physical owners. */
export function listAuthProfileRepairCandidates(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  onUnavailable?: (pathname: string) => void,
): AuthProfileRepairCandidate[] {
  const isRetained = createRetainedAgentDatabaseMatcher(
    env,
    () =>
      listAgentIds(cfg).map((agentId) => ({ agentId, path: resolveAgentDir(cfg, agentId, env) })),
    {
      kind: "agent-directory",
      readDatabasePaths: () => resolveConfiguredAgentDatabaseCandidatePaths(cfg, { env }),
    },
  );
  return listAuthProfileStoreCandidates(cfg, env, onUnavailable).filter(
    ({ authPath }) => !isRetained(path.dirname(authPath)),
  );
}

export function resolveLegacyAuthProfilesPath(agentDir?: string): string {
  return path.join(resolveLegacyAuthAgentDir(agentDir), "auth-profiles.json");
}

export function resolveLegacyAuthStatePath(agentDir?: string): string {
  return path.join(resolveLegacyAuthAgentDir(agentDir), "auth-state.json");
}

export function resolveLegacyFlatAuthPath(agentDir?: string): string {
  return path.join(resolveLegacyAuthAgentDir(agentDir), "auth.json");
}

/**
 * Lists retired OAuth sidecars that a legacy auth-profiles.json still references.
 *
 * Doctor imports referenced sidecars with their auth store. Unreferenced files remain
 * untouched because external agent directories may still use them. This inventory reads
 * no database and never admits legacy credentials to the runtime.
 */
export function listReferencedLegacyOAuthSidecarPaths(
  env: NodeJS.ProcessEnv,
  cfg?: OpenClawConfig,
  stateDir?: string,
): string[] {
  const runtimeEnv = cfg ? createConfigRuntimeEnv(cfg, env) : env;
  const directory = path.join(resolveOAuthDir(runtimeEnv, stateDir), "auth-profiles");
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") && listExistingRetiredStateFiles([directory]).length === 0) {
      return [];
    }
    throw createRetiredStateInspectionError(directory, error);
  }
  if (names.length === 0) {
    return [];
  }
  const referencedIds = new Set<string>();
  // The importer selects stores from the caller's env; config env may select others.
  const authPaths = new Set(
    [env, runtimeEnv].flatMap((selectionEnv) =>
      listAuthProfileStoreCandidates(
        cfg ?? {},
        stateDir ? { ...selectionEnv, OPENCLAW_STATE_DIR: stateDir } : selectionEnv,
      ).map(({ authPath }) => authPath),
    ),
  );
  for (const authPath of authPaths) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
    } catch (error) {
      // 2026.9.7 skips missing and malformed stores too; an unreadable one may hold a reference.
      if (hasErrnoCode(error, "ENOENT") || error instanceof SyntaxError) {
        continue;
      }
      throw createRetiredStateInspectionError(authPath, error);
    }
    const profiles = isRecord(raw) && isRecord(raw.profiles) ? Object.values(raw.profiles) : [];
    for (const profile of profiles) {
      if (isRecord(profile) && isLegacyOAuthRef(profile.oauthRef)) {
        referencedIds.add(profile.oauthRef.id);
      }
    }
  }
  return names
    .filter((name) => referencedIds.has(name.slice(0, -".json".length)))
    .map((name) => path.join(directory, name));
}

export function inspectLegacyOAuthSidecarsBeforeConfigRecovery(params: {
  env: NodeJS.ProcessEnv;
  configPath?: string;
  stateDir?: string;
}): readonly string[] {
  const paths = new Set(
    listReferencedLegacyOAuthSidecarPaths(params.env, undefined, params.stateDir),
  );
  const context = createConfigIoContext({
    configPath: params.configPath,
    env: cloneEnvWithPlatformSemantics(params.env),
    observe: false,
    shellEnvFallback: "defer",
  });
  const collect = (candidate: unknown) => {
    for (const pathname of listReferencedLegacyOAuthSidecarPaths(
      context.deps.env,
      coerceConfig(candidate),
      params.stateDir,
    )) {
      paths.add(pathname);
    }
  };
  const raw = readConfigFileIfPresent(context.deps, context.configPath);
  if (raw !== undefined) {
    const parsed = parseConfigJson5(raw);
    if (parsed.ok) {
      collect(parsed.parsed);
      const included = resolveConfigIncludesForRead(
        parsed.parsed,
        context.configPath,
        context.deps,
      );
      const resolved = resolveConfigForRead(
        included,
        context.deps.env,
        context.deps.lowerPrecedenceEnv,
      );
      collect(resolved.resolvedConfigRaw);
    } else {
      inspectConfigJsonRootSuffixWithContext(context, raw, collect);
    }
  }
  return [...paths];
}
