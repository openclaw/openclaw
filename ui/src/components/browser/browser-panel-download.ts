import { buildAssistantMediaUrl } from "../../app/assistant-media.ts";
import {
  postNativeBrowserMessage,
  type NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { t } from "../../i18n/index.ts";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { downloadBlobFile } from "../../lib/download.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { downloadBrowserDocument, type BrowserRequestClient } from "./browser-client.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";

registerBrowserEnglish();

interface BrowserPanelDownloadHost {
  readonly host: {
    readonly isConnected: boolean;
    readonly resourceBasePath: string;
    readonly authToken: string | null;
    requestUpdate(): void;
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
export class BrowserPanelDownload {
  pending = false;
  private request: AbortController | null = null;

  constructor(private readonly panel: BrowserPanelDownloadHost) {}

  private get url(): string | null {
    const panel = this.panel;
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
    try {
      return ["http:", "https:"].includes(new URL(url).protocol) ? url : null;
    } catch {
      return null;
    }
  }

  get available(): boolean {
    return !this.pending && !this.panel.pendingNewTab && !this.panel.loading && this.url !== null;
  }

  cancel(): void {
    this.request?.abort();
    this.request = null;
    this.pending = false;
  }

  async save(): Promise<void> {
    const url = this.url;
    if (!url || !this.available) {
      return;
    }
    const panel = this.panel;
    const tabId = panel.activeTargetId;
    const nativeTab = panel.native.activeTab;
    const client = nativeTab ? null : panel.operations.captureClient();
    const request = new AbortController();
    this.request = request;
    this.pending = true;
    panel.setState("errorText", null);
    panel.setState("noticeText", null);
    panel.host.requestUpdate();
    const current = () =>
      this.request === request &&
      panel.host.isConnected &&
      panel.activeTargetId === tabId &&
      this.url === url &&
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
          void response.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP ${response.status}`);
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
      if (this.request === request) {
        this.request = null;
        this.pending = false;
        panel.host.requestUpdate();
      }
    }
  }
}
