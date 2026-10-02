import { coerceErrorMessage } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PackageDirInstallTransaction } from "../infra/install-package-dir.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import { clawPackageKey } from "./application-provenance.js";
import { digestClawValue as digest } from "./digest.js";
import { readClawInventory } from "./inventory-read.js";
import { hasOtherWorkspaceSkillOwner, planOwnedClawSkillUpgrade } from "./owned-skill-upgrade.js";
import {
  digestClawPackageRef,
  replaceClawPackageRefExpected,
} from "./package-update-provenance.js";
import {
  installClawPackages,
  type ClawPluginInstallConsent,
  type ClawSkillInstallConsent,
} from "./packages.js";
import type { ClawPluginRuntimeOptions } from "./plugin-runtime.js";
import {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  persistClawPackageRef,
  readClawPackageRefs,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan, ClawPackage, ResolvedClawPackage } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";
import { collectClawRollbackFailures } from "./update-rollback.js";
import {
  readClawPackageRefsForUpdate,
  replaceClawPackageRefForUpdate,
  type ClawUpdateStateOptions,
} from "./update-state-write.js";

type PackageInstallerDeps = NonNullable<
  NonNullable<Parameters<typeof installClawPackages>[1]>["deps"]
>;

export type ClawPackageUpdateExecution = {
  appliedIds: string[];
  rollback: () => Promise<void>;
  commit?: () => Promise<void>;
};

export class ClawPackageUpdateError extends Error {
  constructor(
    message: string,
    readonly partial: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClawPackageUpdateError";
  }
}

