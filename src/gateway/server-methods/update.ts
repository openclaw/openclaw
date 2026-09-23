// Update gateway methods run self-update flows, report status, write restart
// sentinels, and hand off managed-service restarts when needed.
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateUpdateRunParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { prepareCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import { UpdatePreMutationError } from "../../cli/update-cli/shared.js";
import { formatCommandOwnerHint } from "../../commands/doctor-command-owner.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { resolveConfigPath } from "../../config/paths.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "../../infra/gateway-supervision.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../../infra/restart-budget.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import {
  type RestartSentinelPayload,
  writeRestartSentinel,
  formatDoctorNonInteractiveHint,
} from "../../infra/restart-sentinel.js";
import { normalizeGatewayRestartDelayMs, scheduleGatewayRestart } from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { gatewayUpdateCampaign } from "../../infra/update-campaign.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "../../infra/update-control-plane-sentinel.js";
import { devUpdateTargetFromGitTarget } from "../../infra/update-dev-target.js";
import { FreeBsdPkgOwnershipError } from "../../infra/update-freebsd-pkg-ownership.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import {
  cancelManagedServiceUpdateHandoff,
  claimManagedServiceUpdateHandoff,
  transferManagedServiceUpdateHandoff,
  startManagedServiceUpdateHandoff,
} from "../../infra/update-managed-service-handoff.js";
import {
  buildUpdateRestartSentinelPayload,
  type UpdateRestartSentinelMeta,
  type ForegroundUpdateOrigin,
} from "../../infra/update-restart-sentinel-payload.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunNotice } from "../../infra/update-run-report.js";
import { resolveUnmanagedUpdateInstallReason } from "../../infra/update-runner-install-surface.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { getUpdateAvailable } from "../../infra/update-status-state.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { mergeDeliveryContext } from "../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isBrowserOperatorUiClient,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";
import { VERSION } from "../../version.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { recordLatestUpdateRestartSentinel } from "../server-restart-sentinel.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveUpdateRunNoticeTarget } from "../update-run-notice-target.js";
import { wakeUpdateRunWatcher } from "../update-run-watcher.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  retainUpdateRequesterAuthority,
  createUnexpectedUpdateFailureResult,
  recordHandoffFailure,
  resolveGatewayUpdateAdmission,
} from "./update-admission.js";
import { updateReportHandler } from "./update-report.js";
import { updateStatusHandlers } from "./update-status.js";
import { assertValidParams } from "./validation.js";

const MANAGED_HANDOFF_ALREADY_RUNNING_REASON = "managed-service-handoff-already-running";

