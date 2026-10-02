import type { BoardFace } from "../../lib/board/settings.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { SessionChatRouteData } from "./route-loader.ts";

const HANDOFF_TTL_MS = 30_000;
const MAINTENANCE_MS = 15_000;
const RETRY_MS = 250;
const COMPOSER_SELECTOR = ".agent-chat__composer-combobox textarea";

type PendingHandoff = {
  expiresAt: number;
  sessionKey: string;
  sourceData: SessionChatRouteData;
};

export type ChatPaneElement = HTMLElement & {
  active?: boolean;
  conversationPresented?: boolean;
  discardStagedAttachments?: () => void;
  paneId?: string;
  prepareForEviction?: () => void;
  hasQueuedMessageEdit?: boolean;
  presented?: boolean;
  captureNavigationFace?: () => BoardFace | undefined;
  routeFace?: BoardFace;
  sessionKey?: string;
  transcriptLoading?: boolean;
  transcriptReady?: boolean;
  updateComplete?: Promise<unknown>;
  visuallyPresented?: boolean;
};

let pendingHandoff: PendingHandoff | undefined;

function pendingMatches(sessionKey: string, data: SessionChatRouteData): boolean {
  if (!pendingHandoff) {
    return false;
  }
  if (pendingHandoff.expiresAt <= Date.now()) {
    pendingHandoff = undefined;
    return false;
  }
  return (
    pendingHandoff.sourceData !== data &&
    areUiSessionKeysEquivalent(pendingHandoff.sessionKey, sessionKey)
  );
}

export class RouteDraftComposerFocus {
  private timer: number | undefined;
  private pendingDraft:
    | {
        pane: HTMLElement;
        completion: Promise<unknown>;
        href: string;
        accept: () => void;
      }
    | undefined;
  private readonly observedDraftUpdates = new WeakSet<Promise<unknown>>();

  constructor(private readonly host: HTMLElement) {}

  clearPendingDraft(): void {
    this.pendingDraft = undefined;
  }

  afterPaneUpdate(
    pane: HTMLElement & { readonly updateComplete: Promise<unknown> },
    accept: () => void,
  ): void {
    const completion = pane.updateComplete;
    this.pendingDraft = { pane, completion, href: window.location.href, accept };
    if (this.observedDraftUpdates.has(completion)) {
      return;
    }
    // A hidden or frame-paced pane can retain this update across many parent
    // renders. Observe it once and retain only the latest route's acknowledgement.
    this.observedDraftUpdates.add(completion);
    void completion.then(
      () => {
        this.observedDraftUpdates.delete(completion);
        const pending = this.pendingDraft;
        if (pending?.completion !== completion) {
          return;
        }
        this.pendingDraft = undefined;
        if (pending.pane.isConnected && window.location.href === pending.href) {
          pending.accept();
        }
      },
      (error: unknown) => {
        this.observedDraftUpdates.delete(completion);
        if (this.pendingDraft?.completion === completion) {
          this.pendingDraft = undefined;
          console.error("[openclaw] Route draft recipient update failed", error);
        }
      },
    );
  }

  rendered(
    data: SessionChatRouteData | undefined,
    activeSessionKey: string | null | undefined,
    consumedData: SessionChatRouteData | null,
  ): boolean {
    const matchesActivePane = Boolean(
      data &&
      (activeSessionKey === undefined ||
        (activeSessionKey !== null &&
          areUiSessionKeysEquivalent(activeSessionKey, data.sessionKey))),
    );
    if (data && !data.draft && matchesActivePane && pendingMatches(data.sessionKey, data)) {
      pendingHandoff = undefined;
      this.maintain(data.sessionKey);
    }
    return Boolean(
      data &&
      consumedData !== data &&
      matchesActivePane &&
      (data.draft !== undefined || data.focusComposer),
    );
  }

  shouldFocusPane(
    active: boolean,
    hasDraft: unknown,
    sessionKey: string,
    data?: SessionChatRouteData,
  ): boolean {
    return Boolean(
      active &&
      data &&
      ((hasDraft && data.focusComposer) || (!hasDraft && pendingMatches(sessionKey, data))),
    );
  }

  beforeDraftCleanup(data: SessionChatRouteData): void {
    if (!data.focusComposer) {
      return;
    }
    // Draft cleanup remounts the route page; carry the one-shot focus fact
    // to that final owner so focus does not die with this page instance.
    pendingHandoff = {
      expiresAt: Date.now() + HANDOFF_TTL_MS,
      sessionKey: data.sessionKey,
      sourceData: data,
    };
  }

  private maintain(sessionKey: string): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const deadline = Date.now() + MAINTENANCE_MS;
    let ownedComposer: HTMLTextAreaElement | undefined;

    const focusCurrentComposer = () => {
      if (!this.host.isConnected) {
        this.timer = undefined;
        return;
      }
      const pane = [...this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].find(
        (candidate) =>
          candidate.active &&
          candidate.sessionKey !== undefined &&
          areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey),
      );
      const composer = pane?.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
      const activeElement = document.activeElement;
      const focusStillOwned =
        activeElement === ownedComposer ||
        activeElement === document.body ||
        (activeElement instanceof HTMLElement && !activeElement.isConnected);

      if (composer && (!ownedComposer || focusStillOwned)) {
        composer.focus({ preventScroll: true });
        ownedComposer = composer;
      } else if (ownedComposer && !focusStillOwned) {
        this.timer = undefined;
        return;
      }

      if (Date.now() < deadline) {
        this.timer = window.setTimeout(focusCurrentComposer, RETRY_MS);
      } else {
        this.timer = undefined;
      }
    };

    focusCurrentComposer();
  }
}
