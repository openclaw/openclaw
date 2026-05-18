import { commitPluginInstallRecordsWithConfig } from "../../cli/plugins-install-record-commit.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readPackageVersion } from "../../infra/package-json.js";
import {
  buildRestartSuccessContinuation,
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { type UpdateChannel, normalizeUpdateChannel } from "../../infra/update-channels.js";
import {
  resolveUpdateInstallSurface,
  runGatewayUpdate,
  type UpdateRunResult,
} from "../../infra/update-runner.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import {
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  type PluginUpdateIntegrityDriftParams,
} from "../../plugins/update.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { validateUpdateRunParams, validateUpdateStatusParams } from "../protocol/index.js";
import {
  getLatestUpdateRestartSentinel,
  recordLatestUpdateRestartSentinel,
} from "../server-restart-sentinel.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type PostUpdatePlugins = NonNullable<NonNullable<UpdateRunResult["postUpdate"]>["plugins"]>;

async function runPostCorePluginSync(params: {
  config: OpenClawConfig;
  channel: UpdateChannel;
  workspaceDir: string;
}): Promise<PostUpdatePlugins> {
  const integrityDrifts: PostUpdatePlugins["integrityDrifts"] = [];

  // Load the persisted install index so externalized plugins (whose specs live
  // in the index, not in openclaw.json) are visible to sync and npm update.
  const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const syncConfig = withPluginInstallRecords(params.config, pluginInstallRecords);

  const syncResult = await syncPluginsForUpdateChannel({
    config: syncConfig,
    channel: params.channel,
    workspaceDir: params.workspaceDir,
  });

  const npmResult = await updateNpmInstalledPlugins({
    config: syncResult.config,
    updateChannel: params.channel,
    syncOfficialPluginInstalls: true,
    onIntegrityDrift: (drift: PluginUpdateIntegrityDriftParams) => {
      integrityDrifts.push({
        pluginId: drift.pluginId,
        spec: drift.spec,
        expectedIntegrity: drift.expectedIntegrity,
        actualIntegrity: drift.actualIntegrity,
        resolvedSpec: drift.resolvedSpec,
        resolvedVersion: drift.resolvedVersion,
        action: "aborted",
      });
      return false;
    },
  });

  if (syncResult.changed || npmResult.changed) {
    // Persist install records through the index (not directly into openclaw.json)
    // so the install-record registry stays consistent with the config file.
    const nextInstallRecords = npmResult.config.plugins?.installs ?? {};
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: pluginInstallRecords,
      nextInstallRecords,
      nextConfig: withoutPluginInstallRecords(npmResult.config),
    });
  }

  const hasErrors =
    syncResult.summary.errors.length > 0 || npmResult.outcomes.some((o) => o.status === "error");

  return {
    status: hasErrors ? "error" : "ok",
    changed: syncResult.changed || npmResult.changed,
    sync: {
      changed: syncResult.changed,
      switchedToBundled: syncResult.summary.switchedToBundled,
      switchedToNpm: syncResult.summary.switchedToNpm,
      warnings: syncResult.summary.warnings,
      errors: syncResult.summary.errors,
    },
    npm: {
      changed: npmResult.changed,
      outcomes: npmResult.outcomes,
    },
    integrityDrifts,
  };
}

