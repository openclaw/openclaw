import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import {
  PluginRuntimeApplicationError,
  type PluginLifecycleRuntimeApply,
} from "../plugins/lifecycle.js";
import type { uninstallPluginWithPolicy } from "../plugins/management-uninstall.js";
import { resolveInstalledClawHubPlugin } from "../plugins/plugin-install-preflight.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  applyClawHubSkillUninstall,
  planClawHubSkillUninstall,
  type ClawHubSkillUninstallPlan,
} from "../skills/lifecycle/clawhub-uninstall.js";
import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
  type ClawPackageLifecycleLeaseIdentity,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { ClawPackageRemovalPhaseResult } from "./package-remove-contract.js";
import { claimClawPackageRefStatus } from "./provenance-write.js";
import {
  readClawPackageRefs,
  readClawInstallRecords,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";

type ClawReferencedCleanupMode = "retain" | "remove-if-unused" | "remove-selected";

export type ClawReferencedCleanup = {
  mode: ClawReferencedCleanupMode;
  selected?: readonly string[];
  allowConflicts?: boolean;
};

export type ClawPackageRemovalDecision = {
  packageRef: PersistedClawPackageRef;
  workspace: string;
  action: "uninstall" | "retain";
  blocked?: boolean;
  allowConflicts?: boolean;
  reason?: string;
  affectedClawAgentIds: string[];
  pluginId?: string;
  skillPlan?: ClawHubSkillUninstallPlan;
};

export type ClawPackageRemovalResult = ClawPackageRemovalPhaseResult["packages"][number];

type ClawPackageRemovalOutcome = ClawPackageRemovalPhaseResult & {
  runtimeFailure?: PluginRuntimeApplicationError;
};

export type PackageRemovalDeps = {
  readPackageRefs?: (
    options: Parameters<typeof readClawPackageRefs>[0],
  ) => ReturnType<typeof readClawPackageRefs> | Promise<ReturnType<typeof readClawPackageRefs>>;
  readInstallRecords?: (
    options: Parameters<typeof readClawInstallRecords>[0],
  ) =>
    | ReturnType<typeof readClawInstallRecords>
    | Promise<ReturnType<typeof readClawInstallRecords>>;
  claimPackageRef?: (
    ref: Parameters<typeof claimClawPackageRefStatus>[0],
    status: Parameters<typeof claimClawPackageRefStatus>[1],
    options: Parameters<typeof claimClawPackageRefStatus>[2],
    authority?: {
      assertCurrent: () => void;
      packageLeaseIdentity?: ClawPackageLifecycleLeaseIdentity;
    },
  ) => PersistedClawPackageRef | Promise<PersistedClawPackageRef>;
  resolvePlugin?: typeof resolveInstalledClawHubPlugin;
  planSkill?: typeof planClawHubSkillUninstall;
  uninstallSkill?: typeof applyClawHubSkillUninstall;
  uninstallPlugin?: typeof uninstallPluginWithPolicy;
  acquirePackageLease?: typeof acquireClawPackageLifecycleLease;
};

type ClawPackageState = "present" | "missing" | "modified" | "ambiguous" | "incomplete";
export type ClawPackageInspection = PersistedClawPackageRef & {
  state: ClawPackageState;
  message?: string;
};

function sameArtifact(left: PersistedClawPackageRef, right: PersistedClawPackageRef): boolean {
  return left.kind === right.kind && left.source === right.source && left.ref === right.ref;
}

function sameVersionedArtifact(
  left: PersistedClawPackageRef,
  right: PersistedClawPackageRef,
): boolean {
  return sameArtifact(left, right) && left.version === right.version;
}

export function clawPackageRemovalSelector(packageRef: PersistedClawPackageRef): string {
  return `${packageRef.kind}:${packageRef.ref}@${packageRef.version}`;
}

function sameRecordedState(left: PersistedClawPackageRef, right: PersistedClawPackageRef): boolean {
  return (
    left.status === right.status &&
    left.relationship === right.relationship &&
    left.origin === right.origin &&
    (left.independentOwner === right.independentOwner ||
      (right.independentOwner && !left.independentOwner))
  );
}

function otherClawAgentIds(params: {
  packageRef: PersistedClawPackageRef;
  workspace: string;
  refs: PersistedClawPackageRef[];
  installs: PersistedClawInstall[];
  statuses?: ReadonlySet<PersistedClawPackageRef["status"]>;
}): string[] {
  return params.refs
    .filter((candidate) => {
      if (
        candidate.agentId === params.packageRef.agentId ||
        !sameArtifact(candidate, params.packageRef) ||
        (params.statuses && !params.statuses.has(candidate.status))
      ) {
        return false;
      }
      if (params.packageRef.kind === "plugin") {
        return true;
      }
      return params.installs.some(
        (install) =>
          install.agentId === candidate.agentId && install.workspace === params.workspace,
      );
    })
    .map((candidate) => candidate.agentId)
    .toSorted();
}

function ownerInstallIsNewer(
  installedAt: string | number | undefined,
  packageRef: PersistedClawPackageRef,
): boolean {
  const timestamp = typeof installedAt === "number" ? installedAt : Date.parse(installedAt ?? "");
  return Number.isFinite(timestamp) && timestamp > packageRef.updatedAtMs;
}

function pluginIntegrityMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const normalizedActual = normalizeClawHubSha256Integrity(actual);
  const normalizedExpected = normalizeClawHubSha256Integrity(expected);
  return normalizedActual && normalizedExpected
    ? normalizedActual === normalizedExpected
    : actual === expected;
}

