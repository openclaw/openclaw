import { realpath } from "node:fs/promises";
import {
  readConfigFileSnapshotWithPluginMetadata,
  type ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import {
  assertGatewayPluginFreeMaintenanceConfig,
  resolveGatewayUpgradeMaintenanceConfigIdentity,
} from "../infra/upgrade-recipes/maintenance-config.js";
import type { UpgradeRecipeMaintenanceReceipt } from "../infra/upgrade-recipes/maintenance-contract.js";
import type { createUpgradeRecipeMaintenanceOwner } from "../infra/upgrade-recipes/maintenance.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import {
  beginGatewayUpgradeMaintenance,
  getGatewayUpgradeMaintenanceBinding,
  isGatewayWorkAdmissionClosed,
} from "../process/gateway-work-admission.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { VERSION, resolveRuntimeServiceBuildId } from "../version.js";
import type { GatewayServerOptions } from "./server-public.js";

type MaintenanceOwner = ReturnType<typeof createUpgradeRecipeMaintenanceOwner>;
export type GatewayUpgradeMaintenanceObservation = {
  protocol: 1;
  qualification: "plugin-free";
  version: string;
  buildId: string;
  runtimeExecutable: string;
  installationRoot: string;
  stateRoot: string;
  configPath: string;
  /** Original approved config revision, including owned include files. */
  configHash: string;
  /** Resolved authored policy, including environment substitutions. */
  configSourceDigest: string;
  profile: string;
  ready: boolean;
  businessAdmissionClosed: boolean;
};
export type GatewayUpgradeMaintenanceStartup = {
  owner: MaintenanceOwner;
  qualification: "plugin-free";
  expected: Omit<
    GatewayUpgradeMaintenanceObservation,
    "protocol" | "qualification" | "ready" | "businessAdmissionClosed"
  >;
  /** Native updater checks its exact migrated resource contracts through read-only owners. */
  verifyStatePostconditions: (observed: GatewayUpgradeMaintenanceObservation) => Promise<void>;
};

function reject(message: string): never {
  throw new Error(`Gateway plugin-free upgrade maintenance refused: ${message}`);
}

export async function assertGatewayUpgradeMaintenanceStartup(
  startup: GatewayUpgradeMaintenanceStartup,
  selected: ReadConfigFileSnapshotWithPluginMetadataResult | undefined,
): Promise<void> {
  startup.owner.assertCurrent();
  if (
    startup.qualification !== "plugin-free" ||
    !selected?.snapshot.valid ||
    !selected.snapshot.exists
  ) {
    reject("a valid owner-selected plugin-free config is required");
  }
  assertGatewayPluginFreeMaintenanceConfig(selected.snapshot.sourceConfig);
  const loadedRoot = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
  const buildId = resolveRuntimeServiceBuildId();
  if (!loadedRoot || !buildId) {
    reject("loaded installation/build identity is unavailable");
  }
  const observed = {
    version: VERSION,
    buildId,
    runtimeExecutable: await realpath(process.execPath),
    installationRoot: await realpath(loadedRoot),
    stateRoot: await realpath(resolveStateDir()),
    configPath: await realpath(selected.snapshot.path),
    ...resolveGatewayUpgradeMaintenanceConfigIdentity(selected.snapshot),
    profile: process.env.OPENCLAW_PROFILE ?? "default",
  };
  const expected = startup.expected;
  if (
    observed.version !== expected.version ||
    observed.buildId !== expected.buildId ||
    observed.runtimeExecutable !== expected.runtimeExecutable ||
    observed.installationRoot !== expected.installationRoot ||
    observed.stateRoot !== expected.stateRoot ||
    observed.configPath !== expected.configPath ||
    observed.configHash !== expected.configHash ||
    observed.configSourceDigest !== expected.configSourceDigest ||
    observed.profile !== expected.profile ||
    observed.installationRoot !== startup.owner.binding.installationKey ||
    observed.stateRoot !== startup.owner.binding.stateRootKey
  ) {
    reject("runtime, build, installation, or selected profile differs from the pinned plan");
  }
  startup.owner.assertCurrent();
}

/**
 * Local native API: the caller retains the same Gateway and update owners across
 * both kernels. There is no RPC token that can manufacture executor authority.
 */
