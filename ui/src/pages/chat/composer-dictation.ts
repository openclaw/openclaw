import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { ComposerDictationSession, messageFromError } from "./composer-dictation-session.ts";
import { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";

const HOLD_ARM_DELAY_MS = 150,
  HOLD_PROGRESS_MS = 350;
type DictationPhase = "idle" | "pressing" | "holding" | "connecting" | "recording" | "stopping";

type ComposerDictationControllerOptions = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enabled: boolean;
  holdToDictate?: boolean;
  dictationAvailable?: boolean;
  realtimeTalkActive: boolean;
  onCommit: (text: string, late?: true) => void;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onStateChange: () => void;
  onTap?: () => void;
  onDictationUnavailable?: () => void;
};

type ComposerDictationFailure = {
  kind: "interrupted" | "start";
  preservesText: boolean;
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

export function resolveComposerDictationInsertion(params: {
  captured: { start: number; end: number; value: string } | null;
  late: boolean | undefined;
  target: HTMLTextAreaElement | null;
  liveValue: string;
  transcript: string;
}): { value: string; caret: number } {
  // Stop unlocks the draft. Preserve later edits by using the live caret only
  // when a delayed final finds that the captured draft has changed.
  const selection =
    params.captured && (!params.late || params.captured.value === params.liveValue)
      ? params.captured
      : {
          start: params.target?.selectionStart ?? params.liveValue.length,
          end: params.target?.selectionEnd ?? params.liveValue.length,
          value: params.liveValue,
        };
  return insertComposerDictation(
    selection.value,
    params.transcript,
    selection.start,
    selection.end,
  );
}

export class ComposerDictationController {
  readonly inputLevel = new RealtimeTalkLevelSignal();
  private options: ComposerDictationControllerOptions;
  private phase: DictationPhase = "idle";
  private pointerId: number | null = null;
  private pointerTarget: HTMLElement | null = null;
  private pointerBounds: DOMRect | null = null;
  private holdTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private session: ComposerDictationSession | null = null;
  private suppressClick = false;
  private suppressedPointerId: number | null = null;
  private suppressClickTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pendingCommitSession: ComposerDictationSession | null = null;
  private disposed = false;

  constructor(options: ComposerDictationControllerOptions) {
    this.options = options;
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
    if (this.phase !== "idle" || !this.canStart()) {
      return false;
    }
    // Surfaces without Talk do not need the hold discriminator. Enter the same
    // session start path directly so capture, errors, partials and finalization stay canonical.
    this.setPhase("holding");
    void this.start();
    return true;
  }

  update(options: ComposerDictationControllerOptions): void {
    this.options = options;
    if (!options.connected) {
      this.pendingCommitSession?.markGatewayDisconnected();
    }
    if (this.phase === "stopping") {
      return;
    }
    if ((this.phase !== "idle" && !this.canStart()) || (this.active && !options.connected)) {
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
    this.pointerTarget?.addEventListener("lostpointercapture", this.handleLostPointerCapture);
    this.suppressClick = true;
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
    document.addEventListener("pointermove", this.handleDocumentPointerMove);
    document.addEventListener("pointerup", this.handleDocumentPointerUp);
    document.addEventListener("pointercancel", this.handleDocumentPointerCancel);
    document.addEventListener("pointerup", this.handleSuppressedPointerRelease);
    document.addEventListener("pointercancel", this.handleSuppressedPointerRelease);
    return true;
  }

  handleClick(event: MouseEvent): void {
    if (this.suppressClick) {
      this.clearClickSuppression();
      event.preventDefault();
      return;
    }
    if (this.active) {
      event.preventDefault();
      void this.finishActive();
      return;
    }
    if (this.phase !== "idle") {
      event.preventDefault();
      return;
    }
    this.options.onTap?.();
  }

  handleContextMenu(event: MouseEvent): void {
    if (this.phase !== "idle") {
      event.preventDefault();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.retirePendingCommit();
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
    if (event.key !== "Escape" || this.phase === "idle") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void this.stop({ commit: false });
  };

  private readonly handleLostPointerCapture = (event: Event): void => {
    if ((event as PointerEvent).pointerId === this.pointerId) {
      void this.stop({ commit: false });
    }
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.clearClickSuppression();
      void this.stop({ commit: false });
    }
  };

  private readonly handleWindowBlur = (): void => {
    this.clearClickSuppression();
    void this.stop({ commit: false });
  };

  private canHold(): boolean {
    return this.canStart() && this.options.holdToDictate !== false;
  }

  private canStart(): boolean {
    return (
      this.options.enabled &&
      this.options.connected &&
      !this.options.realtimeTalkActive &&
      this.options.client !== null
    );
  }

  private async start(): Promise<void> {
    const client = this.options.client;
    if (this.phase !== "holding" || !client || !this.canStart()) {
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
    const session = new ComposerDictationSession(client, {
      onError: (message, preservesText) => {
        if (this.session !== session) {
          return;
        }
        try {
          this.options.onError(message, { kind: "interrupted", preservesText });
        } finally {
          void this.stop({ commit: true });
        }
      },
      onLevel: (level) => this.inputLevel.set(level),
      onTranscriptChange: () => this.options.onStateChange(),
      onReady: () => {
        if (this.session === session && this.phase === "connecting") {
          this.setPhase("recording");
        }
      },
    });
    this.retirePendingCommit();
    this.session = session;
    try {
      await session.start();
    } catch (error) {
      if (this.session !== session || this.disposed || this.isStopping()) {
        return;
      }
      this.options.onError(messageFromError(error), { kind: "start", preservesText: false });
      await this.stop({ commit: false });
    }
  }

  private stop(options: { commit: boolean }): Promise<boolean> {
    if (this.phase === "idle" || this.phase === "stopping") {
      return Promise.resolve(false);
    }
    const wasActive = this.active;
    this.clearPointerGesture();
    const session = this.session;
    if (!session) {
      this.reset();
      return Promise.resolve(false);
    }
    this.setPhase("stopping");
    const transcript = options.commit ? session.transcriptSnapshot() : "";
    const committed = Boolean(options.commit && transcript && wasActive && !this.disposed);
    this.session = null;
    this.reset();
    if (committed) {
      this.options.onCommit(transcript);
    }
    if (!options.commit) {
      void session.cancel().catch(() => undefined);
      return Promise.resolve(false);
    }
    if (committed) {
      void session.finish().catch(() => undefined);
      return Promise.resolve(true);
    }
    // The composer unlocks immediately, while this exact stopped session keeps
    // ownership of its bounded final accumulator until a new session supersedes it.
    this.pendingCommitSession = session;
    return session
      .finish(true)
      .then((lateTranscript) => {
        const ownsPendingCommit = this.pendingCommitSession === session;
        if (ownsPendingCommit) {
          this.pendingCommitSession = null;
        }
        if (!ownsPendingCommit || !lateTranscript || !wasActive || this.disposed) {
          return false;
        }
        this.options.onCommit(lateTranscript, true);
        return true;
      })
      .catch(() => {
        if (this.pendingCommitSession === session) {
          this.pendingCommitSession = null;
        }
        return false;
      });
  }

  private reset(): void {
    this.inputLevel.set(0);
    this.setPhase("idle");
  }

  private retirePendingCommit(): void {
    this.pendingCommitSession?.cancelPendingFinal();
    this.pendingCommitSession = null;
  }

  private clearPointerGesture(): void {
    if (this.holdTimer !== null) {
      globalThis.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.pointerId !== null) {
      this.pointerTarget?.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
      try {
        this.pointerTarget?.releasePointerCapture?.(this.pointerId);
      } catch {
        // A reactive render can replace the button and implicitly release capture first.
      }
    }
    this.pointerId = null;
    this.pointerTarget = null;
    this.pointerBounds = null;
    document.removeEventListener("pointermove", this.handleDocumentPointerMove);
    document.removeEventListener("pointerup", this.handleDocumentPointerUp);
    document.removeEventListener("pointercancel", this.handleDocumentPointerCancel);
  }

  private expireClickSuppression(): void {
    if (!this.suppressClick || this.suppressClickTimer !== null) {
      return;
    }
    this.suppressClickTimer = globalThis.setTimeout(() => this.clearClickSuppression(), 0);
  }

  private clearClickSuppression(): void {
    if (this.suppressClickTimer !== null) {
      globalThis.clearTimeout(this.suppressClickTimer);
      this.suppressClickTimer = null;
    }
    document.removeEventListener("pointerup", this.handleSuppressedPointerRelease);
    document.removeEventListener("pointercancel", this.handleSuppressedPointerRelease);
    this.suppressedPointerId = null;
    this.suppressClick = false;
  }

  private isStopping(): boolean {
    return this.phase === "stopping";
  }

  private setPhase(phase: DictationPhase): void {
    if (this.phase === phase) {
      return;
    }
    if (this.phase === "idle") {
      document.addEventListener("keydown", this.handleDocumentKeyDown);
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      window.addEventListener("blur", this.handleWindowBlur);
    } else if (phase === "idle") {
      document.removeEventListener("keydown", this.handleDocumentKeyDown);
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      window.removeEventListener("blur", this.handleWindowBlur);
    }
    this.phase = phase;
    this.options.onStateChange();
  }
}
