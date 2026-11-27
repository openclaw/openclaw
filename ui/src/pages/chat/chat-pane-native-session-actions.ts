import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { i18n, t } from "../../i18n/index.ts";
import { registerChatMoveToProjectEnglish } from "../../i18n/locales/en-chat-move-to-project.ts";
import { registerSessionOrganizationSharedEnglish } from "../../i18n/locales/en-session-organization-shared.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectsForGateway, type ProjectCatalog } from "../../lib/projects.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { createSharedOwnerProjection } from "../../lib/reactive/shared-owner-projection.ts";
import { pluginSessionMenuActions } from "../../plugins/control-ui-actions.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import type { HeaderMenuAction } from "./chat-pane-session-menu-contract.ts";
import type { HeaderMenuSessionAction } from "./components/chat-quick-action.tsx";

registerSessionOrganizationSharedEnglish();
registerEnglishCatalog(registerChatMoveToProjectEnglish);

const hasMoveProjects = createSharedOwnerProjection(
  (catalog: ProjectCatalog) =>
    catalog.snapshot.result?.projects.some((project) => project.source !== "workspace") ?? false,
);

export class ChatPaneNativeSessionActions {
  private readonly memo = new ChatPaneHeaderMemo<HeaderMenuSessionAction[]>();

  read(
    context: ApplicationContext,
    row: GatewaySessionRow | undefined,
    stopDisabledReason: string | undefined,
    onAction: (action: HeaderMenuAction) => void,
  ): HeaderMenuSessionAction[] {
    const enabled = context.nativeConversation?.supportsSessionActions;
    const pluginActions = enabled && row ? pluginSessionMenuActions(context.plugins, row) : [];
    const stopAction = resolveCloudWorkerStopAction(row?.placement);
    const canStop = Boolean(
      enabled &&
      stopAction &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "sessions.reclaim"),
    );
    const canMoveToProject = Boolean(
      row &&
      (!row.projectId || row.projectId === `workspace:${row.key.split(":")[1]}`) &&
      !row.worktree &&
      !row.deviceFolder &&
      !row.execNode &&
      !row.repositoryWorkspaceId &&
      canCallGatewayMethod(
        context.gateway.snapshot,
        "projects.moveSession",
        "operator.sessions.write",
      ) &&
      hasMoveProjects(projectsForGateway(context.gateway)).read(),
    );
    return this.memo.read(
      [
        canMoveToProject,
        ...pluginActions.flatMap(({ id, label, disabled }) => [id, label, disabled]),
        canStop,
        row?.key,
        stopAction?.copyKey,
        context,
        stopDisabledReason,
        i18n.getLocale(),
        onAction,
      ],
      () => [
        ...(canMoveToProject
          ? [
              {
                id: "move-to-project",
                label: t("chat.sessionHeader.moveToProject.action"),
                icon: "folder" as const,
                onActivate: () => onAction({ kind: "move-to-project" }),
              },
            ]
          : []),
        ...pluginActions.map((action): HeaderMenuSessionAction => ({
          label: action.label,
          disabled: action.disabled,
          id: `plugin/${action.id}`,
          icon: "plug",
          onActivate: () => onAction({ kind: "plugin", id: action.id }),
        })),
        ...(canStop && stopAction
          ? [
              {
                id: "stop-cloud-worker",
                label: t(stopAction.copyKey),
                icon: "stop" as const,
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
