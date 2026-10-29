// Session-owned virtualizer lifecycle for chat transcripts.
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import {
  captureChatSessionScrollPosition,
  getChatSessionScrollPosition,
  saveChatSessionScrollPosition,
  type ChatScrollToEndOptions,
  type ChatSessionScrollPosition,
} from "../scroll.ts";
import { captureTranscriptScrollPosition } from "./chat-transcript-scroll-restore.ts";
import type { ChatTranscriptSession, TranscriptCallbacks } from "./chat-transcript-session.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";

export type ChatTranscript = ReturnType<typeof createChatTranscript>;

export function createChatTranscript(
  scrollPaneId: () => string,
  callbacks: TranscriptCallbacks = {},
) {
  let activeSessionKey: string | null = null;
  let sessionVirtualizer: ChatSessionVirtualizerHost | null = null;
  let connected = false;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get renderedSessionKey(): string | null {
      return activeSessionKey;
    },
    renderSession<T>(sessionKey: string, render: (transcript: ChatTranscriptSession) => T): T {
      if (!sessionVirtualizer || !areUiSessionKeysEquivalent(activeSessionKey, sessionKey)) {
        sessionVirtualizer?.dispose();
        // Presentation identities include the session; the cache is instead
        // bounded by physical panes, with a separate session LRU inside each pane.
        const paneId = scrollPaneId();
        const savedPosition = getChatSessionScrollPosition(paneId, sessionKey);
        const initialOffset = savedPosition?.anchorToEnd
          ? null
          : (savedPosition?.scrollTop ?? null);
        activeSessionKey = sessionKey;
        sessionVirtualizer = new ChatSessionVirtualizerHost(
          publish,
          initialOffset,
          (position) => saveChatSessionScrollPosition(paneId, sessionKey, position),
          callbacks,
          savedPosition?.anchorToEnd ? undefined : savedPosition?.anchor,
        );
        if (connected) {
          sessionVirtualizer.connect();
        }
      }
      return render(sessionVirtualizer);
    },
    captureScrollPosition(
      viewport: Parameters<typeof captureChatSessionScrollPosition>[0],
    ): ChatSessionScrollPosition {
      return sessionVirtualizer
        ? captureTranscriptScrollPosition(
            sessionVirtualizer.isPositionSettled ? sessionVirtualizer.scrollElement : null,
            viewport,
            sessionVirtualizer.messageElements.elements,
          )
        : captureChatSessionScrollPosition(viewport);
    },
    get isMaintenanceScroll(): boolean {
      return sessionVirtualizer?.isMaintenanceScroll ?? false;
    },
    get isProgrammaticScroll(): boolean {
      return sessionVirtualizer?.isProgrammaticScroll ?? false;
    },
    get isPositionSettled(): boolean {
      return sessionVirtualizer?.isPositionSettled ?? false;
    },
    scrollToEnd(options: ChatScrollToEndOptions = {}): boolean {
      return sessionVirtualizer?.scrollToEnd(options) ?? false;
    },
    scrollToOffset(
      offset: number,
      onSettled?: (position: ChatSessionScrollPosition) => void,
    ): void {
      sessionVirtualizer?.restoreScrollOffset(offset, onSettled);
    },
    revealMessage(messageId: string): boolean {
      return sessionVirtualizer?.revealMessage(messageId) ?? false;
    },
    cancelScroll(): void {
      sessionVirtualizer?.cancelScroll();
    },
    get scrollElement(): HTMLDivElement | null {
      return sessionVirtualizer?.scrollElement ?? null;
    },
    get messageElements() {
      return sessionVirtualizer?.messageElements;
    },
    syncViewportGeometry(): void {
      sessionVirtualizer?.syncViewportGeometry();
    },
    start(this: void): void {
      connected = true;
      sessionVirtualizer?.connect();
    },
    update(this: void): void {
      sessionVirtualizer?.update();
    },
    dispose(this: void): void {
      connected = false;
      // A retained pane may reconnect with its existing session and saved geometry.
      sessionVirtualizer?.disconnect();
    },
  };
}
