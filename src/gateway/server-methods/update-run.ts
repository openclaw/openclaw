// `update.run`: admit the request, record the run, answer with its ID, then prepare the
// release in the background. A pending trial ends with a cooperative restart; the launcher
// switches and the Gateway that starts next finishes the run (src/update/gateway-trial.ts).
import { prepareCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import { formatCommandOwnerHint } from "../../commands/doctor-command-owner.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { scheduleGatewayRestart } from "../../infra/restart.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { currentUpdateCheckLifecycle } from "../../infra/update-check-lifecycle.js";
import { resolveStartupInstallStatus } from "../../infra/update-install-status.js";
import { renderUpdateRunNotice } from "../../infra/update-run-notice.js";
import {
  createUpdateRunAsync,
  finishUpdateRunAsync,
  recordUpdateRunPhaseAsync,
} from "../../infra/update-run-write.async.js";
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
import { updateHandlers as legacyUpdateHandlers } from "./update.js";

export const updateRunHandler: GatewayRequestHandler = async (request) => {
  const { respond, client, context } = request;
  // Git installs move to the release launcher first; package installs follow in the next change.
  const installed = await readInstallStatus();
  if (!installed.root || installed.status.installKind !== "git") {
    return await legacyUpdateHandlers["update.run"]!(request);
  }
  const params = await admitGatewayUpdateRequest(request);
  if (!params) {
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
  const trigger = fromChat
    ? "chat"
    : isBrowserOperatorUiClient(client?.connect.client) || params.sessionKey
      ? "control-ui"
      : "api";
  const run = await createUpdateRunAsync({
    trigger,
    origin: {
      ...(requester ? { requester } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(fromChat ? {} : { deliveryContext: { channel: INTERNAL_MESSAGE_CHANNEL } }),
    },
    before: { version: VERSION },
    ...(params.target ? { target: { kind: "git", sha: params.target.upstreamSha } } : {}),
  });
  context.logGateway?.info(
    `update.run ${run.runId} ${formatControlPlaneActor(resolveControlPlaneActor(client))}`,
  );
  // The requester hears that the update started; the Gateway after the switch sends the outcome.
  const { createUpdateRunNotifier } = await import("../update-run-notice.runtime.js");
  const notify = await createUpdateRunNotifier(run, () => context.getRuntimeConfig(), context.deps);
  const ack = await notify(run, "ack");
  respond(true, {
    runId: run.runId,
    ok: true,
    ackDelivered: ack.delivered,
    ackQueued: ack.owned,
    acknowledgement: renderUpdateRunNotice(run, "ack") ?? undefined,
    result: { status: "ok", mode: "unknown", steps: [], durationMs: 0 },
  });
  wakeUpdateRunWatcher();
  void runUpdateInBackground(run.runId, {
    root: installed.root,
    channel: normalizeUpdateChannel(config.update?.channel),
    sha: params.target?.upstreamSha,
    sessionKey: params.sessionKey,
    warn: (message) => context.logGateway?.warn(message),
  });
};

async function runUpdateInBackground(
  runId: string,
  options: {
    root: string;
    channel: ReturnType<typeof normalizeUpdateChannel>;
    sha?: string;
    sessionKey?: string;
    warn: (message: string) => void;
  },
) {
  try {
    const channel = resolveEffectiveUpdateChannel({
      configChannel: options.channel,
      currentVersion: VERSION,
      installKind: "git",
    }).channel;
    const outcome = await prepareUpdate({
      runId,
      runningRoot: options.root,
      runningVersion: VERSION,
      channel,
      sha: options.sha,
    });
    if (outcome.status === "pending") {
      await recordUpdateRunPhaseAsync(runId, "restarting");
      // A process-replacing reason: the next process starts through the release launcher.
      scheduleGatewayRestart({ reason: "update.run", sessionKey: options.sessionKey });
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

/** The update handlers with `update.run` routed by install kind. */
export const updateHandlers: GatewayRequestHandlers = {
  ...legacyUpdateHandlers,
  "update.run": updateRunHandler,
};
