import { readConfigFileSnapshot } from "../../config/config.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { normalizeUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import {
  UPDATE_RUN_ID_ENV,
  readControlPlaneUpdateSentinelMeta,
} from "../../infra/update-control-plane-sentinel.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import { writeUpdateRunReportArtifact } from "../../infra/update-failure-report-artifact.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { createManagedHandoffProcessIdentityReader } from "../../infra/update-managed-service-handoff-process.js";
import type { HandoffProcessIdentity } from "../../infra/update-managed-service-handoff-schema.js";
import {
  POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
  POST_CORE_UPDATE_ENV,
  POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_STARTED_AT_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
  type PreUpdateConfigRestoreInput,
} from "../../infra/update-post-core-context.js";
import {
  createManagedUpdateRequesterAuthority,
  createManagedUpdateRequesterContinuationAuthority,
  resolveManagedUpdateRequester,
} from "../../infra/update-requester-authority.js";
import { recordPostCoreUpdateEvidence } from "../../infra/update-run-interruption.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "../../plugins/installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { isUnfencedUpdateDriver } from "../../state/openclaw-state-schema-publication.js";
import { VERSION } from "../../version.js";
import { parseUpdateTimeoutMs, readPackageVersion, type UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandAuthority } from "./update-command-authority.js";
import {
  preparePostCorePluginConfig,
  persistValidatedDowngradeConfig,
  readPostCorePreUpdateSourceConfig,
} from "./update-command-config.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";
import { readPackageUpdateIdentity } from "./update-command-package.js";
import {
  collectPostCorePluginAdvisories,
  type PluginUpdateWarning,
} from "./update-command-plugins-internals.js";
import {
  updatePluginsAfterCoreUpdate,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins.js";
import {
  postCoreUpdateParentOwnsCompletion,
  readPostCorePluginInstallRecordsFile,
  resolvePostCoreUpdateOperatorOptions,
  resolvePostCoreUpdateStartedAtMs,
  writePostCorePluginUpdateResultFile,
  writePostCoreUpdateFailureFile,
} from "./update-command-post-core.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";

type ResumePostCoreUpdateParams = {
  root: string;
  channel: string | undefined;
  opts: UpdateCommandOptions;
  timeoutMs: number;
};

export async function resumePostCoreUpdate(params: ResumePostCoreUpdateParams): Promise<void> {
  try {
    const env = { ...process.env };
    const runId = env[UPDATE_RUN_ID_ENV]?.trim();
    // Capture before the first await, but identity is required only by legacy
    // child-owned completion; a modern parent's unchanged path needs no probe.
    let parent: HandoffProcessIdentity | undefined;
    let parentError: unknown;
    if (runId && !params.opts.run) {
      try {
        parent = createManagedHandoffProcessIdentityReader({ env }).processIdentity(process.ppid);
      } catch (error) {
        parentError = error;
      }
    }
    const opts = await resolvePostCoreUpdateOperatorOptions({
      opts: params.opts,
      resultPath: process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
    });
    const resumed = { ...params, opts };
    const parentOwnsCompletion = await postCoreUpdateParentOwnsCompletion(
      process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
    );
    const record =
      runId && !params.opts.run && !parentOwnsCompletion ? getUpdateRun(runId, { env }) : undefined;
    if (runId && !params.opts.run && !parentOwnsCompletion && !record) {
      throw new UpdateCommandRecoveryPendingError(
        "Post-core update run is unavailable; resume cannot verify its owner.",
      );
    }
    let completed: Awaited<ReturnType<typeof resumePostCoreUpdateInternal>>;
    if (runId && record && isUnfencedUpdateDriver(record.before.version)) {
      if (!parent) {
        throw new UpdateCommandRecoveryPendingError(
          "Legacy package parent identity is unavailable.",
          { cause: parentError },
        );
      }
      const inPostCore = (current: ReturnType<typeof getUpdateRun>) =>
        current?.status === "running" &&
        current.steps.findLast((entry) => entry.step === "openclaw doctor")?.status ===
          "completed" &&
        current.steps.findLast((entry) => entry.step === "post-update verification")?.status ===
          "in_progress";
      const root = resolveUpdateInstallRoot(params.root);
      const executingRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
      if (
        !inPostCore(record) ||
        !executingRoot ||
        resolveUpdateInstallRoot(executingRoot) !== root
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Legacy post-core update does not match its running installation.",
        );
      }
      const meta = await readControlPlaneUpdateSentinelMeta(env);
      const managedHandoff =
        env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" || Boolean(meta?.handoffId || meta?.root);
      if (
        (meta?.runId && meta.runId !== runId) ||
        (managedHandoff && (!meta?.runId || !meta.handoffId || !meta.root))
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Legacy managed post-core handoff is incomplete or names another update run.",
        );
      }
      if (meta?.handoffId && meta.root) {
        const { assertManagedServiceUpdateHandoffRoot } =
          await import("../../infra/update-managed-service-handoff.js");
        await assertManagedServiceUpdateHandoffRoot({
          expectedRoot: meta.root,
          root,
          executingRoot,
          postCore: true,
        });
      }
      completed = await withUpdateCommandExecutor(
        runId,
        async (executor) => {
          const fence = await executor.enter(root);
          const requester = resolveManagedUpdateRequester(record.origin.requester);
          const requesterAuthority = requester?.authorizationSource?.startsWith("profile:")
            ? await createManagedUpdateRequesterContinuationAuthority(
                requester,
                { runId, executor: fence },
                env,
              )
            : requester
              ? await createManagedUpdateRequesterAuthority(requester, env)
              : undefined;
          fence.assertCurrent();
          const current = getUpdateRun(runId, { env });
          if (!inPostCore(current) || current?.createdAtMs !== record.createdAtMs) {
            throw new UpdateCommandRecoveryPendingError(
              "Legacy post-core update changed during admission.",
            );
          }
          // Reuse the parent's row without admitting, adopting, or terminalizing another run.
          return await resumePostCoreUpdateInternal({
            ...resumed,
            opts: {
              ...opts,
              run: {
                runId,
                env,
                executorFence: fence,
                ...(requesterAuthority ? { requesterAuthority } : {}),
              },
            },
          });
        },
        {
          legacyPackageParent: parent,
          // Metadata correlates the shipped handoff, never substitutes for its
          // unchanged lease row and the captured live package parent's identity.
          ...(meta?.handoffId && meta.root
            ? { legacyPackageHandoff: { handoffId: meta.handoffId, root: meta.root } }
            : {}),
        },
      );
    } else {
      completed = await resumePostCoreUpdateInternal(resumed);
    }
    const { pluginUpdate, result, assertRequesterCurrent } = completed;
    // Shipped parents may stop this child as soon as this file appears. Publish
    // only after the executor has joined its Doctor and released native custody.
    assertRequesterCurrent();
    if (process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
      await writePostCorePluginUpdateResultFile(
        process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
        pluginUpdate,
      );
    }
    if (params.opts.json && !process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
      defaultRuntime.writeJson(result);
    }
  } catch (error) {
    // Publish only after phase cleanup releases its leases. The parent owns
    // recovery and triage; inherited TTY output cannot serve as its error record.
    await writePostCoreUpdateFailureFile(
      process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
      error,
    ).catch((writeError: unknown) =>
      defaultRuntime.error(`Could not save post-update failure: ${String(writeError)}`),
    );
    throw error;
  }
  defaultRuntime.exit(0);
}

