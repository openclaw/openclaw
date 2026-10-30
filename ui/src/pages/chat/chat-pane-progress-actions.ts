import type { ProgressCard } from "@openclaw/gateway-protocol";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { showToast } from "../../lib/toast.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";

registerChatSessionEnglish();

type ProgressActionContext = {
  state: () => ChatPageHost | undefined;
  isConnected: () => boolean;
  presented: () => boolean;
  gateway: () => ApplicationGateway;
  currentCard: () => ProgressCard | null | undefined;
  clearSaved: (card: ProgressCard) => void;
  openSettings: () => void;
};

/** Captures the native session scope before exposing progress controls. */
export function captureProgressActions(context: ProgressActionContext, canWrite: boolean) {
  const state = context.state();
  if (!state) {
    return {};
  }
  const { sessionKey, currentSessionId } = state;
  const agentId = resolveChatAgentId(state);
  const gatewayUrl = state.settings.gatewayUrl;
  const scope = gatewayPresentationScope(context.gateway());
  const current = () =>
    context.isConnected() &&
    context.presented() &&
    context.state() === state &&
    state.sessionKey === sessionKey &&
    state.currentSessionId === currentSessionId &&
    resolveChatAgentId(state) === agentId &&
    gatewayPresentationScope(context.gateway()) === scope;
  return {
    onShowTaskProgressChange: (shown: boolean) => {
      if (current()) {
        state.settings = patchSettings({ chatShowTaskProgress: shown });
      }
    },
    onHideTaskProgress: () => {
      if (!current()) {
        return;
      }
      state.settings = patchSettings({ chatShowTaskProgress: false });
      showToast({
        message: t("chat.sessionDetails.progressHidden"),
        actionLabel: t("common.undo"),
        onAction: () => {
          if (
            loadSettings().gatewayUrl === gatewayUrl &&
            gatewayPresentationScope(context.gateway()) === scope
          ) {
            patchSettings({ chatShowTaskProgress: true });
          }
        },
      });
    },
    onCollapseTaskProgressChange: (collapsed: boolean) => {
      if (current()) {
        state.settings = patchSettings({ chatCollapseTaskProgress: collapsed });
      }
    },
    onOpenTaskProgressSettings: () => {
      if (current()) {
        context.openSettings();
      }
    },
    onClearSavedProgressCard: canWrite
      ? (card: ProgressCard) => {
          if (current() && context.currentCard() === card) {
            context.clearSaved(card);
          }
        }
      : undefined,
  };
}
