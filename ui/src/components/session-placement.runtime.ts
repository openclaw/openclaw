import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import type { SessionCapability } from "../lib/sessions/session-capability.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { requestPlaceCatalog } from "../pages/new-session/cloud-target.ts";
import { projectDevicePlacements } from "../pages/new-session/device-placement.ts";
import { draftCloudProfileSupportsExecutionMode } from "../pages/new-session/discovery.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import {
  repositorySessionNeedsWorker,
  sessionPlacementAction,
  sessionPlacementActionReason,
  sessionPlacementRetry,
  sessionPlacementTargetReason,
} from "./session-placement-action.ts";
import type {
  SessionPlacementPresentation,
  SessionPlacementSource,
} from "./session-placement-move-dialog.tsx";

registerNewSessionSetupEnglish();

export async function changeSessionPlacement(params: {
  client: GatewayBrowserClient | null;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  currentGatewaySnapshot: () => ApplicationGatewaySnapshot;
  requiredProfile: () => string | undefined;
  mode: "move" | "recover";
  presentation?: SessionPlacementPresentation;
  source?: SessionPlacementSource;
  pendingKey: string | null;
  row: GatewaySessionRow;
  fallbackAgentId: string;
  isCurrent: () => boolean;
  currentRow: () => GatewaySessionRow | undefined;
  onAdmittedCommand?: (completion: Promise<void>) => void;
  onPendingChange: (key: string | null) => void;
  publishError: (error: unknown) => void;
  reconcileMutation: SessionCapability["reconcileMutation"];
}): Promise<void> {
  const client = params.client;
  const placement = params.row.placement;
  const agentId = resolveUiSessionRowAgentId(params.row, params.fallbackAgentId);
  const retry = params.mode === "move" ? sessionPlacementRetry(params.row) : undefined;
  const retryReceipt = retry ? stableStringify(retry) : undefined;
  const movingPlacement =
    params.mode === "move" && placement?.state === "active" ? placement : undefined;
  const expectedSource = retry
    ? { ...retry.expected }
    : movingPlacement
      ? {
          generation: movingPlacement.generation,
          environmentId: movingPlacement.environmentId,
          ownerEpoch: movingPlacement.activeOwnerEpoch,
        }
      : undefined;
  const restartPlacement =
    placement?.state === "failed" && placement.recoveryAction === "restart" ? placement : undefined;
  const dispatchRequired = repositorySessionNeedsWorker(params.row);
  if (
    !client ||
    params.pendingKey === params.row.key ||
    !params.isCurrent() ||
    params.row.archived === true ||
    (params.mode === "move"
      ? !sessionPlacementAction(params.row) ||
        (params.row.placementMove !== undefined && params.row.placementMove.error === undefined)
      : params.row.placementMove !== undefined || (!restartPlacement && !dispatchRequired))
  ) {
    return;
  }
  const unavailable =
    params.mode === "move"
      ? sessionPlacementActionReason(
          params.currentGatewaySnapshot(),
          params.row,
          params.requiredProfile(),
        )
      : undefined;
  if (unavailable) {
    params.publishError(unavailable);
    return;
  }
  const access = readSessionMethodAccess(params.currentGatewaySnapshot(), {
    method: expectedSource ? "sessions.move" : "sessions.dispatch",
    requiredScope: "operator.write",
  });
  const localAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.reclaim",
    requiredScope: "operator.write",
  });
  if (!access.allowed && (params.mode === "move" || !restartPlacement || !localAccess.allowed)) {
    params.publishError(access.reason);
    return;
  }
  const abandonSource = retry
    ? retry.abandonSource === true
    : movingPlacement?.runner?.kind === "device" && movingPlacement.runner.status === "offline";
  let target: SessionMoveTarget | null;
  try {
    if (abandonSource) {
      const confirmed = await showConfirmDialog({
        message: t("sessionsView.continueOnGatewayConfirm", {
          session: params.row.label || params.row.key,
        }),
        confirmLabel: t("sessionsView.continueOnGatewayAction"),
        danger: true,
      });
      target = confirmed ? (retry ? { ...retry.target } : { kind: "gateway" }) : null;
    } else if (retry) {
      target = { ...retry.target };
    } else {
      const selectedGatewaySnapshot = params.gatewaySnapshot;
      const selectionMode = movingPlacement ? "move" : restartPlacement ? "restart" : "dispatch";
      const selectedRow = params.row;
      const selectedRequiredProfile = params.requiredProfile();
      const presentation = params.presentation;
      const suppliedSource = params.source;
      const { showSessionPlacementTargetDialog } =
        await import("./session-placement-move-dialog.tsx");
      const runtime = selectedRow.agentRuntime;
      const targetPlacement = selectedRow.placement;
      const source: SessionPlacementSource | undefined =
        suppliedSource ??
        (targetPlacement?.state === "active"
          ? targetPlacement.runner?.deviceId
            ? {
                label: targetPlacement.runner.deviceId,
                target: { kind: "device", deviceId: targetPlacement.runner.deviceId },
              }
            : targetPlacement.profileId
              ? {
                  label: targetPlacement.profileId,
                  providerId: targetPlacement.providerId,
                  target: {
                    kind: "profile",
                    profileId: targetPlacement.profileId,
                    ...(targetPlacement.machine?.class
                      ? { machineClass: targetPlacement.machine.class }
                      : {}),
                    ...(targetPlacement.machine?.os ? { os: targetPlacement.machine.os } : {}),
                  },
                }
              : { label: targetPlacement.environmentId }
          : targetPlacement?.state === "local"
            ? { label: t("newSession.gateway"), target: { kind: "gateway" } }
            : undefined);
      const gatewayAccess = readSessionMethodAccess(selectedGatewaySnapshot, {
        method: selectionMode === "restart" ? "sessions.reclaim" : "sessions.move",
        requiredScope: "operator.write",
      });
      const workerAccess = readSessionMethodAccess(selectedGatewaySnapshot, {
        method: selectionMode === "move" ? "sessions.move" : "sessions.dispatch",
        requiredScope: "operator.write",
      });
      target = await showSessionPlacementTargetDialog({
        mode: selectionMode,
        presentation,
        source,
        sessionLabel: selectedRow.label || selectedRow.key,
        activeRun: selectedRow.hasActiveRun === true,
        repositoryOnly: repositorySessionNeedsWorker(selectedRow),
        allowMachineOverrides: !selectedRequiredProfile,
        gatewayDisabledReason: selectedRequiredProfile
          ? t("sessionsView.moveSessionRequiredProfile")
          : gatewayAccess.allowed
            ? undefined
            : gatewayAccess.reason,
        deviceDisabledReason: selectedRequiredProfile
          ? t("sessionsView.moveSessionRequiredProfile")
          : !workerAccess.allowed
            ? workerAccess.reason
            : runtime && !runtime.devicePlacement
              ? t("newSession.deviceRuntimeUnsupported")
              : undefined,
        profileDisabledReason: (profile) => {
          if (selectedRequiredProfile && profile.id !== selectedRequiredProfile) {
            return t("sessionsView.moveSessionRequiredProfile");
          }
          if (!workerAccess.allowed) {
            return workerAccess.reason;
          }
          if (runtime?.cloudPlacementSupported === false) {
            return t("newSession.cloudRuntimeUnsupported", { runtime: runtime.id });
          }
          return runtime?.cloudPlacementExecutionMode &&
            !draftCloudProfileSupportsExecutionMode(profile, runtime.cloudPlacementExecutionMode)
            ? t("newSession.cloudProfileRuntimeUnsupported", { runtime: runtime.id })
            : undefined;
        },
        loadCatalog: async () => {
          const catalog = await requestPlaceCatalog(client, runtime?.id);
          return {
            profiles: hasOperatorAdminAccess(selectedGatewaySnapshot.hello?.auth ?? null)
              ? catalog.profiles
              : [],
            devices: projectDevicePlacements(catalog.environments, runtime?.devicePlacement),
          };
        },
      });
    }
  } catch (error) {
    if (params.isCurrent()) {
      params.publishError(error);
    }
    return;
  }
  if (!target) {
    return;
  }
  if (!params.isCurrent()) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  const currentRow = params.currentRow();
  const currentPlacement = currentRow?.placement;
  const stillSameSource = retry
    ? stableStringify(sessionPlacementRetry(currentRow)) === retryReceipt
    : expectedSource
      ? currentPlacement?.state === "active" &&
        currentPlacement.generation === expectedSource.generation &&
        currentPlacement.environmentId === expectedSource.environmentId &&
        currentPlacement.activeOwnerEpoch === expectedSource.ownerEpoch &&
        (currentPlacement.runner?.status === "offline") === abandonSource
      : restartPlacement
        ? currentPlacement?.state === "failed" &&
          currentPlacement.recoveryAction === "restart" &&
          currentPlacement.generation === restartPlacement.generation
        : currentRow && sessionPlacementAction(currentRow) === "dispatch";
  const snapshot = params.currentGatewaySnapshot();
  if (
    snapshot.client !== client ||
    !currentRow ||
    currentRow.key !== params.row.key ||
    currentRow.sessionId !== params.row.sessionId ||
    resolveUiSessionRowAgentId(currentRow, params.fallbackAgentId) !== agentId ||
    currentRow.repositoryWorkspaceId !== params.row.repositoryWorkspaceId ||
    currentRow.worktree?.id !== params.row.worktree?.id ||
    currentRow.archived === true ||
    currentRow.agentRuntime?.id !== params.row.agentRuntime?.id ||
    currentRow.agentRuntime?.cloudPlacementExecutionMode !==
      params.row.agentRuntime?.cloudPlacementExecutionMode ||
    currentRow.agentRuntime?.cloudPlacementSupported !==
      params.row.agentRuntime?.cloudPlacementSupported ||
    Boolean(currentRow.agentRuntime?.devicePlacement) !==
      Boolean(params.row.agentRuntime?.devicePlacement) ||
    !stillSameSource ||
    (currentRow.placementMove &&
      (params.mode === "recover" || currentRow.placementMove.error === undefined))
  ) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  const method = expectedSource
    ? "sessions.move"
    : target.kind === "gateway"
      ? "sessions.reclaim"
      : "sessions.dispatch";
  const targetParams = expectedSource
    ? { target }
    : target.kind === "profile"
      ? { profileId: target.profileId }
      : {};
  const currentAccess = readSessionMethodAccess(snapshot, {
    method,
    params: targetParams,
    requiredScope: target.kind === "profile" ? "operator.admin" : "operator.write",
  });
  const requiredProfile = params.requiredProfile();
  const unavailableNow =
    params.mode === "move"
      ? sessionPlacementActionReason(snapshot, currentRow, requiredProfile)
      : undefined;
  const targetReason = sessionPlacementTargetReason(requiredProfile, target);
  if (!currentAccess.allowed || unavailableNow || targetReason) {
    params.publishError(
      !currentAccess.allowed ? currentAccess.reason : (unavailableNow ?? targetReason),
    );
    return;
  }
  const session = { key: params.row.key, ...(agentId ? { agentId } : {}) };
  const completion = (async () => {
    params.onPendingChange(params.row.key);
    try {
      if (expectedSource) {
        await client.request("sessions.move", {
          ...session,
          expected: expectedSource,
          target,
          ...(abandonSource ? { abandonSource: true } : {}),
        });
      } else if (target.kind === "gateway") {
        if (!restartPlacement) {
          params.publishError(t("sessionsView.actionUnavailable"));
          return;
        }
        await client.request(
          "sessions.reclaim",
          { ...session, recoverToGateway: { expectedGeneration: restartPlacement.generation } },
          { timeoutMs: null },
        );
      } else {
        await client.request("sessions.dispatch", {
          ...session,
          ...(target.kind === "profile"
            ? {
                profileId: target.profileId,
                ...(target.os ? { os: target.os } : {}),
                ...(target.machineClass ? { machineClass: target.machineClass } : {}),
              }
            : { deviceId: target.deviceId }),
        });
      }
      if (params.isCurrent()) {
        const outcome = await params.reconcileMutation(agentId);
        if (outcome.status === "failed" && params.isCurrent()) {
          params.publishError(outcome.error);
        }
      }
    } catch (error) {
      if (params.isCurrent()) {
        await params.reconcileMutation(agentId).catch(() => undefined);
        if (params.isCurrent()) {
          params.publishError(error);
        }
      }
    } finally {
      params.onPendingChange(null);
    }
  })();
  params.onAdmittedCommand?.(completion);
  await completion;
}