export async function applyClawPackageUpdate(
  updatePlan: ClawUpdatePlan,
  targetAddPlan: ClawAddPlan,
  options: ClawPluginRuntimeOptions &
    ClawUpdateStateOptions & {
      config?: OpenClawConfig;
      pluginConsent?: ClawPluginInstallConsent;
      skillConsent?: ClawSkillInstallConsent;
      installPackages?: typeof installClawPackages;
      readRefs?: (
        options?: Parameters<typeof readClawPackageRefs>[0],
      ) => ReturnType<typeof readClawPackageRefs> | Promise<ReturnType<typeof readClawPackageRefs>>;
      readInstalls?: () =>
        | Pick<PersistedClawInstall, "agentId" | "workspace">[]
        | Promise<Pick<PersistedClawInstall, "agentId" | "workspace">[]>;
      replaceExpected?: (
        expected: Parameters<typeof replaceClawPackageRefExpected>[0],
        replacement: Parameters<typeof replaceClawPackageRefExpected>[1],
        options?: Parameters<typeof replaceClawPackageRefExpected>[2],
      ) => void | Promise<void>;
      packageDeps?: PackageInstallerDeps;
      nowMs?: number;
    },
): Promise<ClawPackageUpdateExecution> {
  const actions = updatePlan.actions.filter(
    (action) => action.kind === "package" && action.action !== "unchanged",
  );
  if (actions.length === 0) {
    return { appliedIds: [], rollback: async () => undefined };
  }
  const installPackages = options.installPackages ?? installClawPackages;
  const readRefs = options.readRefs ?? readClawPackageRefsForUpdate;
  const readInstalls =
    options.readInstalls ?? (async () => (await readClawInventory(options)).installs);
  const replaceExpected = options.replaceExpected ?? replaceClawPackageRefForUpdate;
  const currentRefs = new Map(
    (await readRefs({ ...options, agentId: updatePlan.agentId })).map((ref) => [
      clawPackageKey(ref),
      ref,
    ]),
  );
  const allRefs = await readRefs(options);
  const undo: Array<() => Promise<void>> = [];
  const externalMutations: string[] = [];
  const skillTransactions: PackageDirInstallTransaction[] = [];
  const appliedIds: string[] = [];

  const rollback = async () => {
    const failures = await collectClawRollbackFailures(undo.toReversed());
    if (externalMutations.length > 0) {
      failures.push(`package artifacts may have been retained: ${externalMutations.join(", ")}`);
    }
    if (failures.length > 0) {
      throw new ClawPackageUpdateError(failures.join("; "), true);
    }
  };

  try {
    for (const action of actions) {
      const previous = currentRefs.get(action.id);
      if (
        previous &&
        action.currentDigest &&
        digestClawPackageRef(previous) !== action.currentDigest
      ) {
        throw new ClawPackageUpdateError(
          `Package reference ${JSON.stringify(action.id)} changed after planning.`,
          false,
        );
      }
      if (action.action === "release" || action.action === "remove") {
        if (!previous) {
          throw new ClawPackageUpdateError(
            `Package reference ${JSON.stringify(action.id)} disappeared.`,
            false,
          );
        }
        await replaceExpected(previous, undefined, options);
        undo.push(async () => await replaceExpected(undefined, previous, options));
        appliedIds.push(action.id);
        continue;
      }
      const targetAction = targetAddPlan.actions.find(
        (candidate) => candidate.kind === "package" && candidate.id === action.id,
      );
      const target = targetAction?.details as
        | (ClawPackage & {
            integrity?: string;
            ownerAction?: "install" | "reuse";
            riskWarning?: string;
            extension?: PersistedClawPackageRef["extension"];
          })
        | undefined;
      if (
        !targetAction ||
        (target?.kind !== "skill" && target?.kind !== "plugin") ||
        target.source !== "clawhub" ||
        !target.ref ||
        !target.version
      ) {
        throw new ClawPackageUpdateError(
          `Target package action ${JSON.stringify(action.id)} is missing.`,
          false,
        );
      }
      const targetIntegrity = target.integrity;
      if (typeof targetIntegrity !== "string") {
        throw new ClawPackageUpdateError(
          `Target package action ${JSON.stringify(action.id)} has no resolved integrity.`,
          false,
        );
      }
      if (target.kind === "skill" && target.ownerAction === "install" && target.riskWarning) {
        if (!options.skillConsent) {
          throw new ClawPackageUpdateError(
            `Skill ${target.ref}@${target.version} requires a trust warning acknowledgement.`,
            false,
          );
        }
        options.skillConsent.assertApproved({
          ref: target.ref,
          version: target.version,
          integrity: targetIntegrity,
          riskWarning: target.riskWarning,
        });
      }
      if (
        target.kind === "plugin" &&
        allRefs.some(
          (ref) =>
            ref.agentId !== updatePlan.agentId &&
            ref.kind === "plugin" &&
            ref.source === target.source &&
            ref.ref === target.ref &&
            ref.version !== target.version,
        )
      ) {
        throw new ClawPackageUpdateError(
          `Plugin ${JSON.stringify(target.ref)} has another Claw owner pinned to a different version.`,
          false,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const reusesExistingArtifact = target.ownerAction === "reuse";
      const preservesExistingEdge =
        reusesExistingArtifact &&
        previous?.version === target.version &&
        previous.integrity === targetIntegrity;
      let claimed: PersistedClawPackageRef = {
        schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
        agentId: updatePlan.agentId,
        clawName: targetAddPlan.claw.name,
        kind: target.kind,
        source: target.source,
        ref: target.ref,
        version: target.version,
        integrity: targetIntegrity,
        status: "pending",
        relationship:
          preservesExistingEdge && previous
            ? previous.relationship
            : target.kind === "skill"
              ? "managed"
              : "referenced",
        origin:
          preservesExistingEdge && previous
            ? previous.origin
            : reusesExistingArtifact
              ? "pre-existing"
              : "claw-introduced",
        independentOwner:
          preservesExistingEdge && previous ? previous.independentOwner : reusesExistingArtifact,
        ...(target.extension ? { extension: target.extension } : {}),
        installedAtMs: preservesExistingEdge && previous ? previous.installedAtMs : nowMs,
        updatedAtMs: nowMs,
      };
      const skillUpgrade =
        target.kind === "skill" &&
        action.action === "change" &&
        previous &&
        previous.version !== target.version
          ? await planOwnedClawSkillUpgrade({
              workspace: targetAddPlan.agent.workspace,
              previous,
              targetVersion: target.version,
              refs: allRefs,
              installs: await readInstalls(),
            })
          : undefined;
      if (skillUpgrade && !skillUpgrade.ok) {
        throw new ClawPackageUpdateError(skillUpgrade.message, false);
      }
      const assertSkillUpgradeCurrent = async () => {
        if (!skillUpgrade?.ok || !previous) {
          return;
        }
        const checked = await planOwnedClawSkillUpgrade({
          workspace: targetAddPlan.agent.workspace,
          previous,
          targetVersion: target.version,
          refs: await readRefs(options),
          installs: await readInstalls(),
        });
        if (!checked.ok || digest(checked.plan) !== digest(skillUpgrade.plan)) {
          throw new ClawPackageUpdateError(
            checked.ok ? "Skill changed after planning." : checked.message,
            false,
          );
        }
      };
      await replaceExpected(previous, claimed, options);
      const restoreRef = async () => await replaceExpected(claimed, previous, options);
      const undoIndex = undo.push(restoreRef) - 1;
      const refs = await installPackages(
        { ...targetAddPlan, actions: [targetAction] },
        {
          ...options,
          pluginInstallMode: action.action === "change" ? "update" : "install",
          ...(skillUpgrade?.ok
            ? {
                skillUpgrade: {
                  ref: target.ref,
                  plan: skillUpgrade.plan,
                  assertCurrent: assertSkillUpgradeCurrent,
                },
              }
            : {}),
          deps: {
            ...options.packageDeps,
            preflightPlugin: async (params) => {
              const preflight = await (
                options.packageDeps?.preflightPlugin ?? preflightPluginInstall
              )(params);
              const conflictingOwner = (await readRefs(options)).some(
                (ref) =>
                  ref.agentId !== updatePlan.agentId &&
                  ref.kind === "plugin" &&
                  ref.source === target.source &&
                  ref.ref === target.ref &&
                  ref.version !== target.version,
              );
              return !preflight.ok &&
                preflight.code === "plugin_version_conflict" &&
                !conflictingOwner &&
                previous?.origin === "claw-introduced" &&
                !previous.independentOwner &&
                previous.version === preflight.installedVersion &&
                target.version === preflight.expectedVersion
                ? {
                    ok: true,
                    action: "install",
                    request: preflight.request,
                    ...(preflight.installedPath ? { installedPath: preflight.installedPath } : {}),
                  }
                : preflight;
            },
            persistPackageRef: async (
              _plan: ClawAddPlan,
              _pkg: ResolvedClawPackage,
              persistOptions?: Parameters<typeof persistClawPackageRef>[2],
            ) => {
              const next = {
                ...claimed,
                status: persistOptions?.status ?? "complete",
                relationship: preservesExistingEdge
                  ? claimed.relationship
                  : (persistOptions?.relationship ?? claimed.relationship),
                origin: preservesExistingEdge
                  ? claimed.origin
                  : (persistOptions?.origin ?? claimed.origin),
                independentOwner: preservesExistingEdge
                  ? claimed.independentOwner
                  : (persistOptions?.independentOwner ?? claimed.independentOwner),
                updatedAtMs: nowMs,
              };
              await replaceExpected(claimed, next, options);
              claimed = next;
              return next;
            },
            completePackageRef: async (
              ref: PersistedClawPackageRef,
              status: PersistedClawPackageRef["status"],
            ) => {
              const completedAtMs = status === "complete" ? Math.max(nowMs, Date.now()) : nowMs;
              const next = {
                ...ref,
                status,
                ...(!preservesExistingEdge && status === "complete"
                  ? { installedAtMs: completedAtMs }
                  : {}),
                updatedAtMs: completedAtMs,
              };
              await replaceExpected(claimed, next, options);
              claimed = next;
              return next;
            },
          },
          onExternalMutation: () => {
            externalMutations.push(`${target.kind}:${target.ref}@${target.version}`);
          },
          onSkillTransaction: (_pkg, transaction) => {
            skillTransactions.push(transaction);
            undo[undoIndex] = async () => {
              const acquireLease =
                options.packageDeps?.acquirePackageLease ?? acquireClawPackageLifecycleLease;
              const acquired = acquireLease(
                {
                  kind: "skill",
                  source: "clawhub",
                  ref: target.ref,
                  workspace: targetAddPlan.agent.workspace,
                },
                { env: options.env, path: options.path, required: true },
              );
              if (!acquired) {
                throw new Error(`Could not acquire package lifecycle lease for ${target.ref}.`);
              }
              const lease = maintainClawPackageLifecycleLease(acquired);
              try {
                lease.assertCurrent();
                const liveRefs = await readRefs(options);
                if (
                  previous &&
                  hasOtherWorkspaceSkillOwner({
                    workspace: targetAddPlan.agent.workspace,
                    previous,
                    refs: liveRefs,
                    installs: await readInstalls(),
                  })
                ) {
                  throw new Error(`Another Claw now shares skill ${JSON.stringify(target.ref)}.`);
                }
                const liveRef = liveRefs.find(
                  (candidate) =>
                    candidate.agentId === updatePlan.agentId &&
                    clawPackageKey(candidate) === action.id,
                );
                if (!liveRef || digestClawPackageRef(liveRef) !== digestClawPackageRef(claimed)) {
                  throw new Error(
                    `Skill ${JSON.stringify(target.ref)} ownership changed during rollback.`,
                  );
                }
                await transaction.rollback();
                lease.assertCurrent();
                await restoreRef();
              } finally {
                lease.release();
              }
            };
          },
        },
      );
      const installed = refs.find(
        (ref) => clawPackageKey(ref) === action.id && ref.version === target.version,
      );
      if (!installed) {
        throw new ClawPackageUpdateError(
          `Package installer did not return exact ownership for ${JSON.stringify(action.id)}.`,
          true,
        );
      }
      if (digest(installed) !== digest(claimed)) {
        await replaceExpected(claimed, installed, options);
        claimed = installed;
      }
      appliedIds.push(action.id);
    }
  } catch (error) {
    if (externalMutations.length > 0) {
      throw new ClawPackageUpdateError(
        `${coerceErrorMessage(error)}; package artifact outcome requires reconciliation`,
        true,
        { cause: error },
      );
    }
    try {
      await rollback();
    } catch (rollbackError) {
      throw new ClawPackageUpdateError(
        `${coerceErrorMessage(error)}; rollback incomplete: ${coerceErrorMessage(rollbackError)}`,
        true,
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw new ClawPackageUpdateError(
      coerceErrorMessage(error),
      error instanceof ClawPackageUpdateError ? error.partial : false,
      { cause: error },
    );
  }
  return {
    appliedIds,
    rollback,
    commit: async () => {
      for (const transaction of skillTransactions) {
        await transaction.commit();
      }
    },
  };
}
