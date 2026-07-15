import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { installClawPackages, type PackageInstallerDeps } from "./packages.js";
import {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  readClawPackageRefs,
  replaceClawPackageRefExpected,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan, ClawManifest, ClawPackage } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";

export type ClawPackageUpdateExecution = {
  appliedIds: string[];
  rollback: () => Promise<void>;
};

export class ClawPackageUpdateError extends Error {
  constructor(
    message: string,
    readonly partial: boolean,
  ) {
    super(message);
    this.name = "ClawPackageUpdateError";
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function packageKey(value: Pick<ClawPackage, "kind" | "ref">): string {
  return `${value.kind}:${value.ref}`;
}

export async function applyClawPackageUpdate(
  updatePlan: ClawUpdatePlan,
  targetManifest: ClawManifest,
  targetAddPlan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    installPackages?: typeof installClawPackages;
    readRefs?: typeof readClawPackageRefs;
    replaceExpected?: typeof replaceClawPackageRefExpected;
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
  const readRefs = options.readRefs ?? readClawPackageRefs;
  const replaceExpected = options.replaceExpected ?? replaceClawPackageRefExpected;
  const currentRefs = new Map(
    readRefs({ ...options, agentId: updatePlan.agentId }).map((ref) => [packageKey(ref), ref]),
  );
  const allRefs = readRefs(options);
  const targets = new Map(targetManifest.packages.map((pkg) => [packageKey(pkg), pkg]));
  const undo: Array<() => Promise<void>> = [];
  const externalMutations: string[] = [];
  const appliedIds: string[] = [];

  const rollback = async () => {
    const failures: string[] = [];
    for (const revert of undo.toReversed()) {
      try {
        await revert();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (externalMutations.length > 0) {
      failures.push(`installed package artifacts were retained: ${externalMutations.join(", ")}`);
    }
    if (failures.length > 0) {
      throw new ClawPackageUpdateError(failures.join("; "), externalMutations.length > 0);
    }
  };

  try {
    for (const action of actions) {
      const previous = currentRefs.get(action.id);
      if (previous && action.currentDigest && digest(previous) !== action.currentDigest) {
        throw new ClawPackageUpdateError(
          `Package reference ${JSON.stringify(action.id)} changed after planning.`,
          false,
        );
      }
      if (action.action === "remove") {
        if (!previous) {
          throw new ClawPackageUpdateError(
            `Package reference ${JSON.stringify(action.id)} disappeared.`,
            false,
          );
        }
        replaceExpected(previous, undefined, options);
        undo.push(async () => replaceExpected(undefined, previous, options));
        appliedIds.push(action.id);
        continue;
      }

      const target = targets.get(action.id);
      const targetAction = targetAddPlan.actions.find(
        (candidate) => candidate.kind === "package" && candidate.id === action.id,
      );
      if (!target || !targetAction) {
        throw new ClawPackageUpdateError(
          `Target package action ${JSON.stringify(action.id)} is missing.`,
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
      let claimed: PersistedClawPackageRef = {
        schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
        agentId: updatePlan.agentId,
        clawName: targetAddPlan.claw.name,
        kind: target.kind,
        source: target.source,
        ref: target.ref,
        version: target.version,
        status: "pending",
        ownership: "claw-installed",
        installedAtMs: options.nowMs ?? Date.now(),
      };
      replaceExpected(previous, claimed, options);
      undo.push(async () => replaceExpected(claimed, previous, options));
      externalMutations.push(`${target.kind}:${target.ref}@${target.version}`);
      const refs = await installPackages(
        { ...targetAddPlan, actions: [targetAction] },
        {
          ...options,
          deps: {
            ...options.packageDeps,
            persistPackageRef: (_plan, _pkg, persistOptions) => {
              const next = {
                ...claimed,
                status: persistOptions?.status ?? "complete",
                ownership: persistOptions?.ownership ?? "claw-installed",
              };
              replaceExpected(claimed, next, options);
              claimed = next;
              return next;
            },
            completePackageRef: (ref, status) => {
              const next = { ...ref, status };
              replaceExpected(claimed, next, options);
              claimed = next;
              return next;
            },
          },
        },
      );
      const installed = refs.find(
        (ref) => packageKey(ref) === action.id && ref.version === target.version,
      );
      if (!installed) {
        throw new ClawPackageUpdateError(
          `Package installer did not return exact ownership for ${JSON.stringify(action.id)}.`,
          true,
        );
      }
      if (digest(installed) !== digest(claimed)) {
        replaceExpected(claimed, installed, options);
        claimed = installed;
      }
      appliedIds.push(action.id);
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new ClawPackageUpdateError(
        `${error instanceof Error ? error.message : String(error)}; rollback incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        externalMutations.length > 0,
      );
    }
    throw new ClawPackageUpdateError(
      error instanceof Error ? error.message : String(error),
      error instanceof ClawPackageUpdateError ? error.partial : false,
    );
  }
  return { appliedIds, rollback };
}
