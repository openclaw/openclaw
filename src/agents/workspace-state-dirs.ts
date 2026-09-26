import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
} from "./agent-scope-config.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./sandbox/shared.js";
import { listAgentWorkspaceDirs } from "./workspace-dirs.js";
import { assertWorkspaceStateMigrationReady } from "./workspace-legacy-state.js";

/** Select configured workspaces and active sandbox copies for migration and readiness. */
export async function listWorkspaceStateDirs(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  stateDir: string;
}): Promise<string[]> {
  const dirs = new Set(listAgentWorkspaceDirs(params.cfg, params.env));
  const agentWorkspaces: Array<{
    agentId: string;
    sandbox: ReturnType<typeof resolveSandboxConfigForAgent>;
    workspaceRoot: string;
    sessionKeys: string[];
  }> = [];

  let sessionAccessor: typeof import("../config/sessions/session-accessor.js") | undefined;
  for (const agentId of listAgentIds(params.cfg)) {
    if (readAgentDatabaseAdmissionRefusal(agentId, { env: params.env })) {
      continue;
    }
    const sandbox = resolveSandboxConfigForAgent(params.cfg, agentId);
    if (sandbox.mode === "off" || sandbox.workspaceAccess === "rw") {
      continue;
    }
    const configuredWorkspaceRoot =
      resolveAgentConfig(params.cfg, agentId)?.sandbox?.workspaceRoot ??
      params.cfg.agents?.defaults?.sandbox?.workspaceRoot;
    const workspaceRoot = resolveUserPath(
      configuredWorkspaceRoot ?? path.join(params.stateDir, "sandboxes"),
      params.env,
      params.homedir,
    );
    // Sandbox containers may be pruned while their workspace survives. The
    // agent-owned session store remains the durable authority for that copy.
    let sessionKeys: string[] = [];
    if (sandbox.scope === "session") {
      sessionAccessor ??= await import("../config/sessions/session-accessor.js");
      sessionKeys = await sessionAccessor.listSessionEntryKeysReadOnly({
        agentId,
        env: params.env,
        storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
          agentId,
          env: params.env,
        }),
      });
    }
    agentWorkspaces.push({
      agentId,
      sandbox,
      workspaceRoot,
      sessionKeys: sessionKeys.filter((sessionKey) => {
        const sessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
        return !sessionAgentId || sessionAgentId === agentId;
      }),
    });
  }

  if (agentWorkspaces.length === 0) {
    return [...dirs];
  }
  const { resolveSandboxRuntimeStatusesForPersistedSessions } =
    await import("./sandbox/runtime-status.js");
  // Empty requests retain agent/shared workspace order without reading their stores.
  const runtimeGroups = resolveSandboxRuntimeStatusesForPersistedSessions(
    agentWorkspaces.map(({ agentId, sessionKeys }) => ({
      cfg: params.cfg,
      env: params.env,
      agentId,
      sessionKeys,
    })),
  );
  for (const [index, { agentId, sandbox, workspaceRoot }] of agentWorkspaces.entries()) {
    if (sandbox.scope === "shared") {
      dirs.add(workspaceRoot);
      continue;
    }
    const sessionKeys =
      sandbox.scope === "agent"
        ? [`agent:${agentId}:main`]
        : expectDefined(runtimeGroups[index], "sandbox runtime group")
            .filter((runtime) => runtime.sandboxed)
            .map((runtime) => runtime.sessionKey);
    for (const sessionKey of sessionKeys) {
      const layout = resolveSandboxWorkspaceLayoutPaths({
        cfg: { ...sandbox, workspaceRoot },
        agentId,
        rawSessionKey: sessionKey,
        workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId, params.env),
      });
      dirs.add(layout.sandboxWorkspaceDir);
    }
  }

  return [...dirs];
}

/** Refuse completion before channels accept work that a workspace cannot execute. */
export async function assertConfiguredWorkspaceStateReady(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  operation?: "doctor";
}): Promise<void> {
  const env = params.env ?? process.env;
  const homedir = os.homedir;
  const workspaceDirs = await listWorkspaceStateDirs({
    cfg: params.cfg,
    env,
    homedir,
    stateDir: resolveStateDir(env, homedir),
  });
  if (params.operation === "doctor" && workspaceDirs.length > 0) {
    const { readWorkspaceStateSnapshot } = await import("./workspace-state-store.js");
    for (const workspaceDir of workspaceDirs) {
      await readWorkspaceStateSnapshot(workspaceDir, { env, readOnly: true });
    }
  }
  assertWorkspaceStateMigrationReady({ ...params, workspaceDirs, env, homedir });
}