export async function startGatewayUpgradeMaintenance(
  port: number,
  startup: GatewayUpgradeMaintenanceStartup,
  gatewayOptions: GatewayServerOptions & {
    gatewayStateOwner: NonNullable<GatewayServerOptions["gatewayStateOwner"]>;
  },
) {
  startup.owner.assertCurrent();
  const required = await startup.owner.read();
  if (
    !required ||
    (required.phase !== "maintenance-required" && required.phase !== "commit-intent") ||
    JSON.stringify(required.binding) !== JSON.stringify(startup.owner.binding)
  ) {
    reject("the exact unresolved durable maintenance receipt is missing");
  }
  // Durable intent is evidence of possible external work, not recovered authority.
  // Only the same live executor can authorize verification of the current target.
  if (required.phase === "commit-intent") {
    await startup.owner.verifyCommitIntent(required.binding);
  }
  const selected = await withArtifactPreservingStateReads(() =>
    readConfigFileSnapshotWithPluginMetadata({ observe: false }),
  );
  await assertGatewayUpgradeMaintenanceStartup(startup, selected);
  beginGatewayUpgradeMaintenance(startup.owner);
  const { startGatewayServer } = await import("./server.js");
  let server = await withArtifactPreservingStateReads(() =>
    startGatewayServer(port, {
      ...gatewayOptions,
      bind: "loopback",
      host: "127.0.0.1",
      tailscale: { mode: "off" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      ambientEnvTriggers: "suppress",
      startupConfigSnapshotRead: selected,
      upgradeMaintenance: startup,
    }),
  );
  try {
    await server.startupSettled;
  } catch (error) {
    // Startup may have partially prepared the restricted kernel. Settle it while
    // retaining exclusion; recovery never restores an older state snapshot.
    try {
      await server.close({
        reason: "upgrade maintenance startup failed; original recovery required",
      });
    } catch (cleanupError) {
      const cleanupFailure = new CommandProcessCleanupError({ cause: cleanupError });
      throw new AggregateError(
        [error, cleanupFailure],
        "Upgrade maintenance startup and cleanup failed.",
        {
          cause: cleanupError,
        },
      );
    }
    throw error;
  }
  let phase: "maintenance" | "committing" | "committed" | "recovery-required" = "maintenance";
  let closed = false;
  let activationAdmission: ReturnType<typeof beginGatewayUpgradeMaintenance> | undefined;
  const status = async (): Promise<GatewayUpgradeMaintenanceObservation> => {
    startup.owner.assertCurrent();
    if (
      closed ||
      phase !== "maintenance" ||
      JSON.stringify(getGatewayUpgradeMaintenanceBinding()) !==
        JSON.stringify(startup.owner.binding)
    ) {
      reject("the verified maintenance kernel is no longer current");
    }
    const fresh = await withArtifactPreservingStateReads(() =>
      readConfigFileSnapshotWithPluginMetadata({ observe: false }),
    );
    await assertGatewayUpgradeMaintenanceStartup(startup, fresh);
    if (
      JSON.stringify(fresh.snapshot.sourceConfig) !== JSON.stringify(selected.snapshot.sourceConfig)
    ) {
      reject("the approved configuration changed after maintenance startup");
    }
    const readiness = server.getUpgradeMaintenanceReadiness?.();
    const observed: GatewayUpgradeMaintenanceObservation = {
      ...startup.expected,
      protocol: 1,
      qualification: "plugin-free",
      ready: readiness?.ready === true && readiness.failing.length === 0,
      businessAdmissionClosed: isGatewayWorkAdmissionClosed(),
    };
    if (!observed.ready || !observed.businessAdmissionClosed) {
      reject("target runtime/state readiness or business exclusion is unverified");
    }
    await startup.verifyStatePostconditions(observed);
    startup.owner.assertCurrent();
    return observed;
  };
  const commit = async (): Promise<UpgradeRecipeMaintenanceReceipt> => {
    await status();
    // Mark before yielding: another request cannot start a concurrent activation.
    if (phase !== "maintenance") {
      reject("another commit already owns activation");
    }
    phase = "committing";
    try {
      const current = await startup.owner.read();
      if (
        !current ||
        current.phase !== required.phase ||
        JSON.stringify(current.binding) !== JSON.stringify(startup.owner.binding) ||
        current.revision !== required.revision
      ) {
        reject("maintenance receipt changed before commit");
      }
      let intent = current;
      if (current.phase === "commit-intent") {
        await startup.owner.verifyCommitIntent(current.binding);
      } else {
        intent = await startup.owner.recordCommitIntent(current.revision);
      }
      // Keep all business work excluded while this verified kernel is retired.
      await server.close({ reason: "upgrade maintenance verified; native commit activation" });
      startup.owner.assertCurrent();
      const activationConfig = await withArtifactPreservingStateReads(() =>
        readConfigFileSnapshotWithPluginMetadata({ observe: false }),
      );
      await assertGatewayUpgradeMaintenanceStartup(startup, activationConfig);
      if (
        activationConfig.snapshot.hash !== selected.snapshot.hash ||
        JSON.stringify(activationConfig.snapshot.sourceConfig) !==
          JSON.stringify(selected.snapshot.sourceConfig)
      ) {
        reject("the approved configuration changed before activation");
      }
      // Kernel close can retire admission generations. Reacquire only with the
      // identical captured executor; lifecycle reset cannot remove this gate.
      activationAdmission = beginGatewayUpgradeMaintenance(startup.owner);
      await activationAdmission.commit();
      const {
        upgradeMaintenance: _maintenance,
        startupConfigSnapshotRead: _snapshot,
        ...normalOptions
      } = gatewayOptions;
      server = await startGatewayServer(port, {
        ...normalOptions,
        startupConfigSnapshotRead: activationConfig,
        upgradeActivation: { owner: startup.owner },
      });
      await server.startupSettled;
      startup.owner.assertCurrent();
      const committed = await startup.owner.recordCommitted(intent.revision);
      phase = "committed";
      return committed;
    } catch (error) {
      phase = "recovery-required";
      activationAdmission?.failClosed();
      // Intent remains durable. Never restore historical state or pretend no work
      // happened merely because ordinary startup or receipt recording failed.
      try {
        await server.close({ reason: "upgrade activation failed; original recovery required" });
        closed = true;
      } catch (cleanupError) {
        const cleanupFailure = new CommandProcessCleanupError({ cause: cleanupError });
        throw new AggregateError(
          [error, cleanupFailure],
          "Upgrade activation and cleanup failed.",
          {
            cause: cleanupError,
          },
        );
      }
      throw error;
    }
  };
  return {
    protocol: 1 as const,
    qualification: "plugin-free" as const,
    status,
    commit,
    close: async () => {
      closed = true;
      await server.close({ reason: "native upgrade maintenance owner closed" });
    },
  };
}
