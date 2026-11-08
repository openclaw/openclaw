import { buildAssistantMediaUrl } from "../../app/assistant-media.ts";
import { readControlUiJsonResponse } from "../../app/control-ui-auth.ts";
import {
  postNativeBrowserMessage,
  type NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { t } from "../../i18n/index.ts";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { downloadBlobFile } from "../../lib/download.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  downloadBrowserDocument,
  type BrowserDashboardTarget,
  type BrowserRequestClient,
} from "./browser-client.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";

registerBrowserEnglish();

interface BrowserPanelDownloadHost {
  readonly host: {
    readonly isConnected: boolean;
    readonly resourceBasePath: string;
    readonly authToken: string | null;
    readonly dashboardTarget?: BrowserDashboardTarget;
  };
  readonly operations: { captureClient(): BrowserRequestClient | null };
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly activeTargetId: string | null;
  readonly view: BrowserPanelView | null;
  readonly unavailableTabText: string | null;
  readonly pendingNewTab: boolean;
  readonly loading: boolean;
  setState(key: "errorText" | "noticeText", value: string | null): void;
}

/** Saves the displayed document; address-bar edits never select the download. */
export function createBrowserPanelDownload(panel: BrowserPanelDownloadHost, notify: () => void) {
  let pendingRequest: AbortController | null = null;
  function currentUrl(): string | null {
    if (panel.unavailableTabText) {
      return null;
    }
    const url =
      panel.native.activeTab?.url ||
      (panel.view?.targetId === panel.activeTargetId
        ? panel.view?.metrics?.url || panel.view?.url
        : null);
    if (!url) {
      return null;
    }
    const protocol = URL.parse(url)?.protocol;
    return protocol === "http:" || protocol === "https:" ? url : null;
  }
  const download = {
    get pending(): boolean {
      return pendingRequest !== null;
    },

    get available(): boolean {
      return (
        !panel.host.dashboardTarget?.sessionScoped &&
        !download.pending &&
        !panel.pendingNewTab &&
        !panel.loading &&
        currentUrl() !== null
      );
    },

    cancel(): void {
      pendingRequest?.abort();
      pendingRequest = null;
    },

    async save(): Promise<void> {
      const url = currentUrl();
      if (!url || !download.available) {
        return;
      }
      const tabId = panel.activeTargetId;
      const nativeTab = panel.native.activeTab;
      const client = nativeTab ? null : panel.operations.captureClient();
      const request = new AbortController();
      pendingRequest = request;
      panel.setState("errorText", null);
      panel.setState("noticeText", null);
      notify();
      const current = () =>
        pendingRequest === request &&
        panel.host.isConnected &&
        panel.activeTargetId === tabId &&
        currentUrl() === url &&
        (nativeTab !== undefined || panel.operations.captureClient() === client);
      try {
        if (nativeTab) {
          const reply = await postNativeBrowserMessage({ type: "download", tabId: nativeTab.id });
          if (!reply?.ok) {
            throw new Error(reply && !reply.ok ? reply.error : t("browser.tabUnavailable"));
          }
        } else {
          if (!client || !tabId) {
            throw new Error(t("browser.tabUnavailable"));
          }
          const file = await downloadBrowserDocument(client, tabId, url, request.signal);
          if (!current()) {
            return;
          }
          // External asset fetches violate the dashboard CSP. The Browser owns the
          // transfer; reuse the authenticated same-origin media boundary for delivery.
          const headers = new Headers();
          if (panel.host.authToken) {
            headers.set("Authorization", `Bearer ${panel.host.authToken}`);
          }
          const response = await fetch(
            buildAssistantMediaUrl(file.path, panel.host.resourceBasePath),
            {
              headers,
              signal: request.signal,
              credentials: "same-origin",
            },
          );
          if (!response.ok) {
            const { errorMessage } = await readControlUiJsonResponse(response, request.signal);
            throw new Error(errorMessage);
          }
          const content = await response.blob();
          if (!current()) {
            return;
          }
          downloadBlobFile(file.filename, content);
        }
      } catch (error) {
        if (current() && !request.signal.aborted) {
          panel.setState(
            "errorText",
            t("browser.errors.downloadFailed", { error: formatUiError(error) }),
          );
        }
      } finally {
        if (pendingRequest === request) {
          pendingRequest = null;
          notify();
        }
      }
    },
  };
  return download;
}

export type BrowserPanelDownload = ReturnType<typeof createBrowserPanelDownload>;
