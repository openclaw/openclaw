import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type * as ChannelOperatorAuthority from "../gateway/channel-operator-authority.js";
import {
  withArtifactPreservingStateReads,
  withSynchronousArtifactPreservingStateSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { resolveInstallationTarget } from "./installation-target-context.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type UpdateRequester = {
  channel?: string;
  accountId?: string;
  senderId?: string;
  /** Captured by the original admission; private handoffs preserve it without granting authority. */
  authorizationSource?: string;
};
export type UpdateRequesterAuthority = Readonly<{
  requester: Readonly<UpdateRequester>;
  /** False means revoked; unavailable policy throws so the run records its actual failure. */
  isCurrent: () => boolean;
}>;

/** Only external chat requesters delegate command-owner authority to the updater. */
export function resolveManagedUpdateRequester(
  requester: UpdateRequester | undefined,
): UpdateRequester | undefined {
  return requester?.channel && !isInternalMessageChannel(requester.channel) ? requester : undefined;
}

export class UpdateRequesterRevokedError extends Error {
  readonly code: "requester-revoked" | "interrupted" = "requester-revoked";

  constructor(message = "requester-revoked") {
    super(message);
    this.name = "UpdateRequesterRevokedError";
  }
}

/** Forward work stops exactly as for a revocation, but the requester kept its authority. */
export class UpdateInterruptedError extends UpdateRequesterRevokedError {
  override readonly code = "interrupted";

  constructor() {
    super("interrupted");
    this.name = "UpdateInterruptedError";
  }
}