async function resumePostCoreUpdateInternal(params: ResumePostCoreUpdateParams): Promise<{
  pluginUpdate: PostCorePluginUpdateResult;
  result: UpdateRunResult;
  assertRequesterCurrent: () => void;
}> {
  const runId = process.env[UPDATE_RUN_ID_ENV]?.trim();
  const postCoreUpdate = process.env[POST_CORE_UPDATE_ENV] === "1";
  const { assertCurrent, assertRequesterCurrent } = createUpdateCommandAuthority(
    { opts: params.opts },
    "Post-core update",
  );
  assertCurrent?.();
  if (
    params.channel !== "stable" &&
    params.channel !== "extended-stable" &&
    params.channel !== "beta" &&
    params.channel !== "dev"
  ) {
    throw new Error("Missing post-core update channel context.");
  }
  const channel = params.channel;

  const requestedChannelInput = process.env[POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]?.trim() ?? "";
  const requestedChannel = requestedChannelInput
    ? normalizeUpdateChannel(requestedChannelInput)
    : null;
  if (requestedChannelInput && !requestedChannel) {
    throw new Error("Invalid post-core requested update channel context.");
  }

  process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION =
    (await readPackageVersion(params.root)) ?? VERSION;
  assertCurrent?.();

  const parentOwnsCompletion = await postCoreUpdateParentOwnsCompletion(
    process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
  );
  assertCurrent?.();
  let maintenance: Awaited<
    ReturnType<typeof import("../../commands/doctor-maintenance.js").beginDoctorMaintenance>
  >;
  let outcome: { pluginUpdate: PostCorePluginUpdateResult } | { error: unknown };
  let producedPluginUpdate: PostCorePluginUpdateResult | undefined;
  try {
    outcome = {
      pluginUpdate: await withCommandProcessScope(async () => {
        const doctorWarnings: PluginUpdateWarning[] = [];
        const recordDoctorWarnings = (additionalWarnings: string[] = []) => {
          const warnings = [
            ...additionalWarnings,
            ...doctorWarnings.map((warning) => warning.message),
          ];
          if (!postCoreUpdate || !runId || warnings.length === 0) {
            return;
          }
          try {
            // Settled diagnostics survive later failure without claiming candidate completion.
            recordPostCoreUpdateEvidence(runId, { warnings });
          } catch (error) {
            defaultRuntime.error(
              `Post-core update evidence could not be saved: ${formatErrorMessage(error)} Update completion may require Doctor verification.`,
            );
          }
        };
        const onDoctorWarnings = (warnings: string[]) => {
          doctorWarnings.push(
            ...warnings.map((message) => ({
              reason: "doctor-advisory",
              message,
              guidance: ["Run `openclaw doctor --fix` after repairing the plugin."],
            })),
          );
          recordDoctorWarnings();
        };
        const { beginDoctorMaintenance } = await import("../../commands/doctor-maintenance.js");
        assertCurrent?.();
        maintenance = await beginDoctorMaintenance({
          // Parent-owned completion retains native service custody, not state admission.
          root: parentOwnsCompletion ? null : params.root,
          options: { repair: true, nonInteractive: true, json: params.opts.json },
          runtime: { ...defaultRuntime, log: defaultRuntime.error },
          ...(params.opts.run ? { assertCurrent } : {}),
        });
        assertCurrent?.();
        // Each fresh Doctor holds its own database fences after admission.
        await maintenance?.releaseState();
        await withPluginLifecycleLease({ assertCurrent }, async (lease) => {
          await completeSourceUpdateRuntime({
            root: params.root,
            timeoutMs: params.timeoutMs,
            lease,
            beforePersistentEffect: assertCurrent,
          });
        });
        assertCurrent?.();
        if (!parentOwnsCompletion) {
          // Shipped parents expect the child to prepare migration plugins and settle
          // Doctor before plugin config writes; Doctor owns that preparation and its guards.
          const warning = await runUpdateFinalizationDoctorInFreshProcess({
            opts: params.opts,
            phase: "post-plugin",
            assertCurrent,
            root: params.root,
            yes: params.opts.yes === true,
            json: params.opts.json === true,
            timeoutMs: params.timeoutMs,
            onWarnings: onDoctorWarnings,
          });
          if (warning) {
            doctorWarnings.push(warning);
            recordDoctorWarnings();
          }
        }

        const configSnapshot = await readConfigFileSnapshot({
          skipPluginValidation: true,
          suppressFutureVersionWarning: true,
          observe: false,
        });
        const updateStartedAtMs = await resolvePostCoreUpdateStartedAtMs(process.env);
        const preUpdateSourceConfig = await readPostCorePreUpdateSourceConfig({
          sourceConfigPath: process.env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV],
          currentSnapshot: configSnapshot,
          updateStartedAtMs,
        });
        const parentPluginInstallRecords = await readPostCorePluginInstallRecordsFile(
          process.env[POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV],
        );
        assertCurrent?.();
        let { pluginUpdate } = await convergePostCoreUpdatePlugins({
          ...params,
          channel,
          requestedChannel,
          preUpdateConfig: preUpdateSourceConfig,
          parentPluginInstallRecords,
          updateStartedAtMs: process.env[POST_CORE_UPDATE_STARTED_AT_ENV]?.trim()
            ? updateStartedAtMs
            : undefined,
          assertCurrent,
        });
        producedPluginUpdate = pluginUpdate;
        // Shipped parents can stop the child as soon as its result appears.
        // Their completion stays here, after the producer releases its lease.
        if (!parentOwnsCompletion) {
          const completed = await completePostCorePluginUpdate({
            root: params.root,
            opts: params.opts,
            pluginUpdate,
            freshDoctorRequired: pluginUpdate.changed,
            assertCurrent,
            yes: params.opts.yes === true,
            json: params.opts.json === true,
            timeoutMs: params.timeoutMs,
            onWarnings: onDoctorWarnings,
          });
          pluginUpdate = completed.pluginUpdate;
          recordDoctorWarnings(collectPostCorePluginAdvisories(pluginUpdate));
        }
        // Only the target process may restamp an unchanged downgrade config.
        const finalSnapshot = await readConfigFileSnapshot({ observe: false });
        assertCurrent?.();
        await persistValidatedDowngradeConfig(finalSnapshot, assertCurrent);
        assertCurrent?.();
        return doctorWarnings.length
          ? {
              ...pluginUpdate,
              status: pluginUpdate.status === "error" ? "error" : "warning",
              warnings: [...(pluginUpdate.warnings ?? []), ...doctorWarnings],
            }
          : pluginUpdate;
      }),
    };
  } catch (error) {
    outcome =
      error instanceof DoctorMaintenanceRefusalError && error.refusal.kind === "deferred"
        ? {
            pluginUpdate: {
              ...(producedPluginUpdate ?? {
                changed: false,
                sync: {
                  changed: false,
                  switchedToBundled: [],
                  switchedToNpm: [],
                  warnings: [],
                  errors: [],
                },
                npm: { changed: false, outcomes: [] },
                integrityDrifts: [],
              }),
              status: "warning",
              warnings: [
                ...(producedPluginUpdate?.warnings ?? []),
                {
                  reason: "doctor-advisory",
                  message: error.message,
                  guidance: [
                    "After other OpenClaw processes release state, run `openclaw doctor --fix`.",
                  ],
                },
              ],
            },
          }
        : { error };
  }
  // A legacy parent can terminate this child as soon as its result appears.
  // Settle child work and restore service custody before publishing either outcome.
  if (maintenance && !("error" in outcome && hasCommandProcessCleanupError(outcome.error))) {
    const owned = maintenance;
    const failures = "error" in outcome ? [outcome.error] : [];
    for (const restore of [
      async () =>
        owned.finish((await readConfigFileSnapshot({ skipPluginValidation: true })).config),
      () => owned.release(),
    ]) {
      if (failures.some(hasCommandProcessCleanupError)) {
        break;
      }
      try {
        await withCommandProcessScope(restore);
      } catch (error) {
        if (!failures.includes(error)) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      outcome = {
        error:
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Post-core update and service restoration failed", {
                cause: failures[0],
              }),
      };
    }
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  const { pluginUpdate } = outcome;
  assertCurrent?.();
  const result: UpdateRunResult = {
    status: pluginUpdate.status === "error" ? "error" : "ok",
    mode: "unknown",
    root: params.root,
    runId,
    steps: pluginUpdate.doctorLint ? [pluginUpdate.doctorLint] : [],
    durationMs: 0,
    postUpdate: { plugins: pluginUpdate },
  };
  if (postCoreUpdate && runId) {
    try {
      recordPostCoreUpdateEvidence(runId, {
        candidate:
          pluginUpdate.status !== "error"
            ? await readPackageUpdateIdentity(params.root)
            : undefined,
        warnings: collectPostCorePluginAdvisories(pluginUpdate),
        doctorLint: pluginUpdate.doctorLint,
      });
      if (!parentOwnsCompletion && pluginUpdate.doctorLint) {
        const reportPath = await writeUpdateRunReportArtifact({
          result,
          detached: true,
          report: {
            markdown:
              "Post-plugin Doctor diagnostics; update completion is pending with the parent updater.",
          },
        });
        defaultRuntime.error(
          `Post-plugin Doctor report (update completion pending): ${reportPath}`,
        );
      }
    } catch (error) {
      defaultRuntime.error(
        `Post-core update evidence could not be saved: ${formatErrorMessage(error)} Update completion may require Doctor verification.`,
      );
    }
  }
  assertCurrent?.();
  return { pluginUpdate, result, assertRequesterCurrent };
}

