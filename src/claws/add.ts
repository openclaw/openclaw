import type { Stats } from "node:fs";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { transformConfigFileWithRetry } from "../config/config.js";
import { withConfigMutationExclusive } from "../config/mutate.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import { OpenClawStateLeaseError } from "../state/openclaw-state-lease.js";
import { resolveUserPath } from "../utils.js";
import {
  captureClawCreatedWorkspaceIdentity,
  releaseUncommittedAgentAdoption,
} from "./add-adoption-release.js";
import { withClawAgentMutationLease } from "./add-apply-lease.js";
import {
  assertApplyLeaseOwned,
  assertWorkspacePathUnchanged,
  clearFreshUnownedInstallRecord,
  inspectWorkspaceForApply,
  isUnclaimedCollision,
  lstatWorkspaceIfPresent,
  markInstallStatus,
  persistCommittedLegacyResume,
  persistInitialInstallRecord,
  preserveUnverifiedCreatedWorkspace,
} from "./add-apply-support.js";
import { commitClawAddAgentConfig } from "./add-config-commit.js";
import {
  type ConfigCommit,
  type ClawAddApplyOptions,
  type ClawAddResult,
  type ClawCreatedWorkspaceIdentity,
  partialResult,
} from "./add-contract.js";
import { ClawAddMutationError } from "./add-errors.js";
import { finalizeClawAddPlan } from "./add-finalize.js";
import {
  hasUnsupportedMutationActions,
  planWithPackageActions,
  statusAtLeast,
} from "./add-plan-helpers.js";
import { assertAgentAdoptionDigest, planAdoptsAgent } from "./agent-adoption-apply.js";
import { ClawBootstrapWriteError, seedClawPackageBootstrap } from "./bootstrap.js";
import { ClawPackageInstallError, installClawPackages } from "./packages.js";
import {
  persistClawInstallRecord,
  type ClawInstallStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import { planAdoptsWorkspace, prepareClawBootstrapPublication } from "./workspace-origin.js";
import {
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

export { CLAW_ADD_RESULT_SCHEMA_VERSION } from "./add-contract.js";

function sameWorkspaceDirectory(left: Stats, right: Stats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

export async function applyClawAddPlan(
  plan: ClawAddPlan,
  options: ClawAddApplyOptions = {},
): Promise<ClawAddResult> {
  if (plan.blockers.length > 0) {
    throw new ClawAddMutationError("plan_blocked", "The Claw add plan contains blockers.");
  }
  if (hasUnsupportedMutationActions(plan)) {
    throw new ClawAddMutationError(
      "unsupported_components",
      "This build cannot add one or more declared Claw component kinds.",
    );
  }
  if (options.consentPlanIntegrity !== (options.resumePlan?.planIntegrity ?? plan.planIntegrity)) {
    throw new ClawAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw add plan; run add --dry-run again.",
    );
  }

  try {
    return await withClawAgentMutationLease(plan.agent.finalId, options, async (lease) =>
      applyClawAddPlanOwned(plan, {
        ...options,
        signal: lease.signal,
        assertApplyLeaseOwned: lease.assertOwned,
      }),
    );
  } catch (error) {
    if (error instanceof OpenClawStateLeaseError) {
      throw new ClawAddMutationError("apply_lease_failed", error.message);
    }
    throw error;
  }
}

async function applyClawAddPlanOwned(
  plan: ClawAddPlan,
  options: ClawAddApplyOptions,
): Promise<ClawAddResult> {
  const persistRecord = options.persistRecord ?? persistClawInstallRecord;
  let installRecord: PersistedClawInstall;
  let installRecordCreated = false;
  try {
    ({ record: installRecord, created: installRecordCreated } = persistInitialInstallRecord(
      plan,
      options,
    ));
  } catch (error) {
    throw new ClawAddMutationError("provenance_failed", coerceErrorMessage(error));
  }

  const agentAdoption = planAdoptsAgent(plan);
  if (agentAdoption) {
    try {
      await assertAgentAdoptionDigest({
        plan,
        install: installRecord,
        readConfig: options.readConfig ?? options.readConfigForApply,
      });
    } catch (error) {
      clearFreshUnownedInstallRecord(plan.agent.finalId, installRecordCreated, options);
      throw new ClawAddMutationError(
        "agent_config_conflict",
        `Could not verify agent ${JSON.stringify(plan.agent.finalId)} before adoption: ${coerceErrorMessage(error)}`,
      );
    }
    assertApplyLeaseOwned(options);
  }

  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  let workspacePhaseRecorded = statusAtLeast(installRecord.status, "workspace_ready");
  const workspaceAdoption = planAdoptsWorkspace(plan);
  const inspectWorkspace = options.lstatWorkspace ?? lstat;
  // Capture the install generation before package/config/filesystem work can await.
  let bootstrapPublication: ReturnType<typeof prepareClawBootstrapPublication>;
  try {
    bootstrapPublication = (options.prepareBootstrapPublication ?? prepareClawBootstrapPublication)(
      plan,
      options,
    );
  } catch (error) {
    clearFreshUnownedInstallRecord(plan.agent.finalId, installRecordCreated, options);
    throw new ClawAddMutationError("bootstrap_prepare_failed", coerceErrorMessage(error));
  }
  const workspaceState = await inspectWorkspaceForApply({
    workspace,
    agentId: plan.agent.finalId,
    installRecordCreated,
    inspectWorkspace,
    options,
  });
  assertApplyLeaseOwned(options);

  if (!workspacePhaseRecorded && workspaceState && !workspaceAdoption) {
    markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], options);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated: false,
      configCommitted: false,
      packages: [],
      error: {
        code: "workspace_collision",
        message: `Workspace ${JSON.stringify(workspace)} was created after planning.`,
      },
      nowMs: options.nowMs,
    });
  }
  if (workspaceState && !workspaceState.isDirectory()) {
    clearFreshUnownedInstallRecord(plan.agent.finalId, installRecordCreated, options);
    throw new ClawAddMutationError(
      "workspace_collision",
      `Workspace ${JSON.stringify(workspace)} is no longer a directory.`,
    );
  }

  let workspaceCreated = workspaceState?.isDirectory() ?? false;
  let createdWorkspaceIdentity: ClawCreatedWorkspaceIdentity | undefined;
  let configCommitted = statusAtLeast(installRecord.status, "config_committed");
  let adoptedWorkspaceState = workspaceAdoption ? workspaceState : undefined;
  if (workspaceAdoption && (!workspaceCreated || !workspacePhaseRecorded)) {
    const adoptedState = await inspectWorkspaceForApply({
      workspace,
      agentId: plan.agent.finalId,
      installRecordCreated,
      inspectWorkspace,
      options,
      adoptable: true,
    });
    assertApplyLeaseOwned(options);
    if (!adoptedState?.isDirectory()) {
      clearFreshUnownedInstallRecord(plan.agent.finalId, installRecordCreated, options);
      throw new ClawAddMutationError(
        "workspace_collision",
        `Adoptable workspace ${JSON.stringify(workspace)} is no longer an existing directory.`,
      );
    }
    workspaceCreated = true;
    adoptedWorkspaceState = adoptedState;
    if (!workspacePhaseRecorded) {
      try {
        markInstallStatus(
          plan.agent.finalId,
          "workspace_ready",
          ["pending", "partial", "workspace_ready"],
          options,
        );
      } catch (error) {
        clearFreshUnownedInstallRecord(plan.agent.finalId, installRecordCreated, options);
        throw new ClawAddMutationError("provenance_failed", coerceErrorMessage(error));
      }
      // Reflect the recorded phase locally so a later failure preserves it via
      // preserveRecordedPhaseOrMarkPartial instead of re-marking a stale expected status.
      workspacePhaseRecorded = true;
      installRecord = { ...installRecord, status: "workspace_ready" };
    }
  }

  const installPackages = options.installPackages ?? installClawPackages;
  let packages: PersistedClawPackageRef[] = [];
  let workspaceFiles: PersistedClawWorkspaceFile[] = [];
  const preserveRecordedPhaseOrMarkPartial = (): ClawInstallStatus => {
    if (workspacePhaseRecorded) {
      return installRecord.status;
    }
    markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], options);
    return "partial";
  };
  const releaseAgentAdoption = async (params: {
    error: NonNullable<ClawAddResult["error"]>;
    rollbackWorkspaceEffects: boolean;
  }) =>
    await releaseUncommittedAgentAdoption({
      plan,
      install: installRecord,
      workspaceFiles,
      packages,
      workspaceCreated,
      createdWorkspaceIdentity,
      configCommitted,
      rollbackWorkspaceEffects: params.rollbackWorkspaceEffects,
      error: params.error,
      options,
    });

  const hostRequirementPlan = planWithPackageActions(
    plan,
    (action) => action.details?.kind === "plugin",
  );
  const hostRequirementActions = hostRequirementPlan.actions.filter(
    (action) => action.kind === "package",
  );
  if (hostRequirementActions.length > 0) {
    try {
      assertApplyLeaseOwned(options);
      packages = await installPackages(hostRequirementPlan, options);
      assertApplyLeaseOwned(options);
    } catch (error) {
      assertApplyLeaseOwned(options);
      const packageError =
        error instanceof ClawPackageInstallError
          ? error
          : new ClawPackageInstallError(
              "package_install_failed",
              coerceErrorMessage(error),
              packages,
            );
      packages = packageError.installedPackages;
      if (agentAdoption && !configCommitted) {
        return await releaseAgentAdoption({
          error: { code: packageError.code, message: packageError.message },
          rollbackWorkspaceEffects: true,
        });
      }
      const installStatus = preserveRecordedPhaseOrMarkPartial();
      return partialResult({
        plan,
        installRecord,
        workspaceCreated,
        configCommitted,
        packages,
        installStatus,
        error: { code: packageError.code, message: packageError.message },
        nowMs: options.nowMs,
      });
    }
  }

  // Keep admission, managed-file effects, and config publication under one owner.
  const workspaceResult = await withConfigMutationExclusive(
    async (lockedConfig): Promise<ClawAddResult | undefined> => {
      assertApplyLeaseOwned(options);
      const readConfigForApply = options.readConfigForApply ?? options.readConfig;
      const currentConfig = readConfigForApply ? await readConfigForApply() : lockedConfig;
      assertApplyLeaseOwned(options);
      try {
        // Reuse the commit owner's identity and resume rules before any file effects.
        commitClawAddAgentConfig({
          config: currentConfig,
          plan,
          workspace,
          resumePlan: options.resumePlan,
          resumeRecord: options.resumeRecord,
          agentAdoption,
          durableConfigCommitted: configCommitted && installRecord.agentClaimed !== false,
        });
      } catch (error) {
        if (!(error instanceof ClawAddMutationError)) {
          throw error;
        }
        if (agentAdoption && !configCommitted) {
          return await releaseAgentAdoption({
            error: { code: error.code, message: error.message },
            rollbackWorkspaceEffects: true,
          });
        }
        const unclaimedCollision = isUnclaimedCollision(error, configCommitted, installRecord);
        if (
          packages.length > 0 ||
          workspacePhaseRecorded ||
          (!installRecordCreated && unclaimedCollision)
        ) {
          const installStatus = preserveRecordedPhaseOrMarkPartial();
          if (unclaimedCollision) {
            markInstallStatus(
              plan.agent.finalId,
              installStatus,
              [installStatus],
              options,
              false,
              "adopted",
            );
            installRecord = {
              ...installRecord,
              schemaVersion: "openclaw.clawInstallRecord.v3",
              status: installStatus,
              agentOrigin: "adopted",
              agentClaimed: false,
            };
          }
          return partialResult({
            plan,
            installRecord,
            workspaceCreated,
            configCommitted,
            packages,
            installStatus,
            error: { code: error.code, message: error.message },
            nowMs: options.nowMs,
          });
        }
        clearFreshUnownedInstallRecord(plan.agent.finalId, installRecordCreated, options);
        throw error;
      }

      try {
        if (workspaceAdoption) {
          assertWorkspacePathUnchanged(workspace);
          const currentWorkspaceState = await lstatWorkspaceIfPresent(workspace, inspectWorkspace);
          assertApplyLeaseOwned(options);
          if (
            !adoptedWorkspaceState ||
            !currentWorkspaceState ||
            !sameWorkspaceDirectory(adoptedWorkspaceState, currentWorkspaceState)
          ) {
            throw new ClawAddMutationError(
              "workspace_collision",
              `Adopted workspace ${JSON.stringify(workspace)} changed during package installation.`,
            );
          }
        }
        assertWorkspacePathUnchanged(workspace);
        assertApplyLeaseOwned(options);
        await mkdir(dirname(workspace), { recursive: true });
        assertApplyLeaseOwned(options);
        assertWorkspacePathUnchanged(workspace);
      } catch (error) {
        if (agentAdoption && !configCommitted) {
          return await releaseAgentAdoption({
            error: {
              code: error instanceof ClawAddMutationError ? error.code : "workspace_parent_failed",
              message:
                error instanceof ClawAddMutationError
                  ? error.message
                  : `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${coerceErrorMessage(error)}`,
            },
            rollbackWorkspaceEffects: true,
          });
        }
        if (packages.length > 0 || workspacePhaseRecorded) {
          const installStatus = preserveRecordedPhaseOrMarkPartial();
          return partialResult({
            plan,
            installRecord,
            workspaceCreated,
            configCommitted,
            packages,
            installStatus,
            error: {
              code: error instanceof ClawAddMutationError ? error.code : "workspace_parent_failed",
              message:
                error instanceof ClawAddMutationError
                  ? error.message
                  : `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${coerceErrorMessage(error)}`,
            },
            nowMs: options.nowMs,
          });
        }
        clearFreshUnownedInstallRecord(plan.agent.finalId, installRecordCreated, options);
        if (error instanceof ClawAddMutationError) {
          throw error;
        }
        throw new ClawAddMutationError(
          "workspace_parent_failed",
          `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${coerceErrorMessage(error)}`,
        );
      }

      if (!workspaceCreated) {
        try {
          assertApplyLeaseOwned(options);
          await mkdir(workspace);
          assertApplyLeaseOwned(options);
          workspaceCreated = true;
          createdWorkspaceIdentity = await (
            options.captureWorkspaceIdentity ?? captureClawCreatedWorkspaceIdentity
          )(workspace);
          assertApplyLeaseOwned(options);
        } catch (error) {
          if (workspaceCreated) {
            return preserveUnverifiedCreatedWorkspace({
              plan,
              installRecord,
              packages,
              error,
              options,
            });
          }
          if (agentAdoption) {
            return await releaseAgentAdoption({
              error: {
                code: "workspace_collision",
                message: `Could not create new workspace ${JSON.stringify(workspace)}: ${coerceErrorMessage(error)}`,
              },
              rollbackWorkspaceEffects: false,
            });
          }
          markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], options);
          return partialResult({
            plan,
            installRecord,
            workspaceCreated: false,
            configCommitted: false,
            packages,
            error: {
              code: "workspace_collision",
              message: `Could not create new workspace ${JSON.stringify(workspace)}: ${coerceErrorMessage(error)}`,
            },
            nowMs: options.nowMs,
          });
        }

        try {
          if (!workspacePhaseRecorded) {
            markInstallStatus(
              plan.agent.finalId,
              "workspace_ready",
              ["pending", "partial", "workspace_ready"],
              options,
            );
          }
        } catch (error) {
          if (agentAdoption) {
            return await releaseAgentAdoption({
              error: { code: "provenance_failed", message: coerceErrorMessage(error) },
              rollbackWorkspaceEffects: false,
            });
          }
          assertApplyLeaseOwned(options);
          const removedWorkspace = await rmdir(workspace)
            .then(() => true)
            .catch(() => false);
          assertApplyLeaseOwned(options);
          if (removedWorkspace) {
            try {
              clearFreshUnownedInstallRecord(plan.agent.finalId, installRecordCreated, options);
            } catch {
              // Preserve the phase-write failure if the unowned attempt cannot be reconciled.
            }
          }
          throw new ClawAddMutationError("provenance_failed", coerceErrorMessage(error));
        }
      }

      // Seed and attest the consented package bootstrap while the workspace is still
      // private. Committing the agent config first makes the agent routable, so a
      // concurrent `sessions.create` can stock-seed BOOTSTRAP.md and strand the add at
      // `config_committed` with a seed conflict that no retry can clear. An existing file is
      // claimed as this install's seed only when the recorded receipt says so; an identical file
      // that appeared in an adopted workspace is a conflict, never a seed to attest.
      try {
        assertApplyLeaseOwned(options);
        await (options.seedPackageBootstrap ?? seedClawPackageBootstrap)(plan, {
          ...options,
          ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
          publication: bootstrapPublication,
        });
        assertApplyLeaseOwned(options);
      } catch (error) {
        assertApplyLeaseOwned(options);
        if (agentAdoption && !configCommitted) {
          return await releaseAgentAdoption({
            error: {
              code:
                error instanceof ClawBootstrapWriteError ? error.code : "bootstrap_write_failed",
              message: coerceErrorMessage(error),
            },
            rollbackWorkspaceEffects: true,
          });
        }
        const installStatus: ClawInstallStatus = configCommitted
          ? "config_committed"
          : "workspace_ready";
        markInstallStatus(
          plan.agent.finalId,
          installStatus,
          configCommitted ? ["config_committed"] : ["workspace_ready", "config_committed"],
          options,
        );
        return partialResult({
          plan,
          installRecord,
          workspaceCreated,
          configCommitted,
          packages,
          installStatus,
          error: {
            code: error instanceof ClawBootstrapWriteError ? error.code : "bootstrap_write_failed",
            message: coerceErrorMessage(error),
          },
          nowMs: options.nowMs,
        });
      }

      // Workspace ownership must be complete before the agent becomes routable. Besides writing new
      // files, this reopens every adopted destination through the safe-file contract and records its
      // exact digest; a failure therefore leaves only retryable provenance, never an enabled agent.
      const createFiles = options.createWorkspaceFiles ?? createClawWorkspaceFiles;
      try {
        assertApplyLeaseOwned(options);
        workspaceFiles = await createFiles(plan, options);
        assertApplyLeaseOwned(options);
      } catch (error) {
        assertApplyLeaseOwned(options);
        const workspaceError =
          error instanceof ClawWorkspaceWriteError
            ? error
            : new ClawWorkspaceWriteError(
                [
                  {
                    level: "error",
                    code: "workspace_file_io_error",
                    phase: "mutation",
                    path: "$.workspace",
                    message: error instanceof Error ? error.message : String(error),
                  },
                ],
                workspaceFiles,
              );
        workspaceFiles = workspaceError.createdFiles;
        if (agentAdoption && !configCommitted) {
          return await releaseAgentAdoption({
            error: {
              code: "workspace_files_failed",
              message: workspaceError.message,
              diagnostics: workspaceError.diagnostics,
            },
            rollbackWorkspaceEffects: true,
          });
        }
        const installStatus: ClawInstallStatus = configCommitted
          ? "config_committed"
          : "workspace_ready";
        markInstallStatus(
          plan.agent.finalId,
          installStatus,
          configCommitted ? ["config_committed"] : ["workspace_ready"],
          options,
        );
        return partialResult({
          plan,
          installRecord,
          workspaceCreated,
          configCommitted,
          workspaceFiles,
          packages,
          installStatus,
          error: {
            code: "workspace_files_failed",
            message: workspaceError.message,
            diagnostics: workspaceError.diagnostics,
          },
          nowMs: options.nowMs,
        });
      }

      try {
        const commit: ConfigCommit =
          options.commitConfig ??
          (async (transform) => {
            await transformConfigFileWithRetry({
              afterWrite: { mode: "auto" },
              transform: (config) => ({ nextConfig: transform(config) }),
            });
          });
        assertApplyLeaseOwned(options);
        await commit((config) => {
          assertApplyLeaseOwned(options);
          return commitClawAddAgentConfig({
            config,
            plan,
            workspace,
            resumePlan: options.resumePlan,
            resumeRecord: options.resumeRecord,
            agentAdoption,
            durableConfigCommitted: configCommitted && installRecord.agentClaimed !== false,
          });
        });
        assertApplyLeaseOwned(options);
        // Record only after commit; the transform can run before persistence fails.
        configCommitted = true;
        if (!agentAdoption) {
          try {
            recordAgentProvenance(plan.agent.finalId, { createdVia: "claw" }, options);
          } catch (error) {
            throw new ClawAddMutationError("provenance_failed", coerceErrorMessage(error));
          }
        }
        if (options.resumePlan && installRecord.schemaVersion === "openclaw.clawInstallRecord.v1") {
          installRecord = persistCommittedLegacyResume({
            plan,
            resumePlan: options.resumePlan,
            installRecord,
            persistRecord,
            options,
          });
        } else {
          markInstallStatus(
            plan.agent.finalId,
            "config_committed",
            ["workspace_ready", "config_committed"],
            options,
            true,
          );
        }
        installRecord = {
          ...installRecord,
          status: "config_committed",
          agentClaimed: true,
          updatedAtMs: options.nowMs ?? Date.now(),
        };
      } catch (error) {
        let installStatus: ClawInstallStatus = configCommitted
          ? "config_committed"
          : "workspace_ready";
        if (!configCommitted && !workspaceAdoption && !agentAdoption) {
          assertApplyLeaseOwned(options);
          const removedWorkspace = await rmdir(workspace)
            .then(() => true)
            .catch(() => false);
          assertApplyLeaseOwned(options);
          if (removedWorkspace) {
            workspaceCreated = false;
            installStatus = "partial";
            markInstallStatus(
              plan.agent.finalId,
              "partial",
              ["workspace_ready", "partial"],
              options,
            );
          }
        }
        if (!configCommitted && agentAdoption) {
          return await releaseAgentAdoption({
            error: {
              code: error instanceof ClawAddMutationError ? error.code : "config_commit_failed",
              message: coerceErrorMessage(error),
            },
            rollbackWorkspaceEffects: true,
          });
        }
        return partialResult({
          plan,
          installRecord,
          workspaceCreated,
          configCommitted,
          workspaceFiles,
          packages,
          installStatus,
          error: {
            code: error instanceof ClawAddMutationError ? error.code : "config_commit_failed",
            message: coerceErrorMessage(error),
          },
          nowMs: options.nowMs,
        });
      }
      return undefined;
    },
  );
  if (workspaceResult) {
    return workspaceResult;
  }

  return await finalizeClawAddPlan({
    plan,
    options,
    installRecord,
    workspaceCreated,
    configCommitted,
    workspaceFiles,
    packages,
    installPackages,
  });
}