type ClawInstalledPackage =
  | {
      state: "present";
      ownerIsNewer: boolean;
      pluginId?: string;
      skillPlan?: ClawHubSkillUninstallPlan;
    }
  | { state: Exclude<ClawPackageState, "present" | "incomplete">; message: string };

async function inspectInstalledPackage(
  install: Pick<PersistedClawInstall, "workspace">,
  packageRef: PersistedClawPackageRef,
  deps: PackageRemovalDeps,
): Promise<ClawInstalledPackage> {
  if (packageRef.kind === "plugin") {
    const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
      clawhubPackage: packageRef.ref,
    });
    if (resolution.status !== "found") {
      return {
        state: resolution.status,
        message:
          resolution.status === "ambiguous"
            ? "Installed plugin identity is ambiguous."
            : "Installed plugin is missing.",
      };
    }
    if (
      resolution.installedVersion !== packageRef.version ||
      !pluginIntegrityMatches(resolution.record.integrity, packageRef.integrity)
    ) {
      return { state: "modified", message: "Installed plugin changed after the Claw was added." };
    }
    return {
      state: "present",
      ownerIsNewer: ownerInstallIsNewer(resolution.record.installedAt, packageRef),
      pluginId: resolution.pluginId,
    };
  }
  if (!install.workspace) {
    return { state: "ambiguous", message: "Skill workspace provenance is missing." };
  }
  const skill = await (deps.planSkill ?? planClawHubSkillUninstall)({
    workspaceDir: install.workspace,
    slug: packageRef.ref,
    expectedVersion: packageRef.version,
  });
  return skill.ok
    ? {
        state: "present",
        ownerIsNewer: ownerInstallIsNewer(skill.plan.installedAt, packageRef),
        skillPlan: skill.plan,
      }
    : { state: skill.code, message: skill.error };
}

