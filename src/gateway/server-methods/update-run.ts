// `update.run`: admit the request, record the run, answer with its ID, then prepare the
// release in the background. A pending trial ends with a cooperative restart; the launcher
// switches and the Gateway that starts next finishes the run (src/update/gateway-trial.ts).
import { prepareCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import { formatCommandOwnerHint } from "../../commands/doctor-command-owner.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "../../infra/gateway-supervision.js";
import { resolveGatewayRestartDecision } from "../../infra/process-respawn.js";
import { normalizeGatewayRestartDelayMs, scheduleGatewayRestart } from "../../infra/restart.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { currentUpdateCheckLifecycle } from "../../infra/update-check-lifecycle.js";
import { devUpdateTargetFromGitTarget } from "../../infra/update-dev-target.js";
import { resolveStartupInstallStatus } from "../../infra/update-install-status.js";
import type { StartupInstallStatus } from "../../infra/update-install-status.types.js";
import { renderUpdateRunNotice } from "../../infra/update-run-notice.js";
import {
  createUpdateRunAsync,
  finishUpdateRunAsync,
  recordUpdateRunPhaseAsync,
} from "../../infra/update-run-write.async.js";
import { resolveUnmanagedUpdateInstallReason } from "../../infra/update-runner-install-surface.js";
import { prepareUpdate } from "../../update/run.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isBrowserOperatorUiClient,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";
import { VERSION } from "../../version.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { wakeUpdateRunWatcher } from "../update-run-watcher.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { admitGatewayUpdateRequest } from "./update-admission.js";
import { appUpdateNoticePublisher } from "./update-app-notice.js";
import { updateHandlers as legacyUpdateHandlers } from "./update.js";

export const updateRunHandler: GatewayRequestHandler = async (request) => {
  const { respond, client, context } = request;
  const installed = await readInstallStatus();
  const params = await admitGatewayUpdateRequest(request);
  if (!params) {
    return;
  }
  if (isGatewayExternallySupervised()) {
    respond(true, {
      runId: null,
      ok: false,
      code: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      message:
        "Use the external supervisor's update workflow to stop, update, and restart the Gateway.",
      result: { status: "skipped", reason: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON },
    });
    return;
  }
  const root = installed.root ?? installed.status.root;
  if (
    !root ||
    (installed.status.installKind !== "git" && installed.status.installKind !== "package")
  ) {
    const reason = resolveUnmanagedUpdateInstallReason();
    respond(true, {
      runId: null,
      ok: false,
      code: reason,
      message: "Update this installation with its original installation method.",
      result: { status: "skipped", reason },
    });
    return;
  }
  const config = context.getRuntimeConfig();
  const requester = params.requester;
  const fromChat = Boolean(requester?.channel && !isInternalMessageChannel(requester.channel));
  if (fromChat && requester) {
    const authority = await prepareCommandOwnerAuthority(config, requester);
    const reason = !authority?.isCurrent(config)
      ? "owner_required"
      : !isRestartEnabled(config)
        ? "restart-disabled"
        : undefined;
    if (reason) {
      const message =
        reason === "owner_required"
          ? `Only the OpenClaw owner can start an update from chat. ${formatCommandOwnerHint({ cfg: config, channel: requester.channel, id: requester.senderId })}`
          : "Updates from chat are disabled (commands.restart=false). Use the OpenClaw app or ask the Gateway operator to update OpenClaw.";
      respond(true, {
        runId: null,
        ok: false,
        code: reason,
        message,
        result: { status: "skipped", reason },
      });
      return;
    }
  }
  // The prepared release starts only in a new process; refuse before anything changes.
  const restart = resolveGatewayRestartDecision();
  if (restart.mode === "disabled" && restart.reason === "no-respawn") {
    respond(true, {
      runId: null,
      ok: false,
      code: "restart-unavailable",
      message:
        "This Gateway cannot restart because OPENCLAW_NO_RESPAWN is enabled. Stop the Gateway, run openclaw update, then start it again. To allow updates from the Gateway, relaunch it without OPENCLAW_NO_RESPAWN.",
      result: { status: "skipped", reason: "restart-unavailable" },
    });
    return;
  }
  // A scheduled campaign pins its commit; a manual request applies that commit, as package installs do.
  const adoption = currentUpdateCheckLifecycle().campaign?.adopt(
    params.target ? devUpdateTargetFromGitTarget(params.target) : undefined,
  );
  if (adoption?.status === "mismatch" || adoption?.status === "applying") {
    const reason =
      adoption.status === "mismatch"
        ? "update-target-campaign-mismatch"
        : "update-campaign-applying";
    respond(true, {
      runId: null,
      ok: false,
      code: reason,
      message:
        adoption.status === "mismatch"
          ? "A scheduled update targets a different commit. Update without --sha to apply it."
          : "A scheduled update is being applied. Try again in a few minutes.",
      result: { status: "skipped", reason },
    });
    return;
  }
  const campaign = adoption?.status === "adopted" ? adoption : undefined;
  const sha =
    params.target?.upstreamSha ??
    (campaign?.target.kind === "git" ? campaign.target.upstreamSha : undefined);
  const tag = campaign?.target.kind === "package" ? campaign.target.version : undefined;
  const trigger = fromChat
    ? "chat"
    : isBrowserOperatorUiClient(client?.connect.client) || params.sessionKey
      ? "control-ui"
      : "api";
  // Desktop and browser requests see the run outside the conversation, as package installs do.
  const publishAppUpdate = fromChat
    ? undefined
    : appUpdateNoticePublisher(request, requester?.channel);
  const run = await createUpdateRunAsync({
    trigger: campaign ? "campaign" : trigger,
    origin: {
      ...(publishAppUpdate ? { noticeSurface: "app" as const } : {}),
      ...(campaign ? { campaignId: campaign.campaignId } : {}),
      ...(requester ? { requester } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(fromChat ? {} : { deliveryContext: { channel: INTERNAL_MESSAGE_CHANNEL } }),
    },
    before: { version: VERSION },
    ...(sha ? { target: { kind: "git", sha } } : {}),
    ...(tag ? { target: { kind: "package", version: tag } } : {}),
  });
  if (campaign) {
    currentUpdateCheckLifecycle().campaign?.bindRun(campaign.campaignId, run.runId);
  }
  publishAppUpdate?.(run);
  context.logGateway?.info(
    `update.run ${run.runId} ${formatControlPlaneActor(resolveControlPlaneActor(client))}`,
  );
  // The requester hears that the update started; the Gateway after the switch sends the outcome.
  // The notifier writes nothing for an app-surface run.
  const { createUpdateRunNotifier } = await import("../update-run-notice.runtime.js");
  const notify = await createUpdateRunNotifier(run, () => context.getRuntimeConfig(), context.deps);
  const ack = await notify(run, "ack");
  respond(true, {
    runId: run.runId,
    ok: true,
    ackDelivered: ack.delivered,
    ackQueued: ack.owned,
    ...(publishAppUpdate
      ? { noticeInApp: true }
      : { acknowledgement: renderUpdateRunNotice(run, "ack") ?? undefined }),
    result: { status: "ok", mode: "unknown", steps: [], durationMs: 0 },
  });
  wakeUpdateRunWatcher();
  void runUpdateInBackground(run.runId, {
    root,
    installKind: installed.status.installKind,
    channel: normalizeUpdateChannel(config.update?.channel),
    git: installed.status.git,
    sha,
    tag,
    timeoutMs: params.timeoutMs,
    restartDelayMs: params.restartDelayMs,
    sessionKey: params.sessionKey,
    warn: (message) => context.logGateway?.warn(message),
  });
};

async function runUpdateInBackground(
  runId: string,
  options: {
    root: string;
    installKind: StartupInstallStatus["status"]["installKind"];
    channel: ReturnType<typeof normalizeUpdateChannel>;
    /** The checkout's tag and branch facts; a stable tag keeps a configless checkout on stable. */
    git?: { tag?: string | null; branch?: string | null };
    sha?: string;
    tag?: string;
    /** The requester's overall budget (`timeoutMs`). */
    timeoutMs?: number;
    /** The requester's `restartDelayMs`, as the package route honors it. */
    restartDelayMs?: number;
    sessionKey?: string;
    warn: (message: string) => void;
  },
) {
  try {
    const channel = resolveEffectiveUpdateChannel({
      configChannel: options.channel,
      currentVersion: VERSION,
      installKind: options.installKind,
      git: options.git,
    }).channel;
    const outcome = await prepareUpdate({
      runId,
      runningRoot: options.root,
      runningVersion: VERSION,
      channel,
      sha: options.sha,
      tag: options.tag,
      timeoutMs: options.timeoutMs,
    });
    const restart = {
      reason: "update.run",
      sessionKey: options.sessionKey,
      delayMs: normalizeGatewayRestartDelayMs(options.restartDelayMs),
    };
    // Changed plugins of an already-current install load in a new process, as after a core update.
    if (outcome.status === "current" && outcome.pluginsChanged) {
      scheduleGatewayRestart(restart);
    }
    if (outcome.status === "pending") {
      await recordUpdateRunPhaseAsync(runId, "restarting");
      // A process-replacing reason: the next process starts through the release launcher.
      scheduleGatewayRestart(restart);
    }
  } catch (error) {
    options.warn(`update.run ${runId} failed: ${String(error)}`);
    // Detached work: a failed record must not become an unhandled rejection.
    try {
      await finishUpdateRunAsync(runId, {
        status: "failed",
        reason: "update-failed",
        nextAction: "The update failed before anything changed. Run `openclaw update` to retry.",
        diagnostics: { failure: { step: "outcome", detail: String(error) } },
      });
    } catch (recordError) {
      options.warn(`update.run ${runId} outcome was not recorded: ${String(recordError)}`);
    }
  } finally {
    wakeUpdateRunWatcher();
  }
}

/** The install facts update admission and `update.status` already use. */
async function readInstallStatus() {
  const lifecycle = currentUpdateCheckLifecycle();
  return await lifecycle.run((signal) =>
    resolveStartupInstallStatus(false, signal, lifecycle.installStatus),
  );
}

/** All owned installs update through prepared releases. */
export const routedUpdateHandlers: GatewayRequestHandlers = {
  ...legacyUpdateHandlers,
  "update.run": updateRunHandler,
};