/** Bind the admitted requester to fresh, read-only policy from its original installation. */
export async function createManagedUpdateRequesterAuthority(
  requester: UpdateRequester,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRequesterAuthority> {
  return captureManagedUpdateRequester(
    requester,
    env,
    (auth) => auth.resolveChannelOperatorAdminAuthority,
  );
}

/** Reconstruct delegated authority from the source recorded by the original admission. */
export function createDelegatedUpdateRequesterAuthority(
  requester: UpdateRequester,
  runId: string,
  executor: UpdateRecoveryFence,
  env?: NodeJS.ProcessEnv,
): Promise<UpdateRequesterAuthority> {
  return requester.authorizationSource?.startsWith("profile:")
    ? createManagedUpdateRequesterContinuationAuthority(requester, { runId, executor }, env)
    : captureManagedUpdateRequester(
        requester,
        env ?? process.env,
        (auth) => auth.resolveChannelOperatorAdminAuthority,
        { projectDoctorConfig: true },
      );
}

/** Identity facts alone grant no effects; the helper composes them with its native owner. */
export async function prepareUpdateRequesterIdentity(
  requester: UpdateRequester,
  env: NodeJS.ProcessEnv = process.env,
) {
  const identity = await captureManagedUpdateRequester(
    requester,
    env,
    (auth) => auth.resolveUpdateChannelOperatorAdminIdentityAuthority,
  );
  return Object.freeze({
    requester: identity.requester,
    isCurrentIdentity: identity.isCurrent,
  });
}

/** Only a registered native continuation can settle the original Gateway's accepted update. */
export async function createManagedUpdateRequesterContinuationAuthority(
  requester: UpdateRequester,
  operation: { runId: string; executor: UpdateRecoveryFence },
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRequesterAuthority> {
  const { runId, executor } = operation;
  const admittedRequester = Object.freeze({ ...requester });
  const authorityEnv = { ...env };
  const { assertUpdateRequesterContinuationOwner } =
    await import("../cli/update-cli/update-command-executor.js");
  const assertOperationCurrent = () => assertUpdateRequesterContinuationOwner(executor, runId);
  assertOperationCurrent();
  const { getUpdateRun } = await import("./update-run-ledger.js");
  assertOperationCurrent();
  const run = getUpdateRun(runId, { env: authorityEnv });
  if (
    run?.status !== "running" ||
    !isDeepStrictEqual(run.origin.requester, admittedRequester) ||
    !admittedRequester.authorizationSource?.startsWith("profile:")
  ) {
    throw new UpdateRequesterRevokedError();
  }
  const identity = await prepareUpdateRequesterIdentity(admittedRequester, authorityEnv);
  assertOperationCurrent();
  return Object.freeze({
    requester: identity.requester,
    isCurrent: () => {
      assertOperationCurrent();
      return identity.isCurrentIdentity();
    },
  });
}

async function captureManagedUpdateRequester(
  requester: UpdateRequester,
  env: NodeJS.ProcessEnv,
  selectResolver: (
    auth: Pick<
      typeof ChannelOperatorAuthority,
      "resolveChannelOperatorAdminAuthority" | "resolveUpdateChannelOperatorAdminIdentityAuthority"
    >,
  ) => typeof ChannelOperatorAuthority.resolveChannelOperatorAdminAuthority,
  options: { projectDoctorConfig?: boolean } = {},
): Promise<UpdateRequesterAuthority> {
  // Released drivers knew only configured owners. They must not acquire a newly linked profile
  // when an installed runtime later reconstructs their authority.
  const authorizationSource = requester.authorizationSource ?? "configured-owner";
  const admittedRequester = Object.freeze({ ...requester });
  try {
    return await withArtifactPreservingStateReads(async () => {
      const authorityEnv = { ...env };
      const target = resolveInstallationTarget(authorityEnv);
      const [
        { captureCommandOwnerIdentity, isConfiguredCommandOwner },
        {
          resolveChannelOperatorAdminAuthority,
          resolveUpdateChannelOperatorAdminIdentityAuthority,
        },
        { readCurrentConfigForPolicyCheck },
        { ensureCliPluginRegistryLoaded },
        { PluginLoadFailureError },
      ] = await Promise.all([
        import("../auto-reply/command-owner-facts.js"),
        import("../gateway/channel-operator-authority.js"),
        // Keep synchronous authority checks on the reader loaded at admission.
        import("../config/io.js"),
        import("../cli/plugin-registry-loader.js"),
        import("../plugins/loader-shared.js"),
      ]);
      const doctor = options.projectDoctorConfig
        ? await Promise.all([
            import("../commands/doctor/legacy-config-repair.js"),
            import("../plugins/doctor-contract-registry.js"),
            import("../plugins/plugin-setup-module.js"),
          ])
        : undefined;
      const readCurrentConfig = () =>
        readCurrentConfigForPolicyCheck({
          env: authorityEnv,
          configPath: target.configPath,
          projectInvalidConfig: doctor
            ? (snapshot) => {
                if (!isRecord(snapshot.parsed)) {
                  return undefined;
                }
                const [repair, registry, setup] = doctor;
                // Doctor defers repairs of plugins whose source is unavailable, such as during a
                // pending state migration. Plan the same way: owners are core config.
                const deferred: string[] = [];
                for (;;) {
                  try {
                    const plan = deferred.length
                      ? registry.withDeferredPluginDoctorMigrations(deferred, () =>
                          repair.planLegacyConfigForUpdateChannel(snapshot),
                        )
                      : repair.planLegacyConfigForUpdateChannel(snapshot);
                    return plan?.changes.length ? plan.config : undefined;
                  } catch (error) {
                    if (
                      !(error instanceof setup.PluginSetupPreparationRequiredError) ||
                      deferred.includes(error.record.id)
                    ) {
                      throw error;
                    }
                    deferred.push(error.record.id);
                  }
                }
              }
            : undefined,
        });
      let migrationDeferredChannels: string[] = [];
      await ensureCliPluginRegistryLoaded({
        scope: "configured-channels",
        routeLogsToStderr: true,
        config: readCurrentConfig(),
      }).catch((error: unknown) => {
        // Post-install Doctor runs these migrations, so their channel plugins cannot load before
        // its authority check. Owner matching then uses bundled channel metadata (#178291).
        if (!(error instanceof PluginLoadFailureError && error.onlyPendingStateMigrations)) {
          throw error;
        }
        migrationDeferredChannels = error.registry.plugins
          .filter((plugin) => plugin.status === "error")
          .flatMap((plugin) => plugin.channelIds);
      });
      const authority =
        authorizationSource === "configured-owner"
          ? undefined
          : captureCommandOwnerIdentity(
              readCurrentConfig(),
              admittedRequester,
              { env: authorityEnv },
              selectResolver({
                resolveChannelOperatorAdminAuthority,
                resolveUpdateChannelOperatorAdminIdentityAuthority,
              }),
            );
      return Object.freeze({
        requester: admittedRequester,
        isCurrent: () =>
          withSynchronousArtifactPreservingStateSnapshot(
            () => {
              const config = readCurrentConfig();
              return authorizationSource === "configured-owner"
                ? isConfiguredCommandOwner(config, admittedRequester, { migrationDeferredChannels })
                : authority?.source === authorizationSource && authority.isCurrent(config);
            },
            { current: { env: authorityEnv } },
          ),
      });
    });
  } catch (error) {
    // Admission and worker startup precede run failure reporting. Surface failed
    // preparation at the authority check, inside the owning run's error boundary.
    return Object.freeze({
      requester: admittedRequester,
      isCurrent: () => {
        throw error;
      },
    });
  }
}