/** Shared plugin producer; entry points retain runtime preparation and completion ownership. */
export async function convergePostCoreUpdatePlugins(params: {
  root: string;
  channel: UpdateChannel;
  requestedChannel: UpdateChannel | null;
  opts: UpdateCommandOptions;
  timeoutMs: number;
  preUpdateConfig?: PreUpdateConfigRestoreInput;
  parentPluginInstallRecords?: Record<string, PluginInstallRecord>;
  /** Only an explicitly forwarded update start makes an empty index authoritative. */
  updateStartedAtMs?: number;
  assertCurrent?: () => void;
}): Promise<{
  pluginUpdate: PostCorePluginUpdateResult;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
}> {
  const { assertCurrent } = params;
  assertCurrent?.();
  return await withPluginLifecycleLease({ assertCurrent }, async () => {
    // Entry points complete runtime artifacts and any legacy pre-convergence
    // Doctor before capturing config. This phase consumes that committed generation.
    const preparedConfig = await preparePostCorePluginConfig({
      requestedChannel: params.requestedChannel,
      preUpdateConfig: params.preUpdateConfig,
      suppressFutureVersionWarning: true,
      observe: false,
      assertCurrent,
    });
    // The updated doctor may have repaired or removed plugin installs before this process resumed.
    const currentPluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
    const persistedPluginIndex = params.parentPluginInstallRecords
      ? await readPersistedInstalledPluginIndex()
      : null;
    assertCurrent?.();
    const currentIndexIsAuthoritative =
      Object.keys(currentPluginInstallRecords).length > 0 ||
      Boolean(
        persistedPluginIndex &&
        params.updateStartedAtMs !== undefined &&
        persistedPluginIndex.generatedAtMs >= params.updateStartedAtMs,
      );
    const pluginInstallRecords = currentIndexIsAuthoritative
      ? currentPluginInstallRecords
      : (params.parentPluginInstallRecords ?? currentPluginInstallRecords);

    const pluginUpdate = await updatePluginsAfterCoreUpdate({
      root: params.root,
      channel: params.channel,
      ...preparedConfig,
      json: params.opts.json,
      acceptCapabilities: params.opts.acceptCapabilities,
      timeoutMs: params.timeoutMs,
      workTimeoutMs: parseUpdateTimeoutMs(params.opts.timeout) ?? null,
      pluginInstallRecords,
      assertCurrent,
    });
    assertCurrent?.();
    return { pluginUpdate, configSnapshot: preparedConfig.configSnapshot };
  });
}
