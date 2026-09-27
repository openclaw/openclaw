import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import type { SessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import { deleteSessionPlacementDraft } from "../../lib/sessions/session-placement-startup.ts";
import { restoreChatApiAttachments } from "../chat/attachment-restoration.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";

registerNewSessionSetupEnglish();

export type PendingPlacementPlace = {
  agentId: string;
  profileId: string;
  deviceId?: string;
  autoDevice?: boolean;
  os?: string;
  machineClass?: string;
  cwd?: string;
  repository?: SessionCreateParams["repository"];
  worktreeSource?: SessionCreateParams["worktreeSource"];
};

export function resolveDraftSessionPlacement(
  pending: Pick<PendingSessionPlacementRecoveryState, "sessionKey" | "target">,
  place: {
    autoDevice: boolean;
    cloudProfileId: string;
    deviceId: string;
    cloudSelection: Readonly<{ os: string; machineClass: string }>;
  },
) {
  const { os, machineClass } = place.cloudSelection;
  const target = pending.sessionKey
    ? pending.target
    : place.cloudProfileId
      ? {
          kind: "profile" as const,
          profileId: place.cloudProfileId,
          ...(os ? { os } : {}),
          ...(machineClass ? { machineClass } : {}),
        }
      : place.deviceId
        ? { kind: "device" as const, deviceId: place.deviceId }
        : place.autoDevice
          ? { kind: "auto-device" as const }
          : null;
  return { target };
}

export function projectDraftSessionPlacementRecovery(recovery: SessionPlacementRecovery) {
  const visibility: NewSessionVisibility = recovery.createParams?.incognito
    ? "incognito"
    : recovery.createParams?.visibility === "draft"
      ? "draft"
      : "normal";
  const placement: PendingPlacementPlace = {
    agentId: recovery.agentId,
    profileId: recovery.target.kind === "profile" ? recovery.target.profileId : "",
    ...(recovery.target.kind === "profile"
      ? { os: recovery.target.os, machineClass: recovery.target.machineClass }
      : recovery.target.kind === "device"
        ? { deviceId: recovery.target.deviceId }
        : { autoDevice: true }),
    cwd: recovery.createParams?.cwd,
    ...(recovery.createParams?.worktreeSource
      ? { worktreeSource: recovery.createParams.worktreeSource }
      : {}),
    ...(recovery.createParams?.repository
      ? { repository: { ...recovery.createParams.repository } }
      : {}),
  };
  return {
    placement,
    draft: {
      message: recovery.message,
      ...(recovery.mentions?.length ? { mentions: recovery.mentions } : {}),
      attachments: restoreChatApiAttachments(recovery.attachments),
      visibility,
      toolOverrides: recovery.createParams?.toolOverrides ?? null,
      permissionMode: recovery.createParams?.permissionMode,
    },
  };
}

/** Transfer startup custody before retiring the source draft or navigating. */
export async function completeDraftSessionPlacement(params: {
  context: ApplicationContext;
  client: GatewayBrowserClient;
  agentId: string;
  pending: PendingSessionPlacementRecoveryState;
  submittedRecovery: SessionPlacementRecovery;
  sessionKey: string;
  createdAt: number;
  isRequestCurrent: () => boolean;
  isLifecycleCurrent: () => boolean;
  clearRecovery: () => void;
  setError: (error: string) => void;
  onRecoveryUnavailable: () => void;
  clearDraft: () => Promise<void>;
  consumeWorktreeName?: () => void | Promise<void>;
  completeInBackground: (sessionKey: string, runId: string) => boolean;
  onAccepted: () => void;
  navigate: () => Promise<void>;
}) {
  const { pending, submittedRecovery, sessionKey } = params;
  const { gatewayUrl, recoveryScope } = submittedRecovery;
  const ownsRecovery = (key: string) => pending.owns(gatewayUrl, recoveryScope, key);
  const ownsSubmissionRecovery = () => ownsRecovery(submittedRecovery.sessionKey);
  if (
    submittedRecovery.phase === "creating" &&
    (!params.isLifecycleCurrent() || !ownsSubmissionRecovery())
  ) {
    // A remounted surface can claim the same idempotent creating record.
    // Its live retry, not this departed submitter, now owns settlement.
    if (pending.hasOtherLiveOwner(gatewayUrl, recoveryScope, submittedRecovery.sessionKey)) {
      return;
    }
    const cleanupError = await deleteSessionPlacementDraft(
      params.client,
      sessionKey,
      params.agentId,
    );
    if (cleanupError) {
      if (ownsSubmissionRecovery()) {
        pending.promoteToDispatching(sessionKey);
        pending.retryAllowed = true;
      }
      params.setError(t("newSession.placementStartFailed", { error: cleanupError }));
    } else if (ownsSubmissionRecovery()) {
      params.clearRecovery();
    }
    return;
  }
  if (
    submittedRecovery.phase === "creating" &&
    params.isLifecycleCurrent() &&
    ownsSubmissionRecovery() &&
    !pending.promoteToDispatching(sessionKey)
  ) {
    params.onRecoveryUnavailable();
    return;
  }
  const recovery = pending.capture();
  if (!recovery || recovery.phase === "creating") {
    params.onRecoveryUnavailable();
    return;
  }
  if (!params.isRequestCurrent()) {
    return;
  }
  params.context.placementStartup.start({
    recovery,
    persistRecovery: pending.persistent,
    mode: submittedRecovery.phase === "creating" ? "dispatch" : "recover",
    createdAt: params.createdAt,
  });
  await params.consumeWorktreeName?.();
  const ownsStartedPlacement = () =>
    params.isLifecycleCurrent() && ownsRecovery(recovery.sessionKey);
  if (!ownsStartedPlacement()) {
    return;
  }
  await params.clearDraft();
  if (!ownsStartedPlacement()) {
    return;
  }
  pending.reset();
  if (params.completeInBackground(recovery.sessionKey, recovery.messageId)) {
    params.onAccepted();
    return;
  }
  await params.navigate();
}
