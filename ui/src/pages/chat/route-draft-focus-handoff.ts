import { listen } from "../../lib/reactive/listener.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { chatPanesWithin } from "./chat-pane-elements.ts";
import type { SessionChatRouteData } from "./route-loader.ts";

const HANDOFF_TTL_MS = 30_000;
const MAINTENANCE_MS = 15_000;
const RETRY_MS = 250;

type PendingHandoff = {
  expiresAt: number;
  sessionKey: string;
  sourceData: SessionChatRouteData;
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
  private cancelMaintenance: (() => void) | undefined;

  constructor(private readonly host: HTMLElement) {}

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

  dispose(): void {
    this.cancelMaintenance?.();
  }

  private maintain(sessionKey: string): void {
    this.cancelMaintenance?.();
    const deadline = Date.now() + MAINTENANCE_MS;
    let ownedComposer: HTMLTextAreaElement | undefined;
    let timer: number | undefined;
    const doc = this.host.ownerDocument;
    const cancel = () => {
      window.clearTimeout(timer);
      stopEvents.forEach((stop) => stop());
      this.cancelMaintenance = undefined;
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target !== ownedComposer) {
        cancel();
      }
    };
    // A brief menu interaction can return focus to body between maintenance ticks.
    // Once the user takes focus, this handoff must not reclaim it.
    const stopEvents = [
      listen(doc, "pointerdown", cancel, true),
      listen(doc, "keydown", cancel, true),
      listen(doc, "focusin", onFocus, true),
    ];
    this.cancelMaintenance = cancel;

    const focusCurrentComposer = () => {
      if (!this.host.isConnected) {
        cancel();
        return;
      }
      // Route replacement remounts pane bridges; resolve their current composer for this handoff.
      const pane = chatPanesWithin(this.host).find(
        (candidate) =>
          candidate.active &&
          candidate.sessionKey !== undefined &&
          areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey),
      );
      const composer = pane?.composerElement;
      const activeElement = doc.activeElement;
      const focusStillOwned =
        activeElement === ownedComposer ||
        activeElement === doc.body ||
        (activeElement instanceof HTMLElement && !activeElement.isConnected);

      if (composer && (!ownedComposer || focusStillOwned)) {
        ownedComposer = composer;
        composer.focus({ preventScroll: true });
      } else if (ownedComposer && !focusStillOwned) {
        cancel();
        return;
      }

      if (Date.now() < deadline) {
        timer = window.setTimeout(focusCurrentComposer, RETRY_MS);
      } else {
        cancel();
      }
    };

    focusCurrentComposer();
  }
}
