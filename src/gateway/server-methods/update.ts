import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { prepareCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import { UpdatePreMutationError } from "../../cli/update-cli/shared.js";
import { formatCommandOwnerHint } from "../../commands/doctor-command-owner.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "../../infra/gateway-supervision.js";
import { readPackageVersion } from "../../infra/package-json.js";
import {
  writeRestartSentinel,
  formatDoctorNonInteractiveHint,
} from "../../infra/restart-sentinel.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { currentUpdateCheckLifecycle } from "../../infra/update-check-lifecycle.js";
import { devUpdateTargetFromGitTarget } from "../../infra/update-dev-target.js";
import {
  buildUpdateRestartSentinelPayload,
  type UpdateRestartSentinelMeta,
} from "../../infra/update-restart-sentinel-payload.js";
import { renderUpdateRunNotice } from "../../infra/update-run-notice.js";
import { getUpdateRunAsync as getUpdateRun } from "../../infra/update-run-reader.js";
import {
  createUpdateRunAsync as createUpdateRun,
  finishUpdateRunAsync as finishUpdateRun,
  recordUpdateRunPhaseAsync as recordUpdateRunPhase,
  recordUpdateRunVerificationAsync as recordUpdateRunVerification,
} from "../../infra/update-run-write.async.js";
import { resolveUnmanagedUpdateInstallReason } from "../../infra/update-runner-install-surface.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { getUpdateAvailable } from "../../infra/update-status-state.js";
import { SystemPackageOwnershipError } from "../../infra/update-system-package-ownership.js";
import { mergeDeliveryContext } from "../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isBrowserOperatorUiClient,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";
import { VERSION } from "../../version.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { recordLatestUpdateRestartSentinel } from "../server-update-sentinel.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveUpdateRunNoticeTarget } from "../update-run-notice-target.js";
import { wakeUpdateRunWatcher } from "../update-run-watcher.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  admitGatewayUpdateRequest,
  createUnexpectedUpdateFailureResult,
  readForegroundUpdateOrigin,
  resolveGatewayUpdateAdmission,
  reportImmutableGatewayUpdateRefusal,
} from "./update-admission.js";
import { updateRecoveryCleanupHandler } from "./update-cleanup.js";
import { recordGatewayUpdateOutcome } from "./update-outcome-observation.js";
import { updateReportHandler } from "./update-report.js";
import { prepareGatewaySlotUpdate } from "./update-runtime-slot.js";
import { updateStatusHandlers } from "./update-status.js";

