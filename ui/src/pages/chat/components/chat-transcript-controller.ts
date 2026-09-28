// Session-owned virtualizer lifecycle for chat transcripts.
import type { ReactiveController, ReactiveControllerHost, TemplateResult } from "lit";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import {
  getChatSessionScrollPosition,
  saveChatSessionScrollPosition,
  type ChatScrollToEndOptions,
  type ChatSessionScrollPosition,
} from "../scroll.ts";
import type { ChatTranscriptSession, TranscriptCallbacks } from "./chat-transcript-session.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";

export class ChatTranscriptController implements ReactiveController {
  private activeSessionKey: string | null = null;
  private sessionVirtualizer: ChatSessionVirtualizerHost | null = null;
  private connected = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly scrollPaneId: () => string,
    private readonly callbacks: TranscriptCallbacks = {},
  ) {
    host.addController(this);
  }

  get renderedSessionKey(): string | null {
    return this.activeSessionKey;
  }

  renderSession(
    sessionKey: string,
    render: (transcript: ChatTranscriptSession) => TemplateResult,
  ): TemplateResult {
    if (
      !this.sessionVirtualizer ||
      this.activeSessionKey === null ||
      !areUiSessionKeysEquivalent(this.activeSessionKey, sessionKey)
    ) {
      this.sessionVirtualizer?.dispose();
      // Presentation identities include the session; the cache is instead
      // bounded by physical panes, with a separate session LRU inside each pane.
      const paneId = this.scrollPaneId();
      const savedPosition = getChatSessionScrollPosition(paneId, sessionKey);
      const initialOffset = savedPosition?.anchorToEnd ? null : (savedPosition?.scrollTop ?? null);
      this.activeSessionKey = sessionKey;
      this.sessionVirtualizer = new ChatSessionVirtualizerHost(
        this.host,
        initialOffset,
        (position) => saveChatSessionScrollPosition(paneId, sessionKey, position),
        this.callbacks,
      );
      if (this.connected) {
        this.sessionVirtualizer.connect();
      }
    }
    return render(this.sessionVirtualizer);
  }

  get isMaintenanceScroll(): boolean {
    return this.sessionVirtualizer?.isMaintenanceScroll ?? false;
  }

  get isProgrammaticScroll(): boolean {
    return this.sessionVirtualizer?.isProgrammaticScroll ?? false;
  }

  get isManualScroll(): boolean {
    return this.sessionVirtualizer?.isManualScroll ?? false;
  }

  scrollToEnd(options: ChatScrollToEndOptions = {}): boolean {
    return this.sessionVirtualizer?.scrollToEnd(options) ?? false;
  }

  scrollToOffset(offset: number, onSettled?: (position: ChatSessionScrollPosition) => void): void {
    this.sessionVirtualizer?.restoreScrollOffset(offset, onSettled);
  }

  revealMessage(messageId: string): boolean {
    return this.sessionVirtualizer?.revealMessage(messageId) ?? false;
  }

  cancelScroll(): void {
    this.sessionVirtualizer?.cancelScroll();
  }

  get scrollElement(): HTMLDivElement | null {
    return this.sessionVirtualizer?.scrollElement ?? null;
  }

  hostConnected(): void {
    this.connected = true;
    this.sessionVirtualizer?.connect();
  }

  hostUpdate(): void {
    this.sessionVirtualizer?.prepareUpdate();
  }

  hostUpdated(): void {
    this.sessionVirtualizer?.update();
  }

  hostDisconnected(): void {
    this.connected = false;
    this.sessionVirtualizer?.disconnect();
  }
}
