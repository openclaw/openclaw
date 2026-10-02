import { isDeepStrictEqual } from "node:util";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-record-reader.js";
import { resolveInstalledClawHubPlugin } from "../plugins/plugin-install-preflight.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { verifyOpenClawStateLeaseOwnership } from "../state/openclaw-state-lease-storage.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { readClawInventory } from "./inventory-read.js";
import type { ClawInventory } from "./inventory-read.kernel.js";
import { digestClawRemovalInstall } from "./package-remove-plan.js";
import type { PackageRemovalDeps } from "./package-remove.js";
import { readClawRemoveFacts } from "./remove-facts-read.js";
import { executeClawMutationStateCommand } from "./state-mutation-write.js";

export function createGatewayClawPackageRemovalState(input: {
  agentId: string;
  operationId: string;
  expectedInstallDigest: string;
  assertCurrent: () => void;
}) {
  const context = captureOpenClawStateReadWorkerContext();
  const stateOptions = {
    path: context.admission.databasePath,
    env: context.environment,
  };
  let lastInventory: ClawInventory | undefined;
  let deletionLeaseOwner: string | undefined;

  const assertCurrent = () => {
    context.admission.assertCurrent();
    input.assertCurrent();
    if (deletionLeaseOwner) {
      verifyOpenClawStateLeaseOwnership({
        scope: "core:agent-deletion",
        key: input.agentId,
        owner: deletionLeaseOwner,
        leaseLabel: "agent deletion",
        database: { scope: "shared", schemaPolicy: "existing", options: stateOptions },
      });
    }
  };
  const readInventory = async () => {
    assertCurrent();
    const inventory = await readClawInventory(stateOptions, { context, current: true });
    assertCurrent();
    lastInventory = inventory;
    return inventory;
  };
  const assertOwner = async () => {
    assertCurrent();
    const facts = await readClawRemoveFacts(input.agentId, [], stateOptions, {
      context,
      current: true,
    });
    assertCurrent();
    if (
      facts.journal?.operationId !== input.operationId ||
      facts.journal.cleanupCompleted ||
      !facts.deletionLease ||
      facts.deletionLease.expiresAt === null ||
      facts.deletionLease.expiresAt <= Date.now() ||
      (deletionLeaseOwner !== undefined && facts.deletionLease.owner !== deletionLeaseOwner) ||
      digestClawRemovalInstall(facts.install ?? undefined) !== input.expectedInstallDigest
    ) {
      throw new Error("Claw package cleanup no longer owns the current removal state.");
    }
    deletionLeaseOwner = facts.deletionLease.owner;
    assertCurrent();
  };
  const loadInstallRecords = async () => {
    clearLoadInstalledPluginIndexInstallRecordsCache();
    return await loadInstalledPluginIndexInstallRecords({
      filePath: stateOptions.path,
      stateDir: resolveOpenClawStateDirForDatabasePath(stateOptions.path),
      env: stateOptions.env,
      artifactPreservingReadOnly: true,
    });
  };
  const deps: PackageRemovalDeps = {
    readPackageRefs: async () => (await readInventory()).packages,
    readInstallRecords: async () => (lastInventory ?? (await readInventory())).installs,
    resolvePlugin: async ({ clawhubPackage }) =>
      await resolveInstalledClawHubPlugin({ clawhubPackage, loadInstallRecords }),
    claimPackageRef: async (ref, status, _options, authority) => {
      const assertOwned = () => {
        assertCurrent();
        authority?.assertCurrent();
      };
      assertOwned();
      if (!authority?.packageLeaseIdentity) {
        throw new Error("Claw package cleanup requires its exact package lifecycle lease.");
      }
      const inventory = lastInventory;
      if (!inventory) {
        throw new Error("Claw package ownership has not been inspected.");
      }
      const workspace = inventory.installs.find(
        (install) => install.agentId === ref.agentId,
      )?.workspace;
      const expectedArtifactRefs = inventory.packages.filter(
        (candidate) =>
          candidate.kind === ref.kind &&
          candidate.source === ref.source &&
          candidate.ref === ref.ref &&
          (ref.kind !== "skill" ||
            candidate.agentId === ref.agentId ||
            (workspace !== undefined &&
              inventory.installs.some(
                (install) =>
                  install.agentId === candidate.agentId && install.workspace === workspace,
              ))),
      );
      const currentRef = expectedArtifactRefs.find(
        (candidate) =>
          candidate.agentId === ref.agentId &&
          candidate.version === ref.version &&
          candidate.integrity === ref.integrity,
      );
      if (
        !currentRef ||
        (status === "pending"
          ? !isDeepStrictEqual(currentRef, ref)
          : currentRef.status !== "pending")
      ) {
        throw new Error("Claw package reference changed before cleanup claim.");
      }
      const updated = await executeClawMutationStateCommand(
        { ...stateOptions, stateMode: "worker", assertCurrent },
        {
          type: "claws.remove.packageRefStatus",
          input: {
            agentId: input.agentId,
            operationId: input.operationId,
            expectedInstallDigest: input.expectedInstallDigest,
            packageLease: authority.packageLeaseIdentity,
            expectedRef: currentRef,
            expectedArtifactRefs,
            status,
          },
        },
      );
      lastInventory = {
        ...inventory,
        packages: inventory.packages.map((candidate) =>
          candidate === currentRef ? updated : candidate,
        ),
      };
      assertOwned();
      return updated;
    },
  };
  return { assertCurrent, assertOwner, deps };
}