export const updateHandlers: GatewayRequestHandlers = {
  "update.status": async ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateStatusParams, "update.status", respond)) {
      return;
    }
    respond(true, {
      sentinel: getLatestUpdateRestartSentinel(),
    });
  },
  "update.run": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const {
      sessionKey,
      deliveryContext: requestedDeliveryContext,
      threadId: requestedThreadId,
      note,
      continuationMessage,
      restartDelayMs,
    } = parseRestartRequestParams(params);
    const { deliveryContext: sessionDeliveryContext, threadId: sessionThreadId } =
      extractDeliveryInfo(sessionKey);
    const deliveryContext = requestedDeliveryContext ?? sessionDeliveryContext;
    const threadId = requestedThreadId ?? sessionThreadId;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.max(1000, Math.floor(timeoutMsRaw))
        : undefined;

    let result: Awaited<ReturnType<typeof runGatewayUpdate>>;
    try {
      const config = context.getRuntimeConfig();
      const configChannel = normalizeUpdateChannel(config.update?.channel);
      const root =
        (await resolveOpenClawPackageRoot({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        })) ?? process.cwd();
      const installSurface = await resolveUpdateInstallSurface({
        timeoutMs,
        cwd: root,
        argv1: process.argv[1],
      });
      const supervisor = detectRespawnSupervisor(process.env, process.platform);
      if (!isRestartEnabled(config) && !supervisor) {
        const beforeVersion = installSurface.root
          ? await readPackageVersion(installSurface.root)
          : null;
        result = {
          status: "skipped",
          mode: installSurface.mode,
          ...(installSurface.root ? { root: installSurface.root } : {}),
          reason: installSurface.kind === "global" ? "restart-unavailable" : "restart-disabled",
          ...(beforeVersion ? { before: { version: beforeVersion } } : {}),
          steps: [],
          durationMs: 0,
        };
      } else {
        result = await runGatewayUpdate({
          timeoutMs,
          cwd: root,
          argv1: process.argv[1],
          channel: configChannel ?? undefined,
        });
        if (result.status === "ok" && result.mode !== "git") {
          const pluginSync = await runPostCorePluginSync({
            config,
            channel: configChannel ?? "stable",
            workspaceDir: result.root ?? root,
          }).catch((err: unknown) => {
            context?.logGateway?.warn(
              `update.run: plugin sync failed after core update: ${String(err)}`,
            );
            return null;
          });
          if (pluginSync) {
            // Mirror the CLI fail-closed contract: a plugin sync error escalates
            // the overall update status to "error" so the gateway does not restart
            // with a new core paired against stale or incompatible plugins.
            result = {
              ...result,
              ...(pluginSync.status === "error"
                ? { status: "error", reason: "post-update-plugins" }
                : {}),
              postUpdate: { plugins: pluginSync },
            };
          }
        }
      }
    } catch {
      result = {
        status: "error",
        mode: "unknown",
        reason: "unexpected-error",
        steps: [],
        durationMs: 0,
      };
    }

    const continuation =
      result.status === "ok"
        ? buildRestartSuccessContinuation({ sessionKey, continuationMessage })
        : null;
    const payload: RestartSentinelPayload = {
      kind: "update",
      status: result.status,
      ts: Date.now(),
      sessionKey,
      deliveryContext,
      threadId,
      message: note ?? null,
      ...(continuation ? { continuation } : {}),
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: result.mode,
        root: result.root ?? undefined,
        before: result.before ?? null,
        after: result.after ?? null,
        steps: result.steps.map((step) => ({
          name: step.name,
          command: step.command,
          cwd: step.cwd,
          durationMs: step.durationMs,
          log: {
            stdoutTail: step.stdoutTail ?? null,
            stderrTail: step.stderrTail ?? null,
            exitCode: step.exitCode ?? null,
          },
        })),
        reason: result.reason ?? null,
        durationMs: result.durationMs,
      },
    };

    let sentinelPath: string | null = null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
      recordLatestUpdateRestartSentinel(payload);
    } catch {
      sentinelPath = null;
    }

    // Only restart the gateway when the update actually succeeded.
    // Restarting after a failed update leaves the process in a broken state
    // (corrupted node_modules, partial builds) and causes a crash loop.
    const updateWasPackageSwap = result.status === "ok" && result.mode !== "git";
    const restart =
      result.status === "ok"
        ? scheduleGatewaySigusr1Restart({
            delayMs: updateWasPackageSwap ? 0 : restartDelayMs,
            reason: "update.run",
            skipDeferral: updateWasPackageSwap,
            skipCooldown: updateWasPackageSwap,
            audit: {
              actor: actor.actor,
              deviceId: actor.deviceId,
              clientIp: actor.clientIp,
              changedPaths: [],
            },
          })
        : null;
    context?.logGateway?.info(
      `update.run completed ${formatControlPlaneActor(actor)} changedPaths=<n/a> restartReason=update.run status=${result.status}`,
    );
    if (restart?.coalesced) {
      context?.logGateway?.warn(
        `update.run restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }

    respond(
      true,
      {
        ok: result.status === "ok",
        result,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
