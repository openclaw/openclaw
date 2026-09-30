import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import { resolveUserPath } from "../../utils.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import { CronSessionLifecycleClaimError, type MutableCronSession } from "./run-session-state.js";
import { ensureAgentWorkspace } from "./run.runtime.js";
import { resolveCronAgentSessionKey } from "./session-key.js";

export type CronWorkspaceLease = { release: () => Promise<void> };

/** Keep workspace selection, provisioning, and failed-preparation lease cleanup together. */
export async function prepareCronSessionWorkspace(params: {
  cfg: OpenClawConfig;
  input: RunCronAgentTurnParams;
  agentId: string;
  agentCfg: AgentDefaultsConfig;
  sessionKey: string;
  cronSession: MutableCronSession;
  defaultWorkspaceDir: string;
  sessionWorkAdmission: SessionWorkAdmissionLease;
  isFastTestEnv: boolean;
}) {
  const assertCurrent = () => {
    (params.input.abortSignal ?? params.input.signal)?.throwIfAborted();
    if (!params.sessionWorkAdmission.isActive()) {
      throw new CronSessionLifecycleClaimError(params.sessionKey);
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
    executionRoot: params.input.executionRoot,
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
  executionRoot?: string;
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
  if (
    params.admissionSource === "requester-schedule" &&
    (override || requestedCwd || entry.worktree)
  ) {
    const ownerSessionKey = normalizeOptionalString(params.ownerSessionKey);
    if (
      !ownerSessionKey ||
      resolveCronAgentSessionKey({
        sessionKey: ownerSessionKey,
        agentId: params.agentId,
        cfg: params.cfg,
        mainKey: params.cfg.session?.mainKey,
      }) !== params.sessionKey
    ) {
      throw new CronSessionLifecycleClaimError(
        params.sessionKey,
        "Requester-scoped automation can only use its owning conversation’s workspace.",
      );
    }
  }
  const workspaceDir = override
    ? await fs.realpath(resolveUserPath(override))
    : params.defaultWorkspaceDir;
  const cwd = requestedCwd ? await fs.realpath(resolveUserPath(requestedCwd)) : undefined;
  params.assertCurrent();
  // A configured fallback is not a saved binding: host-rooted custom sessions
  // must keep the same root on their first and subsequent runs.
  if (
    params.executionRoot &&
    (override || requestedCwd || entry.worktree) &&
    path.resolve(params.executionRoot) !== path.resolve(workspaceDir)
  ) {
    throw new CronSessionLifecycleClaimError(
      params.sessionKey,
      "Bound automation workspace conflicts with its execution root.",
    );
  }
  const binding = entry.worktree;
  if (!binding) {
    return { workspaceDir, cwd };
  }
  const { captureOpenClawStateWorkerContext } =
    await import("../../state/openclaw-state-worker-context.js");
  const { readRegistryWorktree } = await import("../../agents/worktrees/registry-read.js");
  const { acquireWorktreeRunLease } = await import("../../agents/worktrees/run-lease.js");
  params.assertCurrent();
  const state = captureOpenClawStateWorkerContext();
  const validateWorktree = async () => {
    const record = await readRegistryWorktree(state, binding.id);
    params.assertCurrent();
    if (
      !record ||
      record.id !== binding.id ||
      record.ownerKind !== "session" ||
      record.ownerId !== params.sessionKey ||
      record.removedAt !== undefined ||
      record.branch !== binding.branch ||
      path.resolve(record.repoRoot) !== path.resolve(binding.repoRoot)
    ) {
      throw new CronSessionLifecycleClaimError(
        params.sessionKey,
        "Bound automation worktree is missing, retired, or mismatched.",
      );
    }
    const root = await fs.realpath(record.path);
    params.assertCurrent();
    if (!isPathInside(root, workspaceDir) || !isPathInside(root, cwd ?? workspaceDir)) {
      throw new CronSessionLifecycleClaimError(
        params.sessionKey,
        "Bound automation workspace does not match its managed worktree.",
      );
    }
  };
  await validateWorktree();
  const lease = await acquireWorktreeRunLease(binding.id);
  try {
    // Admission fences removal; re-read the binding after acquiring its owner-held lease.
    await validateWorktree();
    return { workspaceDir, cwd, lease };
  } catch (error) {
    await lease.release();
    throw error;
  }
}
