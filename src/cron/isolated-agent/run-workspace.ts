import fs from "node:fs/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionEffectRef } from "../../sessions/session-controller.lifecycle.js";
import { resolveUserPath } from "../../utils.js";
import {
  CronSessionLifecycleClaimError,
  resolveCronSessionWorkspaceOwnershipError,
} from "../run-authority.js";
import { prepareCronSessionWorktree, type CronWorkspaceLease } from "../run-workspace.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import type { MutableCronSession } from "./run-session-state.js";
import { ensureAgentWorkspace } from "./run.runtime.js";
import { resolveCronAgentSessionKey } from "./session-key.js";

/** Keep workspace selection, provisioning, and failed-preparation lease cleanup together. */
export async function prepareCronSessionWorkspace(params: {
  cfg: OpenClawConfig;
  input: RunCronAgentTurnParams;
  agentId: string;
  agentCfg: AgentDefaultsConfig;
  sessionKey: string;
  cronSession: MutableCronSession;
  defaultWorkspaceDir: string;
  sessionPreparationEffect: SessionEffectRef;
  isFastTestEnv: boolean;
}) {
  const { sessionKey } = params;
  const abortSignal = params.input.abortSignal ?? params.input.signal;
  const assertCurrent = () => {
    abortSignal?.throwIfAborted();
    if (!params.sessionPreparationEffect.isActive()) {
      throw new CronSessionLifecycleClaimError(sessionKey);
    }
  };
  const selected = await resolveCronSessionWorkspace({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionTarget: params.input.job.sessionTarget,
    admissionSource: params.input.admissionSource,
    ownerSessionKey: params.input.job.owner?.sessionKey,
    sessionKey: params.sessionKey,
    entry: params.cronSession.initialSessionEntry,
    defaultWorkspaceDir: params.defaultWorkspaceDir,
    assertCurrent,
  });
  try {
    const provisioning = await (
      await import("../../agents/acp-workspace-provisioning.js")
    ).resolveAcpAgentWorkspaceProvisioningForTurn({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.defaultWorkspaceDir,
      cwd: selected.cwd,
      sessionKey: params.sessionKey,
      sessionEntry: params.cronSession.sessionEntry,
    });
    assertCurrent();
    await ensureAgentWorkspace({
      dir: params.defaultWorkspaceDir,
      ensureBootstrapFiles: !params.agentCfg.skipBootstrap && !params.isFastTestEnv,
      skipOptionalBootstrapFiles: params.agentCfg.skipOptionalBootstrapFiles,
      provisioning,
      guard: { assertHost: assertCurrent },
    });
    assertCurrent();
    return selected;
  } catch (error) {
    await selected.lease?.release();
    throw error;
  }
}

/** Resolve only persisted session bindings; the job prompt never supplies filesystem authority. */
async function resolveCronSessionWorkspace(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionTarget: string;
  admissionSource: RunCronAgentTurnParams["admissionSource"];
  ownerSessionKey?: string;
  sessionKey: string;
  entry?: SessionEntry;
  defaultWorkspaceDir: string;
  assertCurrent: () => void;
}): Promise<{ workspaceDir: string; cwd?: string; lease?: CronWorkspaceLease }> {
  const target = resolveCronSessionTargetSessionKey(params.sessionTarget);
  if (!target) {
    return { workspaceDir: params.defaultWorkspaceDir };
  }
  const expectedKey = resolveCronAgentSessionKey({
    sessionKey: target,
    agentId: params.agentId,
    cfg: params.cfg,
    mainKey: params.cfg.session?.mainKey,
  });
  if (expectedKey !== params.sessionKey) {
    throw new CronSessionLifecycleClaimError(
      params.sessionKey,
      "Bound automation session is mismatched.",
    );
  }
  const entry = params.entry;
  // A new custom session still starts in the configured agent workspace. Only
  // existing persisted bindings can select another root.
  if (!entry) {
    return { workspaceDir: params.defaultWorkspaceDir };
  }
  const override = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: entry.spawnedBy,
    workspaceDir: entry.spawnedWorkspaceDir,
    cwd: entry.spawnedCwd,
  });
  const requestedCwd = normalizeOptionalString(entry.spawnedCwd);
  const ownershipError = resolveCronSessionWorkspaceOwnershipError({
    ...params,
    ownerSessionKey: params.ownerSessionKey,
    hasWorkspaceBinding: Boolean(override || requestedCwd || entry.worktree),
  });
  if (ownershipError) {
    throw new CronSessionLifecycleClaimError(params.sessionKey, ownershipError);
  }
  const workspaceDir = override
    ? await fs.realpath(resolveUserPath(override))
    : params.defaultWorkspaceDir;
  const cwd = requestedCwd ? await fs.realpath(resolveUserPath(requestedCwd)) : undefined;
  params.assertCurrent();
  return await prepareCronSessionWorktree({ ...params, workspaceDir, cwd });
}