export const updateHandlers: GatewayRequestHandlers = {
  ...updateStatusHandlers,
  "update.report": updateReportHandler,
  "update.run": async ({ params, respond, client, context, sessionMutationCommitGuard }) => {
    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const {
      sessionKey: rawSessionKey,
      deliveryContext: requestedDeliveryContext,
      threadId: requestedThreadId,
      note,
      continuationMessage,
      restartDelayMs: requestedRestartDelayMs,
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
    const restartDelayMs = normalizeGatewayRestartDelayMs(requestedRestartDelayMs);
    const { deliveryContext: sessionDeliveryContext, threadId: sessionThreadId } =
      extractDeliveryInfo(sessionKey, { cfg: config });
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
    const retainedRequesterAuthority = retainUpdateRequesterAuthority(
      requester,
      requesterAuthority,
      getConfig,
    );
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
    const run = createUpdateRun({
      trigger,
      origin,
      before: { version: VERSION },
      ...(params.target ? { target: { kind: "git", sha: params.target.upstreamSha } } : {}),
    });
    const runId = run.runId;
    const warn = (message: string) => context?.logGateway?.warn(message);
    recordUpdateRunVerification(runId, {
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
    let handoff:
      | { status: "started"; pid?: number; command: string }
      | { status: "already-running" | "unavailable"; command: string; message: string }
      | null = null;
    let managedHandoffOwner: GatewayRestartIntent["successorOwner"];
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
    let adoptedCampaignId: string | undefined;
    const refuseUnauthorizedChatUpdate = () => {
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
      if (adoptedCampaignId && gatewayUpdateCampaign.getState()?.id === adoptedCampaignId) {
        gatewayUpdateCampaign.clear();
      }
      recordUpdateRunPhase(runId, "requested", { origin: { nextAction: message } });
      const refusedRun = finishUpdateRun(runId, {
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
    if (refuseUnauthorizedChatUpdate()) {
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
      const effectiveChannel = resolveEffectiveUpdateChannel({
        configChannel,
        currentVersion: VERSION,
        installKind: status.installKind,
        git: status.git,
      }).channel;
      const requestedTarget = params.target;
      const explicitDevTarget =
        isRecord(requestedTarget) &&
        requestedTarget.kind === "git" &&
        typeof requestedTarget.upstreamRef === "string" &&
        /^[^\s\p{Cc}]+$/u.test(requestedTarget.upstreamRef) &&
        typeof requestedTarget.upstreamSha === "string" &&
        /^[a-f\d]{40}$/iu.test(requestedTarget.upstreamSha)
          ? devUpdateTargetFromGitTarget({
              upstreamRef: requestedTarget.upstreamRef,
              upstreamSha: requestedTarget.upstreamSha,
            })
          : undefined;
      let targetFailureReason =
        requestedTarget !== undefined && !explicitDevTarget
          ? "invalid-update-target"
          : explicitDevTarget && (installSurface.kind !== "git" || effectiveChannel !== "dev")
            ? "unsupported-update-target"
            : explicitDevTarget && explicitDevTarget.upstreamRef !== status.git?.upstream
              ? "update-target-upstream-mismatch"
              : undefined;
      const adoption = targetFailureReason
        ? undefined
        : gatewayUpdateCampaign.adopt(explicitDevTarget);
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
      if (adoptedCampaign) {
        context?.logGateway?.info(
          `update.run adopted campaign ${adoptedCampaign.campaignId} ${formatControlPlaneActor(actor)}`,
          { target: adoptedCampaign.target },
        );
      }
      const devTarget = explicitDevTarget ?? adoptedDevTarget;
      recordUpdateRunPhase(runId, "requested", {
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
      sentinelMeta.target = devTarget
        ? `${devTarget.upstreamRef}@${devTarget.upstreamSha}`
        : adoptedPackageTargetVersion
          ? `version ${adoptedPackageTargetVersion}`
          : `${effectiveChannel} channel`;
      const acknowledgeUpdate = async (beforeVersion: string | null) => {
        if (refuseUnauthorizedChatUpdate()) {
          return false;
        }
        const targetVersion = adoptedPackageTargetVersion ?? getUpdateAvailable()?.latestVersion;
        const acknowledgedRun = recordUpdateRunPhase(runId, "requested", {
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
      const gatewayOwner = readGatewayOwnerLease({ current: true });
      const foregroundOrigin: ForegroundUpdateOrigin | undefined =
        gatewayOwner?.mode === "foreground" &&
        gatewayOwner.state === "live" &&
        gatewayOwner.pid === process.pid &&
        gatewayOwner.startedAt !== null
          ? {
              owner: gatewayOwner.owner,
              pid: gatewayOwner.pid,
              host: gatewayOwner.host,
              startedAt: gatewayOwner.startedAt,
              port: gatewayOwner.port,
              stateDatabasePath: resolvePathViaExistingAncestorSync(
                resolveOpenClawStateSqlitePath(),
              ),
              configPath: resolvePathViaExistingAncestorSync(resolveConfigPath()),
            }
          : undefined;
      const assertForegroundRespawnEnabled = () => {
        if (foregroundOrigin && isTruthyEnvValue(process.env.OPENCLAW_NO_RESPAWN)) {
          outcomeMessage =
            "This foreground Gateway cannot restart because OPENCLAW_NO_RESPAWN is enabled. Stop the Gateway, run openclaw update, then start it again. To allow updates from the Gateway, relaunch it without OPENCLAW_NO_RESPAWN.";
          throw new UpdatePreMutationError("restart-unavailable", outcomeMessage);
        }
      };
      const supervisor = foregroundOrigin ? null : detectedSupervisor;
      if (supervisor) {
        recordUpdateRunPhase(runId, "requested", {
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
      } else {
        if (!installRoot) {
          throw new Error("managed update install root is unavailable");
        }
        if (!supervisor && !foregroundOrigin) {
          throw new Error("The current foreground Gateway owner could not be verified.");
        }
        try {
          const beforeVersion = await readPackageVersion(installRoot);
          const foregroundEntrypoint = foregroundOrigin
            ? await resolveGatewayInstallEntrypoint(installRoot)
            : undefined;
          if (foregroundOrigin && !foregroundEntrypoint) {
            throw new Error("The foreground installation's update entrypoint is unavailable.");
          }
          const startedAt = Date.now();
          const handoffId = randomUUID();
          sentinelMeta.handoffId = handoffId;
          sentinelMeta.root = resolveUpdateInstallRoot(installRoot);
          if (foregroundOrigin) {
            sentinelMeta.completionOwner = "gateway-restart";
            sentinelMeta.foregroundOrigin = foregroundOrigin;
          }
          // Await delivery under root RPC admission before the helper can park this process.
          assertForegroundRespawnEnabled();
          if (!(await acknowledgeUpdate(beforeVersion))) {
            return;
          }
          // Recheck after the awaited acknowledgement, immediately before the effect.
          const refusal = refuseUnauthorizedChatUpdate();
          if (refusal) {
            if (ackDelivered || ackQueued) {
              await notify(refusal, "finished");
            }
            return;
          }
          assertForegroundRespawnEnabled();
          assertUpdateAdmissionCurrent();
          const started = await startManagedServiceUpdateHandoff({
            runId,
            requesterAuthority: retainedRequesterAuthority,
            beforePark: async () => {
              const assertMayPark = () => {
                const current = getUpdateRun(runId);
                if (current?.status !== "running") {
                  throw new Error("Update run disappeared before Gateway parking.");
                }
                const currentConfig = getConfig();
                retainedRequesterAuthority.assertCurrent();
                if (foregroundOrigin) {
                  if (
                    !managedHandoffOwner ||
                    !claimManagedServiceUpdateHandoff(managedHandoffOwner) ||
                    !isRestartEnabled(currentConfig)
                  ) {
                    throw new Error("Foreground update authority changed before parking.");
                  }
                  assertForegroundRespawnEnabled();
                }
                return current;
              };
              const current = assertMayPark();
              await notify(current, current.phase === "requested" ? "parking" : "activating");
              assertMayPark();
              if (foregroundOrigin) {
                scheduleGatewayRestart({
                  delayMs: 0,
                  reason: "update.run",
                  successorOwner: managedHandoffOwner,
                  audit: {
                    actor: actor.actor,
                    deviceId: actor.deviceId,
                    clientIp: actor.clientIp,
                    changedPaths: [],
                  },
                });
              }
            },
            requester,
            root: installRoot,
            timeoutMs,
            restartDrainTimeoutMs: resolveGatewayRestartDeferralTimeoutMs(),
            restartDelayMs: requestedRestartDelayMs === undefined ? 0 : restartDelayMs,
            ...(handoffChannel ? { channel: handoffChannel } : {}),
            ...(adoptedPackageTargetVersion ? { tag: adoptedPackageTargetVersion } : {}),
            ...(devTarget ? { devTarget } : {}),
            meta: sentinelMeta,
            handoffId,
            supervisor,
            ...(foregroundOrigin ? { foregroundOrigin, argv1: foregroundEntrypoint } : {}),
          });
          ownsUpdateOutcome = started.status === "started";
          sentinelMeta.handoffId = started.handoffId ?? handoffId;
          // Transfer follows sentinel persistence; validation keeps this Gateway serving.
          if (started.status === "started") {
            handoff = {
              status: "started",
              ...(started.pid ? { pid: started.pid } : {}),
              command: started.command,
            };
            managedHandoffOwner = {
              kind: "managed-update-handoff",
              handoffId: started.handoffId,
              installRoot: started.installRoot,
            };
            recordUpdateRunStep(runId, {
              step: "managed-service update handoff",
              status: "completed",
              exitCode: null,
              startedAtMs: startedAt,
              endedAtMs: Date.now(),
            });
          } else {
            // A restart sentinel has one continuation owner. Reject this RPC
            // instead of accepting metadata that the active handoff cannot persist.
            handoff = {
              status: "already-running",
              command: started.command,
              message: "Another managed update is already running; retry after it completes.",
            };
          }
          result = {
            status: "skipped",
            mode: installSurface.mode,
            root: installRoot,
            reason: ownsUpdateOutcome
              ? CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON
              : MANAGED_HANDOFF_ALREADY_RUNNING_REASON,
            ...(beforeVersion ? { before: { version: beforeVersion } } : {}),
            steps: ownsUpdateOutcome
              ? [
                  {
                    name: "managed-service update handoff",
                    command: started.command,
                    cwd: installRoot,
                    durationMs: Date.now() - startedAt,
                    exitCode: null,
                  },
                ]
              : [],
            durationMs: Date.now() - startedAt,
          };
        } catch (err) {
          context?.logGateway?.warn(
            `update.run managed-service handoff failed ${formatControlPlaneActor(actor)} error=${formatErrorMessage(err)}`,
          );
          result = recordHandoffFailure(
            runId,
            err,
            refusedUpdate("error", "managed-service-handoff-failed"),
            warn,
          );
        }
      }
    } catch (error) {
      if (error instanceof FreeBsdPkgOwnershipError) {
        outcomeMessage = error.message;
      }
      context?.logGateway?.warn(
        `update.run failed error=${error instanceof FreeBsdPkgOwnershipError ? error.message : formatErrorMessage(error)}`,
      );
      let recorded = run;
      try {
        recorded = getUpdateRun(runId) ?? run;
      } catch {
        context?.logGateway?.warn(
          "Update history could not be read; preserving the original update failure with captured admission facts.",
        );
      }
      result = createUnexpectedUpdateFailureResult(recorded, result, error, warn);
    }

    let outcomeRun = recordUpdateRunPhase(runId, "requested", {
      before: result.before,
      after: result.after,
      ...(outcomeMessage
        ? { origin: { nextAction: outcomeMessage } }
        : handoff && "message" in handoff
          ? { origin: { nextAction: handoff.message } }
          : {}),
    });
    // A managed orchestrator or the replacement Gateway owns terminal success;
    // refusals and synchronous failures have no later process to finish the run.
    if (handoff?.status !== "started") {
      outcomeRun = finishUpdateRun(runId, {
        status: result.status === "skipped" ? "skipped" : "failed",
        reason: result.reason,
        after: result.after,
      });
    }

    // Rejected requests and retired campaigns cannot replace another update's outcome.
    if (ownsUpdateOutcome && adoptedCampaignId !== undefined) {
      ownsUpdateOutcome = gatewayUpdateCampaign.getState()?.id === adoptedCampaignId;
    }
    const payload: RestartSentinelPayload = buildUpdateRestartSentinelPayload({
      result,
      meta: sentinelMeta,
    });

    let sentinelPersisted = false;
    let sentinelFailure: { error: unknown } | undefined;
    if (ownsUpdateOutcome) {
      try {
        await writeRestartSentinel(payload);
        sentinelPersisted = true;
        recordLatestUpdateRestartSentinel(payload);
      } catch (error) {
        sentinelFailure = { error };
      }
    }

    if (managedHandoffOwner) {
      try {
        if (sentinelPersisted) {
          assertUpdateAdmissionCurrent();
        }
        if (
          !sentinelPersisted ||
          !(await transferManagedServiceUpdateHandoff(managedHandoffOwner))
        ) {
          throw sentinelFailure
            ? sentinelFailure.error
            : new Error("managed update ownership transfer failed");
        }
      } catch (error) {
        try {
          // Cancellation settles the helper's ledger; persist its cause first.
          result = recordHandoffFailure(runId, error, result, warn);
        } finally {
          await cancelManagedServiceUpdateHandoff(managedHandoffOwner);
        }
        handoff = null;
        outcomeRun = finishUpdateRun(runId, { status: "failed", reason: result.reason });
        context?.logGateway?.warn(
          `update.run handoff transfer failed: ${formatErrorMessage(error)}`,
        );
      }
    }

    // Publish the outcome before the terminal campaign event prompts clients to
    // read it. Recheck ownership after persistence may have yielded to a replacement.
    if (
      ownsUpdateOutcome &&
      handoff?.status !== "started" &&
      adoptedCampaignId !== undefined &&
      gatewayUpdateCampaign.getState()?.id === adoptedCampaignId
    ) {
      gatewayUpdateCampaign.clear();
      context?.logGateway?.info("update.run failed; adopted campaign cleared", {
        campaignId: adoptedCampaignId,
      });
    }

    if ((ackDelivered || ackQueued) && handoff?.status !== "started") {
      await notify(outcomeRun, "finished");
    }
    context?.logGateway?.info(
      `update.run completed ${formatControlPlaneActor(actor)} changedPaths=<n/a> restartReason=update.run status=${result.status}`,
    );
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
