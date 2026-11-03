import type { SessionPublicShareSetResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow, SessionVisibility } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionSharingEnglish } from "../../i18n/locales/en-chat-session-sharing.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { showToast } from "../../lib/toast.ts";
import type { ChatPaneConnectionScope } from "./chat-pane-shared.ts";
import type {
  ChatSessionSharingOutcome,
  ChatSessionSharingState,
} from "./components/chat-session-sharing-shared.tsx";

registerEnglishCatalog(registerChatSessionSharingEnglish);

export async function setSessionPublicShare(
  scope: ChatPaneConnectionScope,
  currentRow: GatewaySessionRow,
  callbacks: {
    enabled: boolean;
    expectedSessionId: string;
    agentId: string | undefined;
    previous: ChatSessionSharingState | undefined;
    isCurrent(): boolean;
    access(): boolean;
    setState(state: ChatSessionSharingState): void;
    invalidateHydration(): void;
    reload(row: GatewaySessionRow): Promise<void>;
    outcome(): ChatSessionSharingOutcome;
  },
): Promise<ChatSessionSharingOutcome> {
  const { enabled, expectedSessionId, agentId, previous } = callbacks;
  if (enabled) {
    if (!callbacks.isCurrent() || !callbacks.access()) {
      return { status: "unavailable" };
    }
    const confirmed = await showConfirmDialog({
      title: t("chat.sessionSharing.publicConfirmTitle"),
      message: t("chat.sessionSharing.publicConfirmMessage"),
      confirmLabel: t("chat.sessionSharing.publicConfirmEnable"),
      danger: true,
    });
    if (!confirmed) {
      return { status: "cancelled" };
    }
  }
  // Confirmation can outlive a route, connection, or exact session instance.
  // Never publish a replacement session under the previous consent.
  if (!callbacks.isCurrent() || !callbacks.access()) {
    return { status: "unavailable" };
  }
  const result = await scope.client.request<SessionPublicShareSetResult>(
    "session.publicShare.set",
    {
      sessionKey: currentRow.key,
      agentId,
      expectedSessionId,
      enabled,
    },
  );
  if (!callbacks.isCurrent()) {
    callbacks.invalidateHydration();
    return { status: "stale" };
  }
  callbacks.setState({
    loading: false,
    ...(previous?.result
      ? { result: { ...previous.result, publicShare: result.publicShare } }
      : {}),
  });
  showToast({
    message: t(
      enabled ? "chat.sessionSharing.publicEnabled" : "chat.sessionSharing.publicDisabled",
    ),
  });
  await callbacks.reload(currentRow);
  return callbacks.isCurrent() ? callbacks.outcome() : { status: "stale" };
}

export async function mutateSessionSharing(
  scope: ChatPaneConnectionScope,
  currentRow: GatewaySessionRow,
  method: string,
  params: {
    sessionKey: string;
    agentId?: string;
    visibility?: SessionVisibility;
    identityId?: string;
  },
  callbacks: {
    agentId: string | undefined;
    visibilityChanged: boolean;
    isCurrent(): boolean;
    currentRow(): GatewaySessionRow | null;
    ownsHeader(): boolean;
    reload(row: GatewaySessionRow): Promise<void>;
    fail(error: unknown): void;
    outcome(): ChatSessionSharingOutcome;
  },
): Promise<ChatSessionSharingOutcome> {
  // The interaction's code download can outlive its original write authority.
  if (
    !callbacks.isCurrent() ||
    !readSessionMethodAccess(scope.context.gateway.snapshot, {
      method,
      requiredScope: "operator.write",
    }).allowed
  ) {
    return { status: "unavailable" };
  }
  const agentId = callbacks.agentId;
  await scope.client.request(method, params);
  if (!callbacks.isCurrent()) {
    return { status: "stale" };
  }
  const visibilityChanged = callbacks.visibilityChanged;
  if (!visibilityChanged) {
    await callbacks.reload(currentRow);
    if (!callbacks.isCurrent()) {
      return { status: "unavailable" };
    }
  }
  const outcome = await scope.sessions.reconcileMutation(agentId);
  const refreshedRow = callbacks.currentRow();
  if (!callbacks.ownsHeader() || !refreshedRow) {
    return { status: "unavailable" };
  }
  if (outcome.status === "failed") {
    callbacks.fail(outcome.error);
    return { status: "failed", error: formatUiError(outcome.error) };
  }
  if (visibilityChanged) {
    await callbacks.reload(refreshedRow);
  }
  return callbacks.isCurrent() ? callbacks.outcome() : { status: "stale" };
}