export const updateHandlers: GatewayRequestHandlers = {
  ...updateStatusHandlers,
  "update.report": updateReportHandler,
  "update.recovery.cleanup": updateRecoveryCleanupHandler,
  "update.run": async (request) => {
    const { respond, client, context, sessionMutationCommitGuard } = request;
    const params = await admitGatewayUpdateRequest(request);
    if (!params) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const {
      sessionKey: rawSessionKey,
      deliveryContext: requestedDeliveryContext,
      threadId: requestedThreadId,
      note,
      continuationMessage,
    } = parseRestartRequestParams(params);
    const getConfig = context.getRuntimeConfig;
    const config = getConfig();
    let sessionKey: string | undefined;
    if (rawSessionKey) {
      try {
        sessionKey = resolveSessionStoreIdentity({
          cfg: config,
          sessionKey: rawSessionKey,
        }).canonicalKey;
      } catch (error) {
        if (!(error instanceof AgentSelectionRequiredError)) {
          throw error;
        }
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
    }
    const { deliveryContext: sessionDeliveryContext, threadId: sessionThreadId } =
      await extractDeliveryInfo(sessionKey, { cfg: config });
    let deliveryContext = mergeDeliveryContext(requestedDeliveryContext, sessionDeliveryContext);
    const threadId = requestedThreadId ?? sessionThreadId;
    const timeoutMs = params.timeoutMs === undefined ? undefined : Math.max(1000, params.timeoutMs);

    const requesterChannel = params.requester?.channel;
    const trigger =
      requesterChannel && !isInternalMessageChannel(requesterChannel)
        ? "chat"
        : isBrowserOperatorUiClient(client?.connect.client) ||
            (sessionKey && isInternalMessageChannel(requesterChannel ?? deliveryContext?.channel))
          ? "control-ui"
          : "api";
    const requesterInput = params.requester ? { ...params.requester } : undefined;
    const requesterAuthority =
      requesterInput?.channel && !isInternalMessageChannel(requesterInput.channel)
        ? await prepareCommandOwnerAuthority(config, requesterInput)
        : undefined;
    const requester = requesterInput && {
      ...requesterInput,
      ...(requesterAuthority ? { authorizationSource: requesterAuthority.source ?? "" } : {}),
    };
    const noticeTarget = await resolveUpdateRunNoticeTarget({
      cfg: config,
      sessionKey,
      explicitDeliveryContext: deliveryContext,
      threadId,
    });
    // Recording an internal destination does not change the caller's trigger classification.
    if (noticeTarget.kind === "internal") {
      deliveryContext = { channel: INTERNAL_MESSAGE_CHANNEL };
    }
    const origin = {
      doctorHint: formatDoctorNonInteractiveHint(),
      ...(requester ? { requester } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(deliveryContext
        ? {
            deliveryContext: {
              channel: deliveryContext.channel,
              to: deliveryContext.to,
              accountId: deliveryContext.accountId,
              threadId:
                threadId ??
                (deliveryContext.threadId != null ? String(deliveryContext.threadId) : undefined),
            },
          }
        : {}),
    };
    const run = await createUpdateRun({
      trigger,
      origin,
      before: { version: VERSION },
      ...(params.target ? { target: { kind: "git", sha: params.target.upstreamSha } } : {}),
    });
    const runId = run.runId;
    const warn = (message: string) => context?.logGateway?.warn(message);
    await recordUpdateRunVerification(runId, {
      runningVersion: VERSION,
      serviceRunning: true,
      pid: process.pid,
    });
    wakeUpdateRunWatcher();

    let result: UpdateRunResult = {
      status: "error",
      mode: "unknown",
      steps: [],
      durationMs: 0,
    };
    let handoff: { status: "started"; command: string } | null = null;
    let slotUpdate: { start: (sentinelPersisted: boolean) => Promise<void> } | undefined;
    let ackDelivered = false;
    let ackQueued = false;
    let acknowledgement: string | undefined;
    let outcomeMessage: string | undefined;
    const assertUpdateAdmissionCurrent = () => {
      try {
        sessionMutationCommitGuard?.();
      } catch {
        outcomeMessage =
          "This update no longer has a live requester principal or scheduled operator admission. Ask the operator to run the update again.";
        throw new UpdatePreMutationError("owner_required", outcomeMessage);
      }
    };
    let ownsUpdateOutcome = false;
    const updateLifecycle = currentUpdateCheckLifecycle();
    let adoptedCampaignId: string | undefined;
    const ownsAdoptedCampaign = () =>
      adoptedCampaignId === undefined ||
      updateLifecycle.campaign?.getState()?.id === adoptedCampaignId;
    const refuseUnauthorizedChatUpdate = async () => {
      // Chat update authority is revocable; internal or channel-less requesters
      // retain the operator authority established at admission.
      if (!requester?.channel || isInternalMessageChannel(requester.channel)) {
        return false;
      }
      const currentConfig = getConfig();
      const reason =
        !requester.authorizationSource || !requesterAuthority?.isCurrent(currentConfig)
          ? "owner_required"
          : !isRestartEnabled(currentConfig)
            ? "restart-disabled"
            : undefined;
      if (!reason) {
        return false;
      }
      const message =
        reason === "owner_required"
          ? `Only the OpenClaw owner can start an update from chat. ${formatCommandOwnerHint({ cfg: currentConfig, channel: requester.channel, id: requester.senderId })}`
          : "Updates from chat are disabled (commands.restart=false). Use the Control UI or ask the Gateway operator to update OpenClaw.";
      if (adoptedCampaignId && updateLifecycle.campaign?.getState()?.id === adoptedCampaignId) {
        updateLifecycle.campaign?.clear();
      }
      await recordUpdateRunPhase(runId, "requested", { origin: { nextAction: message } });
      const refusedRun = await finishUpdateRun(runId, {
        status: reason === "owner_required" ? "failed" : "skipped",
        reason,
      });
      respond(true, {
        runId,
        ok: false,
        code: reason,
        message,
        ackDelivered,
        ackQueued,
        acknowledgement,
        result: { status: reason === "owner_required" ? "error" : "skipped", reason },
      });
      return refusedRun;
    };
    if (await refuseUnauthorizedChatUpdate()) {
      return;
    }
    const { createUpdateRunNotifier } = await import("../update-run-notice.runtime.js");
    const notify = await createUpdateRunNotifier(run, getConfig, context.deps, noticeTarget);
    const sentinelMeta: UpdateRestartSentinelMeta = {
      runId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(deliveryContext ? { deliveryContext } : {}),
      ...(threadId ? { threadId } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(continuationMessage !== undefined ? { continuationMessage } : {}),
    };
    try {
      const configChannel = normalizeUpdateChannel(config.update?.channel);
      const { status, installSurface } = await resolveGatewayUpdateAdmission(runId, timeoutMs);
      const installRoot = installSurface.root;
      result.mode = installSurface.mode;
      result.root = installRoot;
      const refusedUpdate = (
        outcome: "error" | "skipped",
        reason: string,
        beforeVersion?: string | null,
      ): UpdateRunResult => ({
        status: outcome,
        mode: installSurface.mode,
        ...(installRoot ? { root: installRoot } : {}),
        ...(beforeVersion ? { before: { version: beforeVersion } } : {}),
        reason,
        steps: [],
        durationMs: 0,
      });
      if (installSurface.kind === "immutable") {
        await reportImmutableGatewayUpdateRefusal(runId, installSurface, respond);
        return;
      }
      const effectiveChannel = resolveEffectiveUpdateChannel({
        configChannel,
        currentVersion: VERSION,
        installKind: status.installKind,
        git: status.git,
      }).channel;
      const explicitDevTarget = params.target
        ? devUpdateTargetFromGitTarget(params.target)
        : undefined;
      let targetFailureReason =
        explicitDevTarget && (installSurface.kind !== "git" || effectiveChannel !== "dev")
          ? "unsupported-update-target"
          : explicitDevTarget && explicitDevTarget.upstreamRef !== status.git?.upstream
            ? "update-target-upstream-mismatch"
            : undefined;
      const adoption = targetFailureReason
        ? undefined
        : updateLifecycle.campaign?.adopt(explicitDevTarget);
      if (adoption?.status === "mismatch") {
        targetFailureReason = "update-target-campaign-mismatch";
      } else if (adoption?.status === "applying") {
        targetFailureReason = "update-campaign-applying";
      }
      ownsUpdateOutcome = targetFailureReason === undefined;
      const adoptedCampaign = adoption?.status === "adopted" ? adoption : undefined;
      adoptedCampaignId = adoptedCampaign?.campaignId;
      const adoptedDevTarget =
        adoptedCampaign?.target.kind === "git"
          ? devUpdateTargetFromGitTarget(adoptedCampaign.target)
          : undefined;
      const adoptedPackageTargetVersion =
        adoptedCampaign?.target.kind === "package"
          ? adoptedCampaign.target.version.trim() || undefined
          : undefined;
      const devTarget = explicitDevTarget ?? adoptedDevTarget;
      await recordUpdateRunPhase(runId, "requested", {
        ...(adoptedCampaign
          ? { trigger: "campaign", origin: { campaignId: adoptedCampaign.campaignId } }
          : {}),
        target: {
          channel: effectiveChannel,
          kind: installSurface.kind === "git" ? "git" : "package",
          ...(devTarget ? { sha: devTarget.upstreamSha } : {}),
          ...(adoptedPackageTargetVersion ? { version: adoptedPackageTargetVersion } : {}),
        },
      });
      if (adoptedCampaign) {
        updateLifecycle.campaign?.bindRun(adoptedCampaign.campaignId, runId);
        context?.logGateway?.info(
          `update.run adopted campaign ${adoptedCampaign.campaignId} ${formatControlPlaneActor(actor)}`,
          { target: adoptedCampaign.target },
        );
      }
      sentinelMeta.target = devTarget
        ? `${devTarget.upstreamRef}@${devTarget.upstreamSha}`
        : adoptedPackageTargetVersion
          ? `version ${adoptedPackageTargetVersion}`
          : `${effectiveChannel} channel`;
      const acknowledgeUpdate = async (beforeVersion: string | null) => {
        if (await refuseUnauthorizedChatUpdate()) {
          return false;
        }
        const targetVersion = adoptedPackageTargetVersion ?? getUpdateAvailable()?.latestVersion;
        const acknowledgedRun = await recordUpdateRunPhase(runId, "requested", {
          before: { version: beforeVersion ?? VERSION },
          ...(targetVersion ? { target: { version: targetVersion } } : {}),
        });
        acknowledgement = renderUpdateRunNotice(acknowledgedRun, "ack") ?? undefined;
        const ack = await notify(acknowledgedRun, "ack");
        ackDelivered = ack.delivered;
        ackQueued = ack.owned;
        return true;
      };
      const detectedSupervisor = detectRespawnSupervisor(process.env, process.platform, {
        includeLinuxOpenClawGatewayServiceMarker: true,
      });
      const foregroundOrigin = await readForegroundUpdateOrigin();
      const assertForegroundRespawnEnabled = () => {
        if (foregroundOrigin && isTruthyEnvValue(process.env.OPENCLAW_NO_RESPAWN)) {
          outcomeMessage =
            "This foreground Gateway cannot restart because OPENCLAW_NO_RESPAWN is enabled. Stop the Gateway, run openclaw update, then start it again. To allow updates from the Gateway, relaunch it without OPENCLAW_NO_RESPAWN.";
          throw new UpdatePreMutationError("restart-unavailable", outcomeMessage);
        }
      };
      const supervisor = foregroundOrigin ? null : detectedSupervisor;
      if (supervisor) {
        await recordUpdateRunPhase(runId, "requested", {
          target: { installationMethod: "managed-service" },
        });
      }
      const handoffChannel =
        installSurface.kind === "git"
          ? undefined
          : effectiveChannel === "extended-stable"
            ? effectiveChannel
            : (configChannel ?? undefined);
      if (targetFailureReason) {
        result = refusedUpdate("error", targetFailureReason);
      } else if (installSurface.kind === "missing") {
        result = refusedUpdate("error", "not-openclaw-root");
      } else if (isGatewayExternallySupervised()) {
        const beforeVersion = await readPackageVersion(installSurface.root);
        result = refusedUpdate(
          "skipped",
          EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
          beforeVersion,
        );
      } else if (installSurface.kind === "package-root") {
        result = refusedUpdate(
          "skipped",
          resolveUnmanagedUpdateInstallReason(),
          await readPackageVersion(installSurface.root),
        );
      } else if (!isRestartEnabled(config) && !supervisor) {
        // Package updates need a restart path to finish safely. Dev/git installs
        // can report the disabled restart directly, but global installs must not
        // mutate files if this process cannot come back.
        const beforeVersion = installSurface.root
          ? await readPackageVersion(installSurface.root)
          : null;
        result = refusedUpdate(
          "skipped",
          installSurface.kind === "global" ? "restart-unavailable" : "restart-disabled",
          beforeVersion,
        );
      } else if (!installRoot) {
        result = refusedUpdate("error", "not-openclaw-root");
      } else {
        const prepared = await prepareGatewaySlotUpdate({
          runId,
          installRoot,
          mode: installSurface.mode,
          request: { channel: handoffChannel, tag: adoptedPackageTargetVersion, timeoutMs },
          sha: devTarget?.upstreamSha,
          actor,
          log: context?.logGateway,
        });
        if (prepared.external) {
          outcomeMessage = prepared.external.message;
          result = refusedUpdate(
            "skipped",
            prepared.external.reason,
            await readPackageVersion(installRoot),
          );
        } else {
          assertForegroundRespawnEnabled();
          if (!(await acknowledgeUpdate(prepared.result.before?.version ?? null))) {
            return;
          }
          assertUpdateAdmissionCurrent();
          ({ handoff, result } = prepared);
          slotUpdate = prepared;
          ownsUpdateOutcome = true;
        }
      }
    } catch (error) {
      if (error instanceof SystemPackageOwnershipError) {
        outcomeMessage = error.message;
      }
      context?.logGateway?.warn(`update.run failed error=${formatErrorMessage(error)}`);
      let recorded = run;
      try {
        recorded = (await getUpdateRun(runId)) ?? run;
      } catch {
        context?.logGateway?.warn(
          "Update history could not be read; preserving the original update failure with captured admission facts.",
        );
      }
      result = await createUnexpectedUpdateFailureResult(recorded, result, error, warn);
    }

    let outcomeRun = await recordUpdateRunPhase(runId, "requested", {
      before: result.before,
      after: result.after,
      ...(outcomeMessage ? { origin: { nextAction: outcomeMessage } } : {}),
    });
    // A managed orchestrator or the replacement Gateway owns terminal success;
    // refusals and synchronous failures have no later process to finish the run.
    if (handoff?.status !== "started") {
      outcomeRun = await finishUpdateRun(runId, {
        status: result.status === "skipped" ? "skipped" : "failed",
        reason: result.reason,
        after: result.after,
      });
    }

    // Rejected requests and retired campaigns cannot replace another update's outcome.
    ownsUpdateOutcome &&= ownsAdoptedCampaign();
    const payload = buildUpdateRestartSentinelPayload({
      result,
      meta: sentinelMeta,
    });

    let sentinelPersisted = false;
    if (ownsUpdateOutcome) {
      try {
        await writeRestartSentinel(payload, undefined, () => {
          if (!ownsAdoptedCampaign()) {
            throw new Error("Update campaign retired before restart sentinel persistence");
          }
        });
        sentinelPersisted = true;
        if (ownsAdoptedCampaign()) {
          recordLatestUpdateRestartSentinel(payload);
        }
      } catch (error) {
        warn(`update.run restart sentinel was not persisted: ${formatErrorMessage(error)}`);
      }
    }

    void slotUpdate?.start(sentinelPersisted);
    // Publish the outcome before the terminal campaign event prompts clients to
    // read it. Recheck ownership after persistence may have yielded to a replacement.
    if (
      ownsUpdateOutcome &&
      handoff?.status !== "started" &&
      adoptedCampaignId !== undefined &&
      ownsAdoptedCampaign()
    ) {
      updateLifecycle.campaign?.clear();
      context?.logGateway?.info("update.run failed; adopted campaign cleared", {
        campaignId: adoptedCampaignId,
      });
    }

    if ((ackDelivered || ackQueued) && handoff?.status !== "started") {
      await notify(outcomeRun, "finished");
    }
    recordGatewayUpdateOutcome(result, actor, context?.logGateway);
    respond(
      true,
      {
        runId,
        ok: handoff?.status === "started",
        ackDelivered,
        ackQueued,
        acknowledgement,
        ...(outcomeMessage ? { message: outcomeMessage } : {}),
        result,
        ...(handoff ? { handoff } : {}),
        restart: null,
        sentinel: {
          persisted: sentinelPersisted,
          payload,
        },
      },
      undefined,
    );
  },
};
