import { t } from "../../../i18n/index.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type {
  AttachmentSidebarRuntime,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";

export class AttachmentDownloadController {
  error: string | null = null;
  private request: AbortController | null = null;

  constructor(
    private readonly host: { readonly isConnected: boolean; requestUpdate(): void },
    private readonly content: () => ChatDetailPanelContent | null,
    private readonly runtime: () => AttachmentSidebarRuntime,
  ) {}

  get pending(): boolean {
    return this.request !== null;
  }

  cancel(): void {
    if (!this.request && this.error === null) {
      return;
    }
    this.request?.abort();
    this.request = null;
    this.error = null;
    this.host.requestUpdate();
  }

  readonly onDownload = (): void => {
    void this.run();
  };

  private async run(): Promise<void> {
    const content = this.content();
    if (content?.kind !== "attachment" || !content.download || this.request) {
      return;
    }
    const request = new AbortController();
    const { connectionEpoch, sessionKey, agentId } = this.runtime();
    this.request = request;
    this.error = null;
    this.host.requestUpdate();
    const current = () => {
      const runtime = this.runtime();
      return (
        this.host.isConnected &&
        this.content() === content &&
        this.request === request &&
        runtime.connectionEpoch === connectionEpoch &&
        runtime.sessionKey === sessionKey &&
        runtime.agentId === agentId &&
        !request.signal.aborted
      );
    };
    try {
      const blob = await content.download(request.signal);
      if (!current()) {
        return;
      }
      if (!blob) {
        throw new Error(t("chat.attachments.unavailable"));
      }
      downloadBlobFile(content.title, blob);
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.request === request) {
        this.request = null;
        this.host.requestUpdate();
      }
    }
  }
}
