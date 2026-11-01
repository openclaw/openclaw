import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { pathForRoute } from "../app-route-paths.ts";
import { registerSessionNavigationEnglish } from "../i18n/locales/en-session-navigation.ts";
import { registerSessionOrganizationSharedEnglish } from "../i18n/locales/en-session-organization-shared.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t, registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { readSessionMethodScopeAccess } from "../lib/session-method-access.ts";
import { parseCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarCatalogMenuProps,
  SidebarCatalogSessionMenuState,
} from "./app-sidebar-catalog-menu.tsx";
import type { SidebarCatalogSessionMutationScope } from "./app-sidebar-session-types.ts";
import { CatalogSessionMenu } from "./catalog-session-menu-solid.tsx";
import { showConfirmDialog } from "./confirm-dialog.ts";

registerEnglishCatalog(registerSessionNavigationEnglish);
registerEnglishCatalog(registerSessionOrganizationSharedEnglish);

export function SidebarCatalogMenu(props: SidebarCatalogMenuProps) {
  function isMutationCurrent(scope: SidebarCatalogSessionMutationScope): boolean {
    return (
      props.host.sessionData.isSessionMutationScopeCurrent(scope) &&
      scope.catalogGeneration === props.host.sessionData.sessionScopeGeneration
    );
  }

  function canImport(current = props.host): boolean {
    const snapshot = current.sessionDataContext?.gateway.snapshot;
    return (
      snapshot?.phase === "connected" &&
      readSessionMethodScopeAccess(snapshot.hello?.auth, {
        method: "sessions.catalog.import",
        requiredScope: "operator.write",
      }).allowed
    );
  }

  async function importSession(menu: SidebarCatalogSessionMenuState): Promise<void> {
    const mutation = props.host.sessionData.beginSessionMutation();
    if (!mutation) {
      return;
    }
    const scope = { ...mutation, catalogGeneration: props.host.sessionData.sessionScopeGeneration };
    const displayName = truncateUtf16Safe(menu.displayName?.trim() ?? "", 500);
    try {
      const result = await props.host.sessionData.importSessionCatalog(scope, {
        ...menu.key,
        agentId: menu.agentId,
        ...(displayName ? { displayName } : {}),
      });
      if (!result || !isMutationCurrent(scope)) {
        return;
      }
      showToast({
        message: t(
          !result.complete
            ? "chat.catalog.importIncomplete"
            : result.importedItems === 0
              ? "chat.catalog.importUnchanged"
              : "chat.catalog.importComplete",
          { count: String(result.importedItems) },
        ),
        actionLabel: t("chat.catalog.openImportedSession"),
        onAction: () => {
          if (!isMutationCurrent(scope)) {
            return;
          }
          const target = sessionNavigationTarget({
            context: scope.context,
            face: "chat",
            sessionKey: result.sessionKey,
            agentId: menu.agentId,
            exactKey: true,
          });
          props.host.onNavigate?.("chat", { ...target.options, search: "", hash: "" });
        },
      });
    } catch (error) {
      if (isMutationCurrent(scope)) {
        showToast({ message: formatUiError(error) });
      }
    }
  }

  async function deleteSession(menu: SidebarCatalogSessionMenuState): Promise<void> {
    const mutation = props.host.sessionData.beginSessionMutation();
    if (!mutation) {
      return;
    }
    const scope = { ...mutation, catalogGeneration: props.host.sessionData.sessionScopeGeneration };
    try {
      const confirmed = await showConfirmDialog({
        message: t("chat.catalog.deleteSessionConfirm"),
        details: menu.name,
        confirmLabel: t("chat.catalog.deleteSession"),
        danger: true,
        signal: scope.signal,
      });
      if (!isMutationCurrent(scope)) {
        showToast({
          message: t("sessionsView.deleteSessionStale", { session: menu.name }),
        });
        return;
      }
      if (!confirmed) {
        return;
      }
      await props.host.sessionData.archiveSessionCatalog(scope, {
        ...menu.key,
        agentId: menu.agentId,
        confirmNoOtherRunner: true,
      });
      if (!isMutationCurrent(scope)) {
        return;
      }
      const active = parseCatalogSessionKey(props.host.getRouteSessionKey());
      if (
        props.host.activeRouteId === "chat" &&
        active?.catalogId === menu.key.catalogId &&
        active.hostId === menu.key.hostId &&
        active.threadId === menu.key.threadId &&
        active.sourceHomeId === menu.key.sourceHomeId
      ) {
        props.host.onNavigate?.("chat", {
          pathname: pathForRoute("chat", props.host.basePath),
          search: "",
          hash: "",
        });
      }
    } catch (error) {
      showToast({ message: formatUiError(error) });
    }
  }

  return (
    <CatalogSessionMenu
      x={props.menu.x}
      y={props.menu.y}
      trigger={props.trigger}
      lastActive={props.menu.meta}
      canDelete={props.menu.canDelete}
      canImport={canImport(props.viewHost)}
      terminalDisabled={!props.menu.canOpenTerminal || !props.viewHost.terminalAvailable}
      onAction={(action) => {
        if (action === "import") {
          if (canImport()) {
            void importSession(props.menu);
          }
          return;
        }
        if (action === "terminal") {
          if (props.menu.canOpenTerminal && props.host.terminalAvailable) {
            openCatalogSessionInTerminal(props.host, props.menu.key, props.menu.agentId);
          }
          return;
        }
        if (action === "delete") {
          if (props.menu.canDelete) {
            void deleteSession(props.menu);
          }
          return;
        }
        props.host.onNavigate?.(props.menu.routeId, props.menu.navigation);
      }}
      onClose={props.onClose}
    />
  );
}
