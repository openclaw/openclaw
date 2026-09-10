import { postNativeBrowserMessage } from "../../app/native-browser-bridge.ts";
import { t } from "../../i18n/index.ts";
import { downloadBlobFile } from "../../lib/download.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { labelForMediaPath } from "../../lib/media-file-extension.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";

/** Saves the displayed document; address-bar edits never select the download. */
export class BrowserPanelDownload {
  pending = false;
  private request: AbortController | null = null;

  constructor(private readonly panel: BrowserPanelController) {}

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
      this.url === url;
    try {
      if (nativeTab) {
        const reply = await postNativeBrowserMessage({ type: "download", tabId: nativeTab.id });
        if (!reply?.ok) {
          throw new Error(reply && !reply.ok ? reply.error : t("browser.tabUnavailable"));
        }
        if (current() && !reply.cancelled) {
          panel.setState("noticeText", t("browser.fileSaved"));
        }
      } else {
        // Fetching a Blob forces a download even for cross-origin inline media.
        // Cross-origin servers must permit this client; do not proxy credentials.
        const response = await fetch(url, { signal: request.signal, credentials: "same-origin" });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP ${response.status}`);
        }
        const content = await response.blob();
        if (!current()) {
          return;
        }
        downloadBlobFile(labelForMediaPath(response.url || url), content);
        panel.setState("noticeText", t("browser.downloadStarted"));
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