export async function inspectClawPackage(
  install: Pick<PersistedClawInstall, "workspace">,
  packageRef: PersistedClawPackageRef,
  deps: PackageRemovalDeps = {},
): Promise<ClawPackageInspection> {
  if (packageRef.status !== "complete") {
    return { ...packageRef, state: "incomplete", message: "Package installation is incomplete." };
  }
  const inspected = await inspectInstalledPackage(install, packageRef, deps);
  return inspected.state === "present"
    ? {
        ...packageRef,
        independentOwner: packageRef.independentOwner || inspected.ownerIsNewer,
        state: "present",
      }
    : {
        ...packageRef,
        state: inspected.state,
        message:
          packageRef.kind === "plugin" && inspected.state === "modified"
            ? "Installed plugin version changed after the Claw was added."
            : inspected.message,
      };
}

export async function planClawPackageRemovals(
  install: Pick<PersistedClawInstall, "workspace">,
  packages: PersistedClawPackageRef[],
  options: OpenClawStateDatabaseOptions & {
    deps?: PackageRemovalDeps;
    referencedCleanup?: ClawReferencedCleanup;
  } = {},
): Promise<ClawPackageRemovalDecision[]> {
  const deps = options.deps ?? {};
  const cleanup = options.referencedCleanup ?? { mode: "retain" };
  const selected = new Set(cleanup.selected ?? []);
  const allRefs = await (deps.readPackageRefs ?? readClawPackageRefs)(options);
  let cachedInstalls: Promise<PersistedClawInstall[]> | undefined;
  const allInstalls = (): Promise<PersistedClawInstall[]> =>
    (cachedInstalls ??= Promise.resolve(
      (deps.readInstallRecords ?? readClawInstallRecords)(options),
    ));
  const decisions: ClawPackageRemovalDecision[] = [];
  for (const packageRef of packages) {
    const affectedClawAgentIds = otherClawAgentIds({
      packageRef,
      workspace: install.workspace,
      refs: allRefs,
      installs: packageRef.kind === "plugin" || !install.workspace ? [] : await allInstalls(),
      statuses: new Set(["pending", "complete"]),
    });
    const retain = (reason: string): void => {
      decisions.push({
        packageRef,
        workspace: install.workspace,
        action: "retain",
        reason,
        affectedClawAgentIds,
      });
    };
    if (packageRef.status !== "complete") {
      retain("Package installation is incomplete.");
      continue;
    }
    const selector = clawPackageRemovalSelector(packageRef);
    const explicitlySelected = cleanup.mode === "remove-selected" && selected.has(selector);
    const managedCleanup = packageRef.relationship === "managed";
    if (explicitlySelected && managedCleanup) {
      decisions.push({
        packageRef,
        workspace: install.workspace,
        action: "retain",
        blocked: true,
        reason: "--remove-referenced only accepts resources with a referenced relationship.",
        affectedClawAgentIds,
      });
      continue;
    }
    if (!managedCleanup && !explicitlySelected && cleanup.mode !== "remove-if-unused") {
      retain(
        packageRef.origin === "claw-introduced"
          ? "Claw add introduced this shared requirement; removal releases its dependency edge and retains the artifact. Use its canonical owner separately to uninstall it."
          : "Referenced resources are retained unless a separate cleanup mode selects them.",
      );
      continue;
    }
    if (!explicitlySelected && affectedClawAgentIds.length > 0) {
      retain("Another Claw still references this package.");
      continue;
    }
    if (
      !explicitlySelected &&
      (packageRef.independentOwner || packageRef.origin === "pre-existing")
    ) {
      retain("Package has a current non-Claw owner or pre-existing origin.");
      continue;
    }
    if (
      packageRef.kind === "plugin" &&
      !explicitlySelected &&
      cleanup.mode === "remove-if-unused"
    ) {
      retain(
        "Global plugins are excluded from generic remove-if-unused cleanup; select the plugin explicitly to invoke its canonical owner.",
      );
      continue;
    }

    const inspected = await inspectInstalledPackage(install, packageRef, deps);
    if (inspected.state !== "present") {
      retain(inspected.message);
      continue;
    }
    const { pluginId, skillPlan, ownerIsNewer } = inspected;

    const independentlyOwned = packageRef.independentOwner || ownerIsNewer;
    const hasConflicts =
      affectedClawAgentIds.length > 0 || independentlyOwned || packageRef.origin === "pre-existing";
    if (!explicitlySelected && hasConflicts) {
      retain("Package has a current non-Claw owner or pre-existing origin.");
      continue;
    }
    if (!explicitlySelected && packageRef.origin !== "claw-introduced") {
      retain("Only Claw-introduced referenced resources qualify for remove-if-unused.");
      continue;
    }
    if (explicitlySelected && hasConflicts && !cleanup.allowConflicts) {
      decisions.push({
        packageRef,
        workspace: install.workspace,
        action: "retain",
        blocked: true,
        reason:
          "Selected resource has other Claw dependents, a non-Claw owner, or pre-existing origin; explicit conflict override is required.",
        affectedClawAgentIds,
        ...(pluginId ? { pluginId } : {}),
        ...(skillPlan ? { skillPlan } : {}),
      });
      continue;
    }
    decisions.push({
      packageRef,
      workspace: install.workspace,
      action: "uninstall",
      ...(explicitlySelected && cleanup.allowConflicts ? { allowConflicts: true } : {}),
      affectedClawAgentIds,
      ...(pluginId ? { pluginId } : {}),
      ...(skillPlan ? { skillPlan } : {}),
    });
  }
  return decisions;
}

