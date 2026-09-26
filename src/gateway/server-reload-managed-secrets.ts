import { isDeepStrictEqual } from "node:util";
import { resetContextWindowCache } from "../agents/context.js";
import {
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import {
  getActiveSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
  hasActiveSecretsRuntimeSnapshotLineage,
  hasSameSecretReloadContract,
  restoreSecretsRuntimeSourceSnapshotIfLineageCurrent,
  setSecretsRuntimeSourceSnapshotIfCurrent,
} from "../secrets/runtime-state.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  type ChannelKind,
} from "./config-reload-plan.js";
import { shouldRefreshContextWindowCache } from "./config-reload-recovery.js";
import type {
  GatewayConfigReloadTransactionOwnership,
  startGatewayConfigReloader,
} from "./config-reload.js";
import {
  assertReloadPublicationCurrent,
  GatewayConfigReloadSupersededError,
  GatewayHotReloadRecoveryError,
  GatewayHotReloadStaleSecretsError,
  type CurrentRuntimeSecretsPreparation,
  type GatewayHotReloadPublication,
  type ManagedGatewayConfigReloaderParams,
  type RuntimeSecretsPreflightParams,
} from "./server-reload-contracts.js";
import type { createGatewayReloadHandlers } from "./server-reload-hot.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  type SharedGatewaySessionGenerationOwnership,
} from "./server-shared-auth-generation.js";

export function isRuntimeSecretsPreparationCurrent(
  preparation: CurrentRuntimeSecretsPreparation,
): boolean {
  return getActiveSecretsRuntimeSnapshotRevisionState() === preparation.expectedRevision;
}

type PrepareRuntimeCandidate = (
  runtimeConfig: OpenClawConfig,
  sourceConfig: OpenClawConfig,
  ownership?: GatewayConfigReloadTransactionOwnership,
) => OpenClawConfig;

type TryPrepareRuntimeSecrets = (
  config: OpenClawConfig,
  transactionOwnership: GatewayConfigReloadTransactionOwnership,
  activationParams: RuntimeSecretsPreflightParams,
) => Promise<CurrentRuntimeSecretsPreparation | null>;

type ManagedReloadOptions = Parameters<typeof startGatewayConfigReloader>[0];
type EffectiveConfigUnchangedHandler = NonNullable<
  ManagedReloadOptions["onEffectiveConfigUnchanged"]
>;
type HotReloadHandler = NonNullable<ManagedReloadOptions["onHotReload"]>;

