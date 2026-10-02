import { coerceErrorMessage } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { clawPackageKey } from "./application-provenance.js";
import { digestClawValue as digest } from "./digest.js";
import {
  digestClawPackageRef,
  replaceClawPackageRefExpected,
} from "./package-update-provenance.js";
import { installClawPackages, type ClawPluginInstallConsent } from "./packages.js";
import type { ClawPluginRuntimeOptions } from "./plugin-runtime.js";
import {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  persistClawPackageRef,
  readClawPackageRefs,
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
      installPackages?: typeof installClawPackages;
      readRefs?: (
        options?: Parameters<typeof readClawPackageRefs>[0],
      ) => ReturnType<typeof readClawPackageRefs> | Promise<ReturnType<typeof readClawPackageRefs>>;
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
  const appliedIds: string[] = [];

  const rollback = async () => {
    const failures = await collectClawRollbackFailures(undo.toReversed());
    if (externalMutations.length > 0) {
      failures.push(`package artifacts may have been retained: ${externalMutations.join(", ")}`);
    }
    if (failures.length > 0) {
      throw new ClawPackageUpdateError(failures.join("; "), externalMutations.length > 0);
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
      await replaceExpected(previous, claimed, options);
      undo.push(async () => await replaceExpected(claimed, previous, options));
      const refs = await installPackages(
        { ...targetAddPlan, actions: [targetAction] },
        {
          ...options,
          pluginInstallMode: action.action === "change" ? "update" : "install",
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
              const next = { ...ref, status, updatedAtMs: nowMs };
              await replaceExpected(claimed, next, options);
              claimed = next;
              return next;
            },
          },
          onExternalMutation: () => {
            externalMutations.push(`${target.kind}:${target.ref}@${target.version}`);
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
        externalMutations.length > 0,
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw new ClawPackageUpdateError(
      coerceErrorMessage(error),
      error instanceof ClawPackageUpdateError ? error.partial : false,
      { cause: error },
    );
  }
  return { appliedIds, rollback };
}
