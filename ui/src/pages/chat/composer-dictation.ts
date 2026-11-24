import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import { ComposerDictationSession, formatDictationError } from "./composer-dictation-session.ts";
import { RealtimeTalkLevelSignal } from "./talk/level.ts";

const HOLD_ARM_DELAY_MS = 150,
  HOLD_PROGRESS_MS = 350;

type DictationPhase = "idle" | "pressing" | "holding" | "connecting" | "recording" | "stopping";

type ComposerDictationFailure = {
  kind: "interrupted" | "start";
  preservesText: boolean;
};

type ComposerDictationControllerOptions = {
  client: GatewayBrowserClient | null;
  sessionKey?: string;
  connected: boolean;
  enabled: boolean;
  dictationAvailable?: boolean;
  realtimeTalkActive: boolean;
  onCommit: (text: string, late?: true, preservePreview?: true) => void;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onStateChange: () => void;
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

type DictationSelection = { value: string; start: number; end: number };

export function placeComposerDictation(
  text: string,
  captured: DictationSelection | null,
  live: DictationSelection,
  late?: true,
  preservePreview?: true,
) {
  // A live recording's displayed partial is not draft text. Rebase its captured
  // selection when an older transcript arrives so the newer preview stays intact.
  const base =
    captured && (preservePreview || !late || captured.value === live.value) ? captured : live;
  const insertion = insertComposerDictation(base.value, text, base.start, base.end);
  return {
    ...insertion,
    changed: insertion.value !== base.value,
    captured: preservePreview
      ? { value: insertion.value, start: insertion.caret, end: insertion.caret }
      : null,
  };
}

export class ComposerDictationController {
  readonly inputLevel = new RealtimeTalkLevelSignal();
  private readonly playback = new GatewaySpeechPlayback();
  private options: ComposerDictationControllerOptions;
  private phase: DictationPhase = "idle";
  private pointerId: number | null = null;
  private pointerTarget: HTMLElement | null = null;
  private pointerBounds: DOMRect | null = null;
  private holdTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private session: ComposerDictationSession | null = null;
  private suppressedPointerId: number | null = null;
  private suppressClickTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly pendingCommits = new Set<ComposerDictationSession>();
  private commitTail: Promise<unknown> = Promise.resolve();
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

  get transcribing(): boolean {
    return this.pendingCommits.size > 0;
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

  update(options: ComposerDictationControllerOptions): void {
    this.options = options;
    if (!options.connected) {
      for (const session of this.pendingCommits) {
        session.markGatewayDisconnected();
      }
    }
    if (this.phase === "stopping") {
      return;
    }
    if ((this.phase !== "idle" && !this.canHold()) || (this.active && !options.connected)) {
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
    this.pointerTarget?.addEventListener("lostpointercapture", this.handleDocumentPointerCancel);
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
    if (this.suppressedPointerId !== null) {
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
    this.cancel();
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
    if (event.key !== "Escape" || (this.phase === "idle" && !this.transcribing)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.handleWindowBlur();
    }
  };

  private readonly handleWindowBlur = (): void => this.cancel();

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
          if (this.session !== session && !this.pendingCommits.has(session)) {
            return;
          }
          try {
            this.options.onError(message, { kind: "interrupted", preservesText });
          } finally {
            if (this.session === session) {
              void this.stop({ commit: !this.connecting });
            }
          }
        },
        onLevel: (level) => this.inputLevel.set(level),
        onTranscriptChange: () => this.options.onStateChange(),
        onReady: () => {
          if (this.session === session && this.phase === "connecting") {
            this.setPhase("recording");
          }
        },
      },
      { sessionKey: this.options.sessionKey },
    );
    this.session = session;
    try {
      this.playback.prepare(client, () => this.cancel());
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
    if (this.phase === "idle" || this.phase === "stopping") {
      return Promise.resolve(false);
    }
    const wasActive = this.active;
    this.clearPointerGesture();
    const session = this.session;
    if (!session) {
      this.reset();
      this.releasePlayback();
      return Promise.resolve(false);
    }
    this.setPhase("stopping");
    this.session = null;
    if (!options.commit || !wasActive || this.disposed) {
      this.reset();
      this.releasePlayback();
      void session.cancel().catch(() => undefined);
      return Promise.resolve(false);
    }
    const transcript = session.transcriptSnapshot();
    if (transcript && !this.transcribing) {
      this.reset();
      this.releasePlayback();
      this.options.onCommit(transcript);
      void session.finish().catch(() => undefined);
      return Promise.resolve(true);
    }
    // Retain the released session's final drain independently of the next capture.
    // Provider work runs concurrently; delivery alone waits for the earlier Stop.
    const previous = this.commitTail;
    this.pendingCommits.add(session);
    if (transcript) {
      void session.finish().catch(() => undefined);
    }
    const result = transcript
      ? Promise.resolve(transcript)
      : session.finish("composer").catch(() => "");
    const settled = result
      .then(async (text) => {
        await previous;
        if (!this.pendingCommits.delete(session)) {
          return false;
        }
        this.releasePlayback();
        this.syncCancellationListeners();
        const keep = Boolean(
          text && !this.disposed && this.options.enabled && !this.options.realtimeTalkActive,
        );
        if (keep) {
          if (this.locksComposer) {
            this.options.onCommit(text, true, true);
          } else {
            this.options.onCommit(text, true);
          }
        }
        this.options.onStateChange();
        return keep;
      })
      .catch(() => false);
    this.commitTail = settled;
    this.reset();
    return settled;
  }

  private reset(): void {
    this.inputLevel.set(0);
    this.setPhase("idle");
  }

  private releasePlayback(): void {
    if (this.phase === "idle" && !this.transcribing) {
      this.playback.stop();
    }
  }

  private cancel(): void {
    this.clearClickSuppression();
    if (this.transcribing) {
      const pending = [...this.pendingCommits];
      this.pendingCommits.clear();
      this.commitTail = Promise.resolve();
      for (const session of pending) {
        void session.cancel().catch(() => undefined);
      }
      this.syncCancellationListeners();
      if (!this.disposed) {
        this.options.onStateChange();
      }
    }
    this.playback.stop();
    void this.stop({ commit: false });
  }

  private clearPointerGesture(): void {
    if (this.holdTimer !== null) {
      globalThis.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.pointerId !== null) {
      this.pointerTarget?.removeEventListener(
        "lostpointercapture",
        this.handleDocumentPointerCancel,
      );
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
    document.removeEventListener("pointerup", this.handleSuppressedPointerRelease);
    document.removeEventListener("pointercancel", this.handleSuppressedPointerRelease);
    this.suppressedPointerId = null;
  }

  private setPhase(phase: DictationPhase): void {
    if (this.phase === phase) {
      return;
    }
    this.phase = phase;
    this.syncCancellationListeners();
    this.options.onStateChange();
  }

  private syncCancellationListeners(): void {
    if (this.phase !== "idle" || this.transcribing) {
      document.addEventListener("keydown", this.handleDocumentKeyDown);
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      window.addEventListener("blur", this.handleWindowBlur);
    } else {
      document.removeEventListener("keydown", this.handleDocumentKeyDown);
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      window.removeEventListener("blur", this.handleWindowBlur);
    }
  }
}
