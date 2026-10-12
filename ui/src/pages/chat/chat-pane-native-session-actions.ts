import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { icons } from "../../components/icons.ts";
import { i18n, t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { pluginSessionMenuActions } from "../../plugins/control-ui-actions.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import type {
  HeaderMenuAction,
  HeaderMenuQuickAction,
} from "./components/chat-header-session-menu.ts";

export class ChatPaneNativeSessionActions {
  private readonly memo = new ChatPaneHeaderMemo<HeaderMenuQuickAction[]>();

  read(
    context: ApplicationContext,
    row: GatewaySessionRow | undefined,
    stopDisabledReason: string | undefined,
    onAction: (action: HeaderMenuAction) => void,
  ): HeaderMenuQuickAction[] {
    const enabled = context.nativeConversation?.supportsSessionActions;
    const pluginActions = enabled && row ? pluginSessionMenuActions(context.plugins, row) : [];
    const canStop = Boolean(
      enabled &&
      resolveCloudWorkerStopAction(row?.placement) &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "sessions.reclaim"),
    );
    return this.memo.read(
      [
        ...pluginActions.flatMap(({ id, label, disabled }) => [id, label, disabled]),
        canStop,
        stopDisabledReason,
        i18n.getLocale(),
        onAction,
      ],
      () => [
        ...pluginActions.map((action) => ({
          label: action.label,
          disabled: action.disabled,
          id: `plugin/${action.id}`,
          icon: icons.plug,
          onActivate: () => onAction({ kind: "plugin", id: action.id }),
        })),
        ...(canStop
          ? [
              {
                id: "stop-cloud-worker",
                label: t("sessionsView.stopCloudWorker"),
                icon: icons.stop,
                variant: "danger" as const,
                disabled: Boolean(stopDisabledReason),
                description: stopDisabledReason,
                onActivate: () => onAction({ kind: "stop-cloud-worker" }),
              },
            ]
          : []),
      ],
    );
  }
}