type ApplyClawPackageRemovalOptions = OpenClawStateDatabaseOptions & {
  applyRuntime?: PluginLifecycleRuntimeApply;
  deps?: PackageRemovalDeps;
  assertCurrent?: () => void;
  assertWorkerAdmissionCurrent?: () => void;
};

export async function applyClawPackageRemovals(
  decisions: ClawPackageRemovalDecision[],
  options: ApplyClawPackageRemovalOptions = {},
): Promise<ClawPackageRemovalOutcome> {
  if (!decisions.some((decision) => decision.packageRef.kind === "plugin")) {
    return await applyClawPackageRemovalsUnlocked(decisions, options);
  }
  return await withPluginLifecycleLease(
    {
      ...(options.env ? { env: options.env } : {}),
      ...(options.path ? { path: options.path } : {}),
      ...(options.database ? { database: options.database } : {}),
    },
    async () => await applyClawPackageRemovalsUnlocked(decisions, options),
  );
}

async function applyClawPackageRemovalsUnlocked(
  decisions: ClawPackageRemovalDecision[],
  options: ApplyClawPackageRemovalOptions,
): Promise<ClawPackageRemovalOutcome> {
  const deps = options.deps ?? {};
  const results: ClawPackageRemovalResult[] = [];
  const warnings = new Set<string>();
  let runtimeFailure: PluginRuntimeApplicationError | undefined;
  for (const decision of decisions) {
    const base = {
      kind: decision.packageRef.kind,
      ref: decision.packageRef.ref,
      version: decision.packageRef.version,
    };
    if (runtimeFailure) {
      results.push({
        ...base,
        action: "retained",
        reason: "Package cleanup stopped after a Gateway runtime replacement failed.",
      });
      continue;
    }
    let packageLease: MaintainedClawPackageLifecycleLease | null = null;
    let claimed = false;
    let claimedRef: PersistedClawPackageRef | undefined;
    let externalMutationStarted = false;
    const assertCurrent = () => {
      options.assertCurrent?.();
      packageLease?.assertCurrent();
    };
    const claimPackageRef = async (
      ref: PersistedClawPackageRef,
      status: PersistedClawPackageRef["status"],
    ) => {
      assertCurrent();
      if (!packageLease) {
        throw new Error("Package status write requires its lifecycle lease.");
      }
      const lease = packageLease;
      const claimOptions = { ...options, lease };
      const result = await lease.withHeartbeatPaused(async () =>
        deps.claimPackageRef
          ? await deps.claimPackageRef(ref, status, claimOptions, {
              assertCurrent,
              ...(lease.identity ? { packageLeaseIdentity: lease.identity } : {}),
            })
          : await claimClawPackageRefStatus(ref, status, {
              ...claimOptions,
              assertCurrent: options.assertWorkerAdmissionCurrent ?? options.assertCurrent,
            }),
      );
      claimedRef = result;
      assertCurrent();
      return result;
    };
    try {
      assertCurrent();
      const leaseArtifact =
        decision.packageRef.kind === "skill"
          ? {
              kind: decision.packageRef.kind,
              source: decision.packageRef.source,
              ref: decision.packageRef.ref,
              workspace: decision.workspace,
            }
          : {
              kind: decision.packageRef.kind,
              source: decision.packageRef.source,
              ref: decision.packageRef.ref,
            };
      const acquiredLease = (deps.acquirePackageLease ?? acquireClawPackageLifecycleLease)(
        leaseArtifact,
        { env: options.env, path: options.path, required: true },
      );
      if (!acquiredLease) {
        throw new Error(
          `Could not acquire package lifecycle lease for ${decision.packageRef.ref}.`,
        );
      }
      packageLease = maintainClawPackageLifecycleLease(acquiredLease);
      const currentRefs = await (deps.readPackageRefs ?? readClawPackageRefs)(options);
      const currentInstalls =
        decision.packageRef.kind === "plugin"
          ? []
          : await (deps.readInstallRecords ?? readClawInstallRecords)(options);
      const currentRef = currentRefs.find(
        (candidate) =>
          candidate.agentId === decision.packageRef.agentId &&
          sameVersionedArtifact(candidate, decision.packageRef),
      );
      if (decision.blocked) {
        throw new Error(decision.reason ?? "Package cleanup is blocked.");
      }
      if (decision.action === "retain") {
        if (!currentRef || !sameRecordedState(currentRef, decision.packageRef)) {
          throw new Error(
            `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed after removal planning.`,
          );
        }
        if (currentRef.status === "complete") {
          await claimPackageRef(currentRef, "pending");
          claimed = true;
        }
        if (decision.reason === "Another Claw still references this package.") {
          const postClaimRefs = await (deps.readPackageRefs ?? readClawPackageRefs)(options);
          const postClaimInstalls =
            decision.packageRef.kind === "plugin"
              ? []
              : await (deps.readInstallRecords ?? readClawInstallRecords)(options);
          if (
            otherClawAgentIds({
              packageRef: decision.packageRef,
              workspace: decision.workspace,
              refs: postClaimRefs,
              installs: postClaimInstalls,
              statuses: new Set(["complete"]),
            }).length === 0
          ) {
            throw new Error(
              `Package ${decision.packageRef.ref}@${decision.packageRef.version} no longer has another surviving Claw owner.`,
            );
          }
        }
        results.push({ ...base, action: "retained", reason: decision.reason });
        continue;
      }
      const sharedPackage =
        otherClawAgentIds({
          packageRef: decision.packageRef,
          workspace: decision.workspace,
          refs: currentRefs,
          installs: currentInstalls,
          statuses: new Set(["complete"]),
        }).length > 0;
      if (
        !currentRef ||
        currentRef.status !== "complete" ||
        !sameRecordedState(currentRef, decision.packageRef) ||
        (sharedPackage && !decision.allowConflicts)
      ) {
        throw new Error(
          `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed after removal planning.`,
        );
      }
      await claimPackageRef(currentRef, "pending");
      claimed = true;
      const postClaimRefs = await (deps.readPackageRefs ?? readClawPackageRefs)(options);
      const postClaimInstalls =
        decision.packageRef.kind === "plugin"
          ? []
          : await (deps.readInstallRecords ?? readClawInstallRecords)(options);
      const postClaimRef = postClaimRefs.find(
        (candidate) =>
          candidate.agentId === decision.packageRef.agentId &&
          sameVersionedArtifact(candidate, decision.packageRef),
      );
      const postClaimShared =
        otherClawAgentIds({
          packageRef: decision.packageRef,
          workspace: decision.workspace,
          refs: postClaimRefs,
          installs: postClaimInstalls,
          statuses: new Set(["complete"]),
        }).length > 0;
      if (
        !postClaimRef ||
        postClaimRef.status !== "pending" ||
        postClaimRef.relationship !== decision.packageRef.relationship ||
        postClaimRef.origin !== decision.packageRef.origin ||
        (postClaimRef.independentOwner !== decision.packageRef.independentOwner &&
          !decision.packageRef.independentOwner) ||
        (postClaimShared && !decision.allowConflicts)
      ) {
        throw new Error(
          `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed while claiming removal.`,
        );
      }
      if (decision.packageRef.kind === "plugin") {
        if (!decision.pluginId) {
          throw new Error("Plugin removal plan is missing canonical install identity.");
        }
        const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
          clawhubPackage: decision.packageRef.ref,
        });
        if (
          resolution.status !== "found" ||
          resolution.pluginId !== decision.pluginId ||
          resolution.installedVersion !== decision.packageRef.version ||
          !pluginIntegrityMatches(resolution.record.integrity, decision.packageRef.integrity) ||
          ownerInstallIsNewer(resolution.record.installedAt, decision.packageRef)
        ) {
          throw new Error(
            `Plugin ${decision.packageRef.ref}@${decision.packageRef.version} changed after removal planning.`,
          );
        }
        assertCurrent();
        const uninstallPlugin =
          deps.uninstallPlugin ??
          (await import("../plugins/management-uninstall.js")).uninstallPluginWithPolicy;
        assertCurrent();
        externalMutationStarted = true;
        const removed = await uninstallPlugin({
          pluginId: decision.pluginId,
          caller: "cli",
          invalidateRuntimeCache: false,
          clawManaged: true,
          applyRuntime: options.applyRuntime,
          beforePersistentApply: assertCurrent,
          onWarning: (warning) => {
            warnings.add(warning);
          },
        });
        if (!removed.ok) {
          throw new Error(removed.error);
        }
        for (const warning of removed.value.warnings) {
          warnings.add(warning);
        }
      } else {
        if (!decision.skillPlan) {
          throw new Error("Skill removal plan is missing canonical uninstall state.");
        }
        assertCurrent();
        externalMutationStarted = true;
        const cleanupOwner = packageLease;
        const removed = await (deps.uninstallSkill ?? applyClawHubSkillUninstall)(
          decision.skillPlan,
          {
            beforePersistentApply: assertCurrent,
            beforeRollback: () => cleanupOwner.assertCurrent(),
          },
        );
        if (!removed.ok) {
          throw new Error(removed.error);
        }
      }
      assertCurrent();
      await claimPackageRef(claimedRef ?? decision.packageRef, "complete");
      results.push({ ...base, action: "uninstalled" });
    } catch (error) {
      // Runtime replacement failure ends this phase, but earlier effects and
      // emitted warnings must survive alongside its exact publication facts.
      if (error instanceof PluginRuntimeApplicationError) {
        runtimeFailure = error;
      }
      if (claimed) {
        try {
          assertCurrent();
          await claimPackageRef(
            claimedRef ?? decision.packageRef,
            externalMutationStarted ? "failed" : "complete",
          );
        } catch {
          // Preserve the original cleanup failure as the actionable result.
        }
      }
      results.push({
        ...base,
        action: "error",
        reason: coerceErrorMessage(error),
      });
    } finally {
      try {
        packageLease?.release();
      } catch {
        // Lease expiry recovers cleanup when the shared state database is unavailable.
      }
    }
  }
  return {
    packages: results,
    ...(warnings.size ? { warnings: [...warnings] } : {}),
    ...(runtimeFailure ? { runtimeFailure } : {}),
  };
}
