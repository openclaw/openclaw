import { realpath } from "node:fs/promises";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import {
  readUpdateStateSchemaVersions,
  type UpdateStateSchemaVersion,
} from "../../infra/update-candidate-state.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { UpgradeRecipeMaintenanceReceipt } from "../../infra/upgrade-recipes/maintenance-contract.js";
import { createUpgradeRecipeMaintenanceOwner } from "../../infra/upgrade-recipes/maintenance.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { assertOpenClawDatabasesReady } from "../../state/openclaw-database-preflight.js";
import { withArtifactPreservingStateReads } from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { withDelegatedUpdateCommandExecutor } from "./update-command-executor-delegated.js";
import {
  UPDATE_RECIPE_MAINTENANCE_CAPABILITY,
  updateRecipeMaintenanceInputSchema,
} from "./update-recipe-maintenance-contract.js";

function normalizedStateVersions(versions: readonly UpdateStateSchemaVersion[]) {
  const paths = new Set<string>();
  return versions
    .map((version) => {
      const pathname = path.resolve(version.path);
      if (pathname !== version.path || paths.has(pathname)) {
        throw new Error("Upgrade maintenance state contracts contain conflicting resource paths.");
      }
      paths.add(pathname);
      return {
        path: pathname,
        userVersion: version.userVersion,
        contentVersion: version.contentVersion ?? version.userVersion,
      };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

/** Target-installed receiver only: a retained runner must launch, bind, then send private input. */
export async function runUpdateRecipeMaintenanceReceiver(raw: unknown) {
  const input = updateRecipeMaintenanceInputSchema.parse(raw);
  const root = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
  if (
    !root ||
    (await realpath(root)) !== input.expected.installationRoot ||
    resolveUpdateInstallRoot(root) !== input.binding.installationKey ||
    input.executor.runId !== input.binding.runId ||
    input.executor.root !== input.binding.installationKey ||
    input.expected.stateRoot !== input.binding.stateRootKey ||
    (await realpath(resolveStateDir())) !== input.binding.stateRootKey
  ) {
    throw new Error("Upgrade maintenance receiver does not match its selected target/state owner.");
  }
  const expectedVersions = normalizedStateVersions(input.stateVersions);
  const env = cloneEnvWithPlatformSemantics(process.env);
  const shared = resolveOpenClawStateSqlitePath(env);
  if (!expectedVersions.some((entry) => entry.path === shared && entry.userVersion !== null)) {
    throw new Error("Upgrade maintenance requires the approved existing shared-state contract.");
  }
  return await withDelegatedUpdateCommandExecutor(
    input.executor,
    input.binding.runId,
    input.binding.installationKey,
    async (fence) => {
      fence.assertCurrent();
      const lock = await acquireGatewayLock({
        env,
        port: input.port,
        listenerMode: "foreground",
        // The parent must already have quiesced the selected service. Retrying
        // acquisition after a wait would need a fresh native pre-acquire guard.
        timeoutMs: 0,
      });
      if (!lock) {
        throw new Error("Upgrade maintenance receiver requires a physical Gateway state owner.");
      }
      let releaseStateOwner = true;
      try {
        return await lock.run(async () => {
          const assertCurrent = () => {
            fence.assertCurrent();
            lock.assertCurrent();
          };
          assertCurrent();
          const guards = createUpdateCommandExecutionGuards(
            { run: { runId: input.binding.runId, env, executorFence: fence } },
            input.binding.installationKey,
          );
          const captured = guards.captureWriteOptions();
          const pendingWrites: Promise<PromiseSettledResult<void>>[] = [];
          const owner = createUpgradeRecipeMaintenanceOwner(input.binding, {
            ...captured,
            assertCurrent: () => {
              captured.assertCurrent();
              assertCurrent();
            },
            retainSettlement: (completion) => {
              captured.retainSettlement?.(completion);
              pendingWrites.push(
                completion.then(
                  () => ({ status: "fulfilled" as const, value: undefined }),
                  (reason: unknown) => ({ status: "rejected" as const, reason }),
                ),
              );
            },
          });
          const { startGatewayUpgradeMaintenance } =
            await import("../../gateway/server-upgrade-maintenance.js");
          let server: Awaited<ReturnType<typeof startGatewayUpgradeMaintenance>> | undefined;
          let result: UpgradeRecipeMaintenanceReceipt | undefined;
          let failure: { error: unknown } | undefined;
          try {
            server = await startGatewayUpgradeMaintenance(
              input.port,
              {
                owner,
                qualification: "plugin-free",
                expected: input.expected,
                verifyStatePostconditions: async () => {
                  assertCurrent();
                  const selected = await withArtifactPreservingStateReads(() =>
                    readConfigFileSnapshotWithPluginMetadata({ observe: false }),
                  );
                  assertCurrent();
                  await withArtifactPreservingStateReads(() =>
                    assertOpenClawDatabasesReady({
                      operation: "gateway-restart",
                      env,
                      config: selected.snapshot.sourceConfig,
                    }),
                  );
                  const actual = await readUpdateStateSchemaVersions({
                    root,
                    nodeRunner: process.execPath,
                    stateDir: input.binding.stateRootKey,
                    config: selected.snapshot.sourceConfig,
                    env,
                    timeoutMs: input.timeoutMs,
                  });
                  assertCurrent();
                  if (
                    JSON.stringify(normalizedStateVersions(actual)) !==
                    JSON.stringify(expectedVersions)
                  ) {
                    throw new Error(
                      "Upgrade maintenance current-state contracts differ from the approved plan.",
                    );
                  }
                },
              },
              { gatewayStateOwner: lock },
            );
            result = await server.commit();
          } catch (error) {
            failure = { error };
          }
          // Never let a committed foreground verifier become an unowned daemon.
          // Parent service actions remain suspended until this kernel and writes settle.
          const cleanupFailures: unknown[] = [];
          try {
            await server?.close();
          } catch (cause) {
            // Keep physical state exclusion until this uncertain child is extinct.
            cleanupFailures.push(new CommandProcessCleanupError({ cause }));
          }
          const writes = await Promise.all(pendingWrites);
          for (const write of writes) {
            if (write.status === "rejected") {
              cleanupFailures.push(write.reason);
            }
          }
          try {
            assertCurrent();
          } catch (error) {
            cleanupFailures.push(error);
          }
          if (cleanupFailures.length > 0) {
            throw new AggregateError(
              [...(failure ? [failure.error] : []), ...cleanupFailures],
              "Upgrade maintenance receiver and settlement failed.",
              { cause: cleanupFailures.at(-1) },
            );
          }
          if (failure) {
            throw failure.error;
          }
          if (!result) {
            throw new Error("Upgrade maintenance receiver did not record a completion.");
          }
          return {
            capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY,
            outcome: "target-committed" as const,
            managedServiceVerified: false as const,
            receipt: result,
          };
        });
      } catch (error) {
        releaseStateOwner = !hasCommandProcessCleanupError(error);
        throw error;
      } finally {
        if (releaseStateOwner) {
          await lock.release();
        }
      }
    },
    { activationTimeoutMs: input.timeoutMs },
  );
}
