import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentDir } from "../../agents/agent-scope-config.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "../../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveSessionPlacementDisabledReason,
  type SessionPlacementPreflight,
} from "./device-placement-eligibility.js";
import { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";
import { isPortableRootContainedSymlink } from "./workspace-actual-manifest.js";

/** Bound preflight walks so environments.list stays picker-responsive. */
const MAX_SYMLINK_PREFLIGHT_ENTRIES = 4_096;

function isOpenAiAuthProvider(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase() ?? "";
  return (
    normalized === "openai" ||
    normalized === "openai-codex" ||
    normalized.startsWith("openai/") ||
    normalized.startsWith("openai-")
  );
}

function configHasPreparedOpenAiAuth(config: OpenClawConfig): boolean {
  const profiles = config.auth?.profiles;
  if (!profiles || typeof profiles !== "object") {
    return false;
  }
  return Object.values(profiles).some((profile) => isOpenAiAuthProvider(profile?.provider));
}

function storeHasPreparedOpenAiAuth(agentDir: string | undefined): boolean | undefined {
  const store = getPreparedRuntimeAuthProfileStoreSnapshot(agentDir);
  if (!store) {
    return undefined;
  }
  return Object.values(store.profiles).some((profile) => isOpenAiAuthProvider(profile.provider));
}

/** Reads Codex appServer.homeScope without importing the Codex extension. */
export function resolveCodexAppServerHomeScopeFromConfig(
  config: OpenClawConfig,
): "agent" | "user" | undefined {
  const entries = config.plugins?.entries;
  if (!isRecord(entries) || !isRecord(entries.codex)) {
    return undefined;
  }
  const pluginConfig = isRecord(entries.codex.config) ? entries.codex.config : undefined;
  const appServer = isRecord(pluginConfig?.appServer) ? pluginConfig.appServer : undefined;
  return appServer?.homeScope === "user" || appServer?.homeScope === "agent"
    ? appServer.homeScope
    : undefined;
}

/**
 * Remote-exec placement requires prepared OpenAI auth in an agent-scoped home.
 * Native Codex homeScope="user" and ambient credentials are never accepted.
 */
export function resolveMissingPreparedAuthForPlacement(params: {
  config: OpenClawConfig;
  runtimeId?: string;
}): boolean {
  const runtimeId = params.runtimeId?.trim();
  if (!runtimeId) {
    return false;
  }
  const { executionMode } = resolveWorkerPlacementCapabilities(runtimeId);
  if (executionMode !== "remote-exec") {
    return false;
  }
  if (resolveCodexAppServerHomeScopeFromConfig(params.config) === "user") {
    return true;
  }
  const agentDir = resolveDefaultAgentDir(params.config);
  const storeReady = storeHasPreparedOpenAiAuth(agentDir);
  if (storeReady === true) {
    return false;
  }
  if (storeReady === false) {
    return true;
  }
  return !configHasPreparedOpenAiAuth(params.config);
}

/**
 * Early-exit walk: true when any workspace symlink is absolute or escapes the root.
 * Caps visited entries so picker catalog reads stay bounded.
 */
export async function workspaceHasEscapingSymlinks(workspacePath: string): Promise<boolean> {
  const root = path.resolve(workspacePath.trim());
  if (!root) {
    return false;
  }
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch {
    return false;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return false;
  }

  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > MAX_SYMLINK_PREFLIGHT_ENTRIES) {
        return false;
      }
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!relative || relative.startsWith("..")) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await fs.readlink(absolute);
        } catch {
          continue;
        }
        if (!isPortableRootContainedSymlink(root, relative, target)) {
          return true;
        }
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(absolute);
      }
    }
  }
  return false;
}

/** Resolves session placement preflight flags for environments.list. */
export async function resolveSessionPlacementPreflight(params: {
  config: OpenClawConfig;
  runtimeId?: string;
  workspacePath?: string;
}): Promise<SessionPlacementPreflight> {
  const missingPreparedAuth = resolveMissingPreparedAuthForPlacement({
    config: params.config,
    runtimeId: params.runtimeId,
  });
  const workspacePath = params.workspacePath?.trim();
  const escaping =
    workspacePath && workspacePath.length > 0
      ? await workspaceHasEscapingSymlinks(workspacePath)
      : false;
  return {
    ...(escaping ? { workspaceHasEscapingSymlinks: true } : {}),
    ...(missingPreparedAuth ? { missingPreparedAuth: true } : {}),
  };
}

/** Stamps session-scoped disabledReason onto paired-device list rows. */
export function applySessionPlacementDisabledReasonToNodes(
  environments: EnvironmentSummary[],
  sessionDisabledReason: string | undefined,
): EnvironmentSummary[] {
  if (!sessionDisabledReason) {
    return environments;
  }
  return environments.map((environment) =>
    environment.type === "node"
      ? { ...environment, disabledReason: sessionDisabledReason }
      : environment,
  );
}

export async function resolveEnvironmentsListSessionPlacement(params: {
  config: OpenClawConfig;
  runtimeId?: string;
  workspacePath?: string;
}) {
  const sessionPlacement = await resolveSessionPlacementPreflight(params);
  const sessionDisabledReason = resolveSessionPlacementDisabledReason(sessionPlacement);
  const hasSessionPlacement =
    sessionPlacement.workspaceHasEscapingSymlinks === true ||
    sessionPlacement.missingPreparedAuth === true;
  return {
    sessionPlacement,
    sessionDisabledReason,
    hasSessionPlacement,
  };
}
