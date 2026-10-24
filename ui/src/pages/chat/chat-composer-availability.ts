import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { hasSessionPresenceViewers } from "../../lib/presence-users.ts";
import { readSessionMethodScopeAccess } from "../../lib/session-method-access.ts";
import type { resolvePlacementComposer } from "./chat-pane-placement.ts";
import type { ChatComposerDisabledBanner } from "./components/chat-composer-types.ts";

registerChatSessionEnglish();

/** Presentation policy only; send admission remains with the session owner. */
export function resolveChatComposerAvailability(params: {
  gatewaySnapshot: Pick<ApplicationGatewaySnapshot, "hello" | "selfUser" | "client">;
  presence: unknown;
  sessionKey: string;
  connected: boolean;
  session: GatewaySessionRow | undefined;
  catalog: boolean;
  catalogCanContinue: boolean;
  catalogDisabledReason: string | null;
  archived: boolean;
  participationBlocked: boolean;
  multipleIdentities: boolean;
  placement: Pick<
    ReturnType<typeof resolvePlacementComposer>,
    "blocksSend" | "busyMessage" | "state" | "failedUnavailableMessage" | "disabledBanner"
  >;
  sessionDisabledBanner: ChatComposerDisabledBanner | undefined;
  modelUnavailableBanner: ChatComposerDisabledBanner | undefined;
  requiredReason: string | undefined;
  pendingReason: string | null;
}) {
  const { session, placement, gatewaySnapshot } = params;
  const auth = gatewaySnapshot.hello?.auth ?? null;
  const hasWriteScope = hasOperatorWriteAccess(auth);
  const composerAccess =
    hasWriteScope ||
    (!params.catalog &&
      readSessionMethodScopeAccess(auth, {
        method: "chat.send",
        requiredScope: "operator.write",
        sessionScope: true,
        session,
      }).allowed);
  const suggestionViewer =
    params.multipleIdentities &&
    !params.archived &&
    hasWriteScope &&
    session?.visibility === "suggest" &&
    session.sharingRole === "viewer" &&
    isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.add") === true &&
    isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.list") === true;
  const nativeConversation = !params.catalog && !suggestionViewer;
  // Placement progress explains its gate; other gates need a reason or a banner.
  const disabledReason = nativeConversation
    ? (session?.sendDisabledReason ??
      (params.participationBlocked ? t("chat.sessionSharing.readOnlyNotice") : null))
    : null;
  const available =
    !session?.providerReview &&
    params.sessionDisabledBanner?.kind !== "composer-replacement" &&
    (params.catalog
      ? params.catalogCanContinue
      : !disabledReason &&
        !(
          params.archived ||
          session?.restartRecoveryStatus === "tombstoned" ||
          placement.blocksSend
        ));
  return {
    nativeConversation,
    suggestionViewer,
    canWriteProgressCard: params.connected && !params.participationBlocked && hasWriteScope,
    typingEnabled:
      params.multipleIdentities &&
      hasWriteScope &&
      !params.catalog &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.typing") === true &&
      hasSessionPresenceViewers(
        params.presence,
        gatewaySnapshot.selfUser,
        gatewaySnapshot.client?.instanceId,
        params.sessionKey,
      ),
    composerAvailability: {
      canCompose: composerAccess && available,
      canSend: composerAccess && available,
      modelRequiredReason: params.catalog || suggestionViewer ? undefined : params.requiredReason,
      disabledReason:
        params.catalogDisabledReason ??
        (!composerAccess ? t("chat.sessionSharing.scopeReadOnlyNotice") : null) ??
        disabledReason ??
        placement.busyMessage ??
        (placement.state.kind === "failed" && !placement.state.recoveryAction
          ? placement.failedUnavailableMessage
          : null) ??
        // Offline sending stays available for the outbox; this band explains pending recovery.
        params.pendingReason,
      disabledReasonTone:
        !composerAccess ||
        disabledReason ||
        placement.busyMessage ||
        (params.participationBlocked && !suggestionViewer)
          ? ("info" as const)
          : ("danger" as const),
      disabledReasonBusy: placement.busyMessage !== null,
      disabledBanner:
        params.sessionDisabledBanner ?? placement.disabledBanner ?? params.modelUnavailableBanner,
    },
  };
}
