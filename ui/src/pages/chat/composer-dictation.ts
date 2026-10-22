import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import { ComposerDictationSession, formatDictationError } from "./composer-dictation-session.ts";

const HOLD_ARM_DELAY_MS = 150,
  HOLD_PROGRESS_MS = 350;

type DictationPhase = "idle" | "pressing" | "holding" | "connecting" | "recording" | "stopping";

type ComposerDictationFailure = {
  kind: "interrupted" | "start";
  preservesText: boolean;
};

type ComposerDictationOwnerOptions = {
  client: GatewayBrowserClient | null;
  sessionKey?: string;
  draftKey?: string;
  connected: boolean;
  enabled: boolean;
  dictationAvailable?: boolean;
  realtimeTalkActive: boolean;
  onCommit: (text: string, late?: true) => void;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onTap?: () => void;
  onDictationUnavailable?: () => void;
};

export function insertComposerDictation(
  value: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } {
  const spoken = transcript.trim();
  if (!spoken) {
    return { value, caret: selectionEnd };
  }
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace = before && !/\s$/.test(before) && !/^\s|^[,.;:!?)]/.test(spoken) ? " " : "";
  const trailingSpace =
    after && !/^\s|^[,.;:!?)]/.test(after) && !/[\s([{]$/.test(spoken) ? " " : "";
  const inserted = `${leadingSpace}${spoken}${trailingSpace}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

// Gesture and session admission must remain synchronous across pointer and media callbacks.
export class ComposerDictationOwner extends EventTarget {
  private readonly playback = new GatewaySpeechPlayback();
  private phase: DictationPhase = "idle";
  private pointerId: number | null = null;
  private pointerTarget: HTMLElement | null = null;
  private pointerBounds: DOMRect | null = null;
  private pointerListeners: AbortController | null = null;
  private suppressionListeners: AbortController | null = null;
  private cancellationListeners: AbortController | null = null;
  private holdTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private session: ComposerDictationSession | null = null;
  private suppressedPointerId: number | null = null;
  private suppressClickTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pendingCommitSession: ComposerDictationSession | null = null;
  private disposed = false;

  constructor(private options: ComposerDictationOwnerOptions) {
    super();
  }

  subscribe(listener: () => void) {
    return listen(this, "change", listener);
  }

  get active(): boolean {
    return this.phase === "connecting" || this.phase === "recording" || this.phase === "stopping";
  }

  get connecting(): boolean {
    return this.phase === "connecting";
  }

  get arming(): boolean {
    return this.phase === "holding";
  }

  get finalizing(): boolean {
    return this.phase === "stopping";
  }

  get locksComposer(): boolean {
    return this.phase !== "idle";
  }

  get transcript(): string {
    return this.session?.transcriptSnapshot() ?? "";
  }

  // Returns the stop promise so the confirming control can remain tied to the
  // session that actually inserted text into the draft.
  finishActive(): Promise<boolean> {
    return this.stop({ commit: true });
  }

  startDirect(): boolean {
    if (this.phase !== "idle" || !this.canHold()) {
      return false;
    }
    // Surfaces without Talk do not need the hold discriminator. Enter the same
    // session start path directly so capture, errors, partials and finalization stay canonical.
    this.setPhase("holding");
    void this.start();
    return true;
  }

  update(options: ComposerDictationOwnerOptions): void {
    if (this.options.draftKey !== options.draftKey) {
      this.cancel();
    }
    this.options = options;
    if (!options.connected) {
      this.pendingCommitSession?.markGatewayDisconnected();
    }
    if (this.phase === "stopping") {
      return;
    }
    if (this.phase !== "idle" && !this.canHold()) {
      const keepFinal = this.active && !options.connected;
      const preservesText = keepFinal ? (this.session?.markGatewayDisconnected() ?? false) : false;
      void this.stop({ commit: keepFinal });
      if (keepFinal) {
        options.onError(t("chat.composer.dictationDisconnected"), {
          kind: "interrupted",
          preservesText,
        });
      }
    }
  }

  handlePointerDown(event: PointerEvent): boolean {
    if (event.button !== 0 || this.phase !== "idle" || !this.canHold()) {
      return false;
    }
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.pointerTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.pointerBounds = this.pointerTarget?.getBoundingClientRect() ?? null;
    this.pointerTarget?.setPointerCapture?.(event.pointerId);
    this.pointerListeners = new AbortController();
    const pointerOptions = { signal: this.pointerListeners.signal };
    if (this.pointerTarget) {
      listen(
        this.pointerTarget,
        "lostpointercapture",
        this.handleDocumentPointerCancel,
        pointerOptions,
      );
    }
    this.suppressedPointerId = event.pointerId;
    this.setPhase("pressing");
    // A normal click gets a quiet grace period. Only a sustained press enters
    // the visible 350ms ring, so the hold affordance cannot steal tap-to-talk.
    this.holdTimer = globalThis.setTimeout(() => {
      if (this.phase !== "pressing") {
        return;
      }
      this.setPhase("holding");
      this.holdTimer = globalThis.setTimeout(() => void this.start(), HOLD_PROGRESS_MS);
    }, HOLD_ARM_DELAY_MS);
    listen(document, "pointermove", this.handleDocumentPointerMove, pointerOptions);
    listen(document, "pointerup", this.handleDocumentPointerUp, pointerOptions);
    listen(document, "pointercancel", this.handleDocumentPointerCancel, pointerOptions);
    this.suppressionListeners?.abort();
    this.suppressionListeners = new AbortController();
    const suppressionOptions = { signal: this.suppressionListeners.signal };
    listen(document, "pointerup", this.handleSuppressedPointerRelease, suppressionOptions);
    listen(document, "pointercancel", this.handleSuppressedPointerRelease, suppressionOptions);
    return true;
  }

  handleClick(event: MouseEvent): void {
    if (this.suppressedPointerId !== null) {
      this.clearClickSuppression();
    } else if (this.active) {
      void this.finishActive();
    } else if (this.phase === "idle") {
      this.options.onTap?.();
      return;
    }
    event.preventDefault();
  }

  handleContextMenu(event: MouseEvent): void {
    if (this.phase !== "idle") {
      event.preventDefault();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  cancel(): void {
    this.clearClickSuppression();
    void this.stop({ commit: false });
  }

  private readonly handleDocumentPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId || !this.pointerBounds) {
      return;
    }
    const rect = this.pointerBounds;
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) {
      void this.stop({ commit: false });
    }
  };

  private readonly handleDocumentPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) {
      return;
    }
    if (this.phase === "pressing" || this.phase === "holding") {
      const cleanTap = this.phase === "pressing";
      this.clearPointerGesture();
      this.setPhase("idle");
      if (cleanTap) {
        this.options.onTap?.();
      }
      this.expireClickSuppression();
      return;
    }
    void this.stop({ commit: true });
  };

  private readonly handleDocumentPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId) {
      void this.stop({ commit: false });
    }
  };

  private readonly handleSuppressedPointerRelease = (event: PointerEvent): void => {
    if (event.pointerId === this.suppressedPointerId) {
      this.expireClickSuppression();
    }
  };

  private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || (this.phase === "idle" && !this.pendingCommitSession)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void this.stop({ commit: false });
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.handleWindowBlur();
    }
  };

  private readonly handleWindowBlur = (): void => {
    this.clearClickSuppression();
    void this.stop({ commit: false });
  };

  private canHold(): boolean {
    return (
      this.options.enabled &&
      this.options.connected &&
      !this.options.realtimeTalkActive &&
      this.options.client !== null
    );
  }

  private async start(): Promise<void> {
    const client = this.options.client;
    if (this.phase !== "holding" || !client || !this.canHold()) {
      await this.stop({ commit: false });
      return;
    }
    if (this.options.dictationAvailable === false) {
      this.clearPointerGesture();
      this.setPhase("idle");
      this.options.onDictationUnavailable?.();
      // The held pointer still owns a synthetic click. Its release expires this
      // suppression only after handleClick has had a chance to consume the tail.
      return;
    }
    // Crossing the threshold latches dictation. Pointer ownership ends here,
    // while Escape/visibility/blur keep guarding the live capture lifecycle.
    this.clearPointerGesture();
    this.setPhase("connecting");
    const session = new ComposerDictationSession(
      client,
      {
        onError: (message, preservesText) => {
          if (this.session !== session && this.pendingCommitSession !== session) {
            return;
          }
          try {
            this.options.onError(message, { kind: "interrupted", preservesText });
          } finally {
            if (this.session === session) {
              void this.stop({ commit: true });
            } else if (this.pendingCommitSession === session) {
              this.retirePendingCommit();
              this.dispatchEvent(new Event("change"));
            }
          }
        },
        onTranscriptChange: () => this.dispatchEvent(new Event("change")),
        onReady: () => {
          if (this.session === session && this.phase === "connecting") {
            this.setPhase("recording");
          }
        },
      },
      { sessionKey: this.options.sessionKey },
    );
    this.retirePendingCommit();
    this.session = session;
    try {
      this.playback.prepare(client, () => void this.stop({ commit: false }));
      await session.start();
    } catch (error) {
      if (this.session !== session || this.disposed || this.finalizing) {
        return;
      }
      this.options.onError(formatDictationError(error), { kind: "start", preservesText: false });
      await this.stop({ commit: false });
    }
  }

  private stop(options: { commit: boolean }): Promise<boolean> {
    if (!options.commit) {
      this.retirePendingCommit();
    }
    if (this.phase === "idle" || this.phase === "stopping") {
      return Promise.resolve(false);
    }
    const wasActive = this.active;
    this.clearPointerGesture();
    const session = this.session;
    if (!session) {
      this.setPhase("idle");
      return Promise.resolve(false);
    }
    this.setPhase("stopping");
    const transcript = options.commit ? session.transcriptSnapshot() : "";
    const committed = Boolean(options.commit && transcript && wasActive && !this.disposed);
    this.session = null;
    this.setPhase("idle");
    if (!options.commit) {
      void session.cancel().catch(() => undefined);
      return Promise.resolve(false);
    }
    if (committed) {
      this.playback.stop();
      this.options.onCommit(transcript);
      this.dispatchEvent(new Event("change"));
      void session.finish().catch(() => undefined);
      return Promise.resolve(true);
    }
    // The composer unlocks immediately, while this exact stopped session keeps
    // its final accumulator and voice claim until another voice action supersedes it.
    this.pendingCommitSession = session;
    this.syncCancellationListeners();
    return session
      .finish(true)
      .catch(() => "")
      .then((lateTranscript) => {
        const ownsPendingCommit = this.pendingCommitSession === session;
        if (ownsPendingCommit) {
          this.pendingCommitSession = null;
          this.playback.stop();
          this.syncCancellationListeners();
        }
        if (!ownsPendingCommit || !lateTranscript || !wasActive || this.disposed) {
          return false;
        }
        this.options.onCommit(lateTranscript, true);
        this.dispatchEvent(new Event("change"));
        return true;
      })
      .catch(() => false);
  }

  private retirePendingCommit(): void {
    const session = this.pendingCommitSession;
    this.pendingCommitSession = null;
    this.playback.stop();
    this.syncCancellationListeners();
    void session?.cancel().catch(() => undefined);
  }

  private clearPointerGesture(): void {
    if (this.holdTimer !== null) {
      globalThis.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.pointerListeners?.abort();
    this.pointerListeners = null;
    if (this.pointerId !== null) {
      try {
        this.pointerTarget?.releasePointerCapture?.(this.pointerId);
      } catch {
        // A reactive render can replace the button and implicitly release capture first.
      }
    }
    this.pointerId = null;
    this.pointerTarget = null;
    this.pointerBounds = null;
  }

  private expireClickSuppression(): void {
    if (this.suppressedPointerId === null || this.suppressClickTimer !== null) {
      return;
    }
    this.suppressClickTimer = globalThis.setTimeout(() => this.clearClickSuppression(), 0);
  }

  private clearClickSuppression(): void {
    if (this.suppressClickTimer !== null) {
      globalThis.clearTimeout(this.suppressClickTimer);
      this.suppressClickTimer = null;
    }
    this.suppressionListeners?.abort();
    this.suppressionListeners = null;
    this.suppressedPointerId = null;
  }

  private setPhase(phase: DictationPhase): void {
    if (this.phase === phase) {
      return;
    }
    this.phase = phase;
    this.syncCancellationListeners();
    this.dispatchEvent(new Event("change"));
  }

  private syncCancellationListeners(): void {
    if (this.phase !== "idle" || this.pendingCommitSession) {
      if (this.cancellationListeners) {
        return;
      }
      this.cancellationListeners = new AbortController();
      const options = { signal: this.cancellationListeners.signal };
      listen(document, "keydown", this.handleDocumentKeyDown, options);
      listen(document, "visibilitychange", this.handleVisibilityChange, options);
      listen(window, "blur", this.handleWindowBlur, options);
    } else {
      this.cancellationListeners?.abort();
      this.cancellationListeners = null;
    }
  }
}
