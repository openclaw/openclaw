import type { GatewaySessionRow } from "../../api/types.ts";
import { normalizeBasePath } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationSharedEnglish } from "../../i18n/locales/en-session-organization-shared.ts";
import { copyToClipboard } from "../clipboard.ts";
import { formatUiError } from "../format-error.ts";
import { reserveExternalWindowForDeferredNavigation } from "../open-external-url.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
import { showToast } from "../toast.ts";
import { resolveSessionPreferredFaceForKey, sessionNavigationTarget } from "./route-navigation.ts";

registerSessionOrganizationSharedEnglish();

export type SessionNavigationTarget<TRouteId extends string> = {
  context: ApplicationContext<TRouteId>;
  session: Pick<GatewaySessionRow, "key" | "sessionId">;
  agentId?: string;
  sourceSessionKey?: string;
  isCurrent: () => boolean;
};

const sessionSplitHosts = new Map<HTMLElement, () => boolean>();

/** Chat publishes its mounted capability without exposing its DOM to menu callers. */
export function registerSessionSplitHost(host: HTMLElement, available: () => boolean) {
  sessionSplitHosts.set(host, available);
  return () => {
    sessionSplitHosts.delete(host);
  };
}

export function canSplitSessionView(): boolean {
  return [...sessionSplitHosts].some(([host, available]) => host.isConnected && available());
}

export function canCopySessionMarkdown(snapshot: ApplicationGatewaySnapshot | undefined): boolean {
  return readSessionMethodAccess(snapshot, {
    method: "chat.history",
    requiredScope: "operator.read",
    sessionScope: true,
  }).allowed;
}

export async function runSessionNavigationAction<TRouteId extends string>(
  kind:
    | "copy-session-id"
    | "copy-session-link"
    | "copy-session-preview-link"
    | "copy-markdown"
    | "open-new-tab"
    | "open-new-window"
    | "split-right"
    | "split-below",
  params: SessionNavigationTarget<TRouteId>,
): Promise<void> {
  try {
    if (kind === "split-right" || kind === "split-below") {
      const handled =
        canSplitSessionView() &&
        !window.dispatchEvent(
          new CustomEvent(UI_COMMAND_EVENT, {
            detail: {
              agentId: params.agentId,
              command: {
                kind: "split",
                direction: kind === "split-right" ? "right" : "down",
                sessionKey: params.session.key,
              },
              ...(params.sourceSessionKey ? { sessionKey: params.sourceSessionKey } : {}),
            },
            cancelable: true,
          }),
        );
      if (!handled) {
        showToast({ message: t("sessionsView.splitUnavailable") });
      }
      return;
    }
    if (kind === "copy-markdown" || kind === "copy-session-id") {
      let copied: boolean;
      if (kind === "copy-markdown") {
        const gateway = params.context.gateway;
        const { client, hello } = gateway.snapshot;
        const isCurrent = params.isCurrent;
        const target = {
          ...params,
          isCurrent: () =>
            isCurrent() &&
            params.context.gateway === gateway &&
            gateway.snapshot.client === client &&
            gateway.snapshot.hello === hello,
        };
        const { copySessionMarkdown } = await import("./session-menu-markdown.runtime.ts");
        copied = await copySessionMarkdown(target);
      } else {
        copied = await copyToClipboard(params.session.sessionId ?? "");
      }
      showToast({ message: t(copied ? "common.copied" : "common.copyFailed") });
      return;
    }
    const face = resolveSessionPreferredFaceForKey(
      params.context,
      params.session.key,
      params.agentId,
    );
    const gateway = params.context.gateway;
    const copyLink = kind === "copy-session-link" || kind === "copy-session-preview-link";
    // Shared links belong to the Gateway; the UI document may be a local SSH
    // tunnel or a dev server with a different mount path. New windows stay local.
    const linkBase = copyLink
      ? (gateway.snapshot.hello?.controlUiUrl ??
        gateway.snapshot.client?.gatewayUrl ??
        gateway.connection.gatewayUrl)
      : undefined;
    const url = new URL(linkBase || window.location.href);
    url.protocol = url.protocol.replace(/^ws/u, "http");
    const basePath = linkBase ? url.pathname : params.context.basePath;
    const navigation = sessionNavigationTarget({
      context: params.context,
      basePath:
        kind === "copy-session-preview-link" ? `${normalizeBasePath(basePath)}/share` : basePath,
      face,
      sessionKey: params.session.key,
      agentId: params.agentId,
      exactKey: true,
    });
    const href = new URL(navigation.href, url.origin).href;
    if (copyLink) {
      const copied = await copyToClipboard(href);
      showToast({ message: t(copied ? "common.copied" : "common.copyFailed") });
      return;
    }
    // Reserve an inert page so popup blocking remains observable, and detach
    // its opener before loading the same-origin session route.
    const opened = reserveExternalWindowForDeferredNavigation({
      popup: kind === "open-new-window",
    });
    if (opened) {
      opened.location.replace(href);
    } else {
      showToast({ message: t("sessionsView.openWindowBlocked") });
    }
  } catch (error) {
    showToast({ message: formatUiError(error) });
  }
}