export function createManagedReloadSecretHandlers(options: {
  params: Pick<
    ManagedGatewayConfigReloaderParams,
    | "activateRuntimeSecrets"
    | "assertRuntimeSecurityConfig"
    | "clients"
    | "commitRuntimePolicy"
    | "reconcileRuntimePolicy"
    | "resolveSharedGatewaySessionGenerationForConfig"
    | "sharedGatewaySessionGenerationState"
  >;
  prepareRuntimeCandidate: PrepareRuntimeCandidate;
  tryPrepareRuntimeSecrets: TryPrepareRuntimeSecrets;
  applyHotReload: ReturnType<typeof createGatewayReloadHandlers>["applyHotReload"];
}) {
  const { params, prepareRuntimeCandidate, tryPrepareRuntimeSecrets, applyHotReload } = options;
  const prepareRestartRuntimeConfig = (
    runtimeConfig: OpenClawConfig,
    sourceConfig: OpenClawConfig,
    transactionOwnership: GatewayConfigReloadTransactionOwnership,
  ): Promise<OpenClawConfig> =>
    transactionOwnership.withRestartPreparation(async (ownership) => {
      for (;;) {
        const prepared = await tryPrepareRuntimeSecrets(
          prepareRuntimeCandidate(runtimeConfig, sourceConfig, ownership),
          ownership,
          {
            reason: "restart-check",
            publishFailureAsDegraded: true,
            ...(ownership.runtimeEnv ? { env: ownership.runtimeEnv.env } : {}),
          },
        );
        await ownership.checkpoint();
        assertReloadPublicationCurrent(ownership.isCurrent(), false);
        if (prepared && isRuntimeSecretsPreparationCurrent(prepared)) {
          return prepared.snapshot.config;
        }
      }
    });
  const onEffectiveConfigUnchanged: EffectiveConfigUnchangedHandler = async (
    nextConfig,
    transactionOwnership,
    sourceConfig,
  ) => {
    for (;;) {
      await transactionOwnership.checkpoint();
      assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
      const previousRuntimeSourceConfig = getRuntimeConfigSourceSnapshot();
      const previousSecretsSnapshot = getActiveSecretsRuntimeSnapshotState();
      const previousSecretsRevision = getActiveSecretsRuntimeSnapshotRevisionState();
      const previousRuntimeMetadata = getRuntimeConfigSnapshotMetadata();
      const nextSecretsSourceConfig = prepareRuntimeCandidate(
        nextConfig,
        sourceConfig,
        transactionOwnership,
      );
      if (
        previousRuntimeMetadata &&
        previousRuntimeSourceConfig &&
        previousSecretsSnapshot &&
        hasSameSecretReloadContract(previousSecretsSnapshot.sourceConfig, nextSecretsSourceConfig)
      ) {
        const sourceOnlySnapshot = {
          ...previousSecretsSnapshot,
          sourceConfig: nextSecretsSourceConfig,
        };
        if (!isDeepStrictEqual(sourceOnlySnapshot.config, nextConfig)) {
          throw new GatewayConfigReloadSupersededError();
        }
        await transactionOwnership.checkpoint();
        assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
        if (
          !setSecretsRuntimeSourceSnapshotIfCurrent({
            expectedSecretsRevision: previousSecretsRevision,
            expectedRuntimeConfigRevision: previousRuntimeMetadata.revision,
            runtimeSourceConfig: sourceConfig,
            secretsSourceConfig: nextSecretsSourceConfig,
          })
        ) {
          continue;
        }
        const committedSecretsRevision = getActiveSecretsRuntimeSnapshotRevisionState();
        const rollbackPublishedSource = async () => {
          if (
            !restoreSecretsRuntimeSourceSnapshotIfLineageCurrent({
              expectedLineageRevision: committedSecretsRevision,
              runtimeSourceConfig: previousRuntimeSourceConfig,
              secretsSourceConfig: previousSecretsSnapshot.sourceConfig,
            })
          ) {
            throw new GatewayConfigReloadSupersededError();
          }
        };
        if (!transactionOwnership.isCurrent()) {
          await rollbackPublishedSource();
          throw new GatewayConfigReloadSupersededError();
        }
        return {
          rollback: rollbackPublishedSource,
          commit: () =>
            params.activateRuntimeSecrets.publishStateTransition(sourceOnlySnapshot, {
              sourceOnly: true,
              expectedRevision: committedSecretsRevision,
            }),
        };
      }
      const preparation = await tryPrepareRuntimeSecrets(
        nextSecretsSourceConfig,
        transactionOwnership,
        {
          reason: "reload",
          publishFailureAsDegraded: true,
          ...(transactionOwnership.runtimeEnv ? { env: transactionOwnership.runtimeEnv.env } : {}),
          includeAuthStoreRefs: true,
        },
      );
      if (!previousRuntimeMetadata || !transactionOwnership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (getRuntimeConfigSnapshotMetadata()?.revision !== previousRuntimeMetadata.revision) {
        if (hasActiveSecretsRuntimeSnapshotLineage(previousSecretsRevision)) {
          continue;
        }
        throw new GatewayConfigReloadSupersededError();
      }
      if (
        !preparation ||
        preparation.expectedRevision !== previousSecretsRevision ||
        !isRuntimeSecretsPreparationCurrent(preparation)
      ) {
        continue;
      }
      const preparedSecrets = preparation.snapshot;
      await transactionOwnership.checkpoint();
      assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
      if (!isDeepStrictEqual(preparedSecrets.config, nextConfig)) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (!previousRuntimeSourceConfig || !previousSecretsSnapshot) {
        throw new GatewayConfigReloadSupersededError();
      }
      const activated = await params.activateRuntimeSecrets.activatePreparedSnapshotIfCurrent(
        preparedSecrets,
        previousSecretsRevision,
        {
          reason: "reload",
          activate: true,
          deferStatePublication: true,
          runtimeSourceConfig: sourceConfig,
        },
        undefined,
        transactionOwnership.isCurrent,
        transactionOwnership.checkpoint,
      );
      if (!activated) {
        continue;
      }
      const committedSecretsRevision = getActiveSecretsRuntimeSnapshotRevisionState();
      const rollbackPublishedSource = async () => {
        if (
          !(await params.activateRuntimeSecrets.restoreSnapshotIfCurrent(
            previousSecretsSnapshot,
            committedSecretsRevision,
            activated,
            { runtimeSourceConfig: previousRuntimeSourceConfig },
          ))
        ) {
          throw new GatewayConfigReloadSupersededError();
        }
      };
      if (!transactionOwnership.isCurrent()) {
        await rollbackPublishedSource();
        throw new GatewayConfigReloadSupersededError();
      }
      return {
        rollback: rollbackPublishedSource,
        commit: () => params.activateRuntimeSecrets.publishStateTransition(activated),
      };
    }
  };
  const onHotReload: HotReloadHandler = async (
    plan,
    nextConfig,
    transactionOwnership,
    sourceConfig,
  ) => {
    const authoredChannels = new Set(plan.restartChannels);
    const authoredAccountTargets = new Map<ChannelKind, Set<string>>(
      [...(plan.restartChannelAccounts ?? [])].map(([channel, ids]) => [channel, new Set(ids)]),
    );
    // A deferred channel/plugin reload can overlap secrets.reload. Retry from
    // preparation unless the same active snapshot still owns publication.
    for (;;) {
      transactionOwnership.assertInvokerOwned?.();
      await transactionOwnership.checkpoint();
      assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
      const previousSnapshot = getActiveSecretsRuntimeSnapshotState();
      // Prepared secrets carry effective defaults; commit and rollback must retain authored provenance.
      const previousRuntimeSourceConfig = getRuntimeConfigSourceSnapshot() ?? undefined;
      const previousSnapshotRevision = getActiveSecretsRuntimeSnapshotRevisionState();
      const previousGenerationOwnership = params.sharedGatewaySessionGenerationState.capture();
      const previousSharedGatewaySessionGeneration = previousGenerationOwnership.generation;
      const preparation = await tryPrepareRuntimeSecrets(
        prepareRuntimeCandidate(nextConfig, sourceConfig, transactionOwnership),
        transactionOwnership,
        {
          reason: "reload",
          publishFailureAsDegraded: true,
          ...(transactionOwnership.runtimeEnv ? { env: transactionOwnership.runtimeEnv.env } : {}),
          includeAuthStoreRefs: transactionOwnership.runtimeRefresh?.includeAuthStoreRefs,
        },
      );
      if (
        !preparation ||
        preparation.expectedRevision !== previousSnapshotRevision ||
        !isRuntimeSecretsPreparationCurrent(preparation)
      ) {
        continue;
      }
      const prepared = preparation.snapshot;
      params.assertRuntimeSecurityConfig?.(prepared.config, transactionOwnership.runtimeEnv?.env);
      // Resolution can change channel lifetimes even when only a provider
      // definition changed. Rebuild each attempt so a lost CAS leaves no targets.
      const resolvedChannelPlan = buildGatewayReloadPlan(
        previousSnapshot
          ? diffConfigPaths(previousSnapshot.config, prepared.config).filter(
              (path) => path === "channels" || path.startsWith("channels."),
            )
          : [],
        { candidateConfig: prepared.config },
      );
      plan.restartChannels = new Set([...authoredChannels, ...resolvedChannelPlan.restartChannels]);
      plan.restartChannelAccounts = new Map(
        [...authoredAccountTargets].map(([channel, ids]) => [channel, new Set(ids)]),
      );
      for (const [channel, ids] of resolvedChannelPlan.restartChannelAccounts ?? []) {
        const targets = plan.restartChannelAccounts.get(channel) ?? new Set<string>();
        for (const id of ids) {
          targets.add(id);
        }
        plan.restartChannelAccounts.set(channel, targets);
      }
      for (const channel of plan.restartChannels) {
        plan.restartChannelAccounts.delete(channel);
      }
      await transactionOwnership.checkpoint();
      assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
      if (getActiveSecretsRuntimeSnapshotRevisionState() !== previousSnapshotRevision) {
        continue;
      }
      const nextSharedGatewaySessionGeneration =
        params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
      const sharedGatewaySessionGenerationChanged =
        previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration;
      let runtimeSecretsPublished = false;
      let runtimeCommitted = false;
      let publishedSnapshotRevision: number | null = null;
      let publishedSharedGatewaySessionGeneration: SharedGatewaySessionGenerationOwnership | null =
        null;
      let runtimePolicyReconciled = false;
      let applicationStatus: Awaited<ReturnType<typeof applyHotReload>>;
      const rollbackPublication = async (
        restore: typeof params.activateRuntimeSecrets.restoreSnapshotIfCurrent,
      ) => {
        const generationOwnership = publishedSharedGatewaySessionGeneration;
        if (
          !runtimeSecretsPublished ||
          publishedSnapshotRevision === null ||
          !generationOwnership
        ) {
          return;
        }
        let generationRestored = false;
        const restoreGeneration = () => {
          generationRestored = params.sharedGatewaySessionGenerationState.restoreCurrent(
            generationOwnership,
            previousSharedGatewaySessionGeneration,
          );
        };
        const snapshotRestored = await restore(
          previousSnapshot,
          publishedSnapshotRevision,
          prepared,
          { runtimeSourceConfig: previousRuntimeSourceConfig, onActivated: restoreGeneration },
        );
        if (snapshotRestored) {
          if (previousSnapshot && shouldRefreshContextWindowCache(plan)) {
            // Plugin rollback must settle model replacement before a catalog read can finish.
            resetContextWindowCache(previousSnapshot.config);
          }
          runtimeSecretsPublished = false;
        }
        if (generationRestored && sharedGatewaySessionGenerationChanged) {
          disconnectStaleSharedGatewayAuthClients({
            state: params.sharedGatewaySessionGenerationState,
            clients: params.clients,
            expectedGeneration: previousSharedGatewaySessionGeneration,
          });
        }
      };
      try {
        const publication: GatewayHotReloadPublication = {
          isCurrent: transactionOwnership.isCurrent,
          checkpoint: transactionOwnership.checkpoint,
          assertInvokerOwned: transactionOwnership.assertInvokerOwned,
          ...(transactionOwnership.runtimeEnv
            ? { runtimeEnv: transactionOwnership.runtimeEnv.env }
            : {}),
          sourceConfig,
          prepareRestartRuntimeConfig: () =>
            prepareRestartRuntimeConfig(prepared.config, sourceConfig, transactionOwnership),
          publish: async (commit, isCommitted) => {
            const claimGenerationOwnership = () => {
              publishedSharedGatewaySessionGeneration ??=
                params.sharedGatewaySessionGenerationState.claim(
                  previousGenerationOwnership,
                  nextSharedGatewaySessionGeneration,
                );
              if (!publishedSharedGatewaySessionGeneration) {
                throw new GatewayHotReloadStaleSecretsError();
              }
            };
            const publishRuntime = async (
              restore: typeof params.activateRuntimeSecrets.restoreSnapshotIfCurrent,
            ) => {
              runtimeSecretsPublished = true;
              publishedSnapshotRevision = getActiveSecretsRuntimeSnapshotRevisionState();
              // Claim the generation at the snapshot activation edge, but keep
              // `required` until the runtime commit succeeds.
              claimGenerationOwnership();
              try {
                // Hot-reloaded services inherit process.env. Publish the
                // prepared layer at the same edge as secrets/runtime state,
                // before any replacement service or channel starts.
                transactionOwnership.publishRuntimeEnv();
                try {
                  await commit();
                } finally {
                  // Published policy remains authoritative if a later service handoff fails.
                  // Commit admission policy before irreversible PTY and socket eviction.
                  if (isCommitted()) {
                    runtimeCommitted = true;
                    transactionOwnership.markRuntimeCommitted(prepared.config, plan);
                    if (!runtimePolicyReconciled) {
                      params.commitRuntimePolicy(prepared.config);
                      await params.reconcileRuntimePolicy(prepared.config, "committed");
                      runtimePolicyReconciled = true;
                    }
                    if (sharedGatewaySessionGenerationChanged) {
                      disconnectStaleSharedGatewayAuthClients({
                        state: params.sharedGatewaySessionGenerationState,
                        clients: params.clients,
                        expectedGeneration: nextSharedGatewaySessionGeneration,
                      });
                    }
                  }
                }
              } catch (err) {
                if (!isCommitted()) {
                  await rollbackPublication(restore);
                }
                throw err;
              }
            };
            const canActivate = () => {
              transactionOwnership.assertInvokerOwned?.();
              return (
                transactionOwnership.isCurrent() &&
                params.sharedGatewaySessionGenerationState.owns(previousGenerationOwnership)
              );
            };
            const activated = await params.activateRuntimeSecrets.activatePreparedSnapshotIfCurrent(
              prepared,
              previousSnapshotRevision,
              {
                reason: "reload",
                activate: true,
                runtimeSourceConfig: sourceConfig,
              },
              publishRuntime,
              canActivate,
              transactionOwnership.checkpoint,
            );
            if (!activated) {
              throw new GatewayHotReloadStaleSecretsError();
            }
          },
        };
        if (isNoopGatewayReloadPlan(plan)) {
          // A source no-op still shares secret/auth publication ownership, but
          // must not churn services or prepared model owners without an effect.
          let committed = false;
          await publication.publish(
            async () => {
              committed = true;
            },
            () => committed,
          );
          applicationStatus = "applied";
        } else {
          applicationStatus = await applyHotReload(plan, prepared.config, publication);
        }
      } catch (err) {
        // A direct cause survives only a completed, uncommitted plugin rollback.
        const cause =
          err instanceof PluginRuntimeApplicationError && !err.details.committed ? err.cause : err;
        if (cause instanceof GatewayHotReloadStaleSecretsError) {
          await transactionOwnership.checkpoint();
          assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
          continue;
        }
        if (err instanceof GatewayHotReloadRecoveryError) {
          throw err;
        }
        if (runtimeCommitted) {
          throw err;
        }
        await rollbackPublication(params.activateRuntimeSecrets.restoreSnapshotIfCurrent);
        throw err;
      }
      // Runtime-secret refreshes can legitimately advance the snapshot
      // revision after this commit. Finalize only while this transaction's
      // generation is still current so a genuinely newer generation wins.
      if (publishedSharedGatewaySessionGeneration) {
        params.sharedGatewaySessionGenerationState.finalize(
          publishedSharedGatewaySessionGeneration,
        );
      }
      return applicationStatus;
    }
  };

  return {
    onEffectiveConfigUnchanged,
    onHotReload,
    prepareRestartRuntimeConfig,
  };
}
