import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  normalizeDictationCleanupPolicy,
  type DictationCleanupPolicy,
} from "../../app/settings-contract.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { hasModalSurface } from "../../components/overlay-registry.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import type {
  ComposerDictationCommits,
  ComposerDictationSession,
  placeComposerDictation,
} from "./composer-dictation-session.ts";
import type {
  DictationCleanupReview,
  DictationDraftReceipt,
  DictationDraftSnapshot,
  DictationRefinement,
} from "./dictation-refinement.ts";
import type { RealtimeTalkLevelSignal } from "./talk/level.ts";

const HOLD_ARM_DELAY_MS = 150,
  HOLD_PROGRESS_MS = 350;

type DictationPhase = "idle" | "pressing" | "holding" | "connecting" | "recording" | "stopping";

type ComposerDictationFailure = {
  kind: "interrupted" | "start" | "busy";
  preservesText: boolean;
};

type ComposerDictationOwnerOptions = {
  client: GatewayBrowserClient | null;
  sessionKey?: string;
  prepareSession?: () => Promise<string | undefined>;
  draftKey?: string;
  connected: boolean;
  enabled: boolean;
  dictationAvailable?: boolean;
  realtimeTalkActive: boolean;
  onCommit: (
    text: string,
    late?: true,
    preservePreview?: true,
  ) => DictationDraftReceipt | false | void;
  readDraft?: () => DictationDraftSnapshot | undefined;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onTap?: () => void;
  onDictationUnavailable?: () => void;
};

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
  private captureStart: object | undefined;
  private session: ComposerDictationSession | null = null;
  private suppressedPointerId: number | null = null;
  private suppressClickTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  // Created with the lazy capture module, before the first transcript exists.
  private commits: ComposerDictationCommits | undefined;
  private refinement: DictationRefinement | undefined;
  private cleanupCapture: {
    policy: DictationCleanupPolicy;
    cancelled: boolean;
    auth: GatewayBrowserClient["auth"];
  } | null = null;
  private pendingCleanup: { policy: DictationCleanupPolicy; cancelled: boolean } | null = null;
  private scope = {};
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

  // Stop releases the microphone and typing lock before the final text arrives.
  get transcribing(): boolean {
    return Boolean(this.commits?.size);
  }

  get cleanupPolicy(): DictationCleanupPolicy {
    return normalizeDictationCleanupPolicy(loadSettings().dictationCleanup);
  }

  get cleanupReview(): DictationCleanupReview | null {
    return this.refinement?.review ?? null;
  }

  get awaitingCleanup(): boolean {
    return Boolean(this.pendingCleanup || this.refinement?.blocksCapture);
  }

  get requiresCleanupReview(): boolean {
    return Boolean(
      this.cleanupCapture ||
      this.awaitingCleanup ||
      (this.connecting && !this.session && this.cleanupPolicy.mode === "conservative"),
    );
  }

  setCleanupPolicy(policy: Pick<DictationCleanupPolicy, "mode" | "locale">): void {
    const normalized = normalizeDictationCleanupPolicy({ version: 1, ...policy });
    patchSettings({ dictationCleanup: normalized });
    if (normalized.mode === "off") {
      // Turning cleanup off cannot publish a previously prepared candidate.
      if (this.cleanupCapture) {
        this.cleanupCapture.policy = normalized;
      }
      this.refinement?.cancel();
      this.retireCleanupCapture();
    }
    this.dispatchEvent(new Event("change"));
  }

  chooseCleanupRaw(): boolean {
    const chosen = this.refinement?.chooseRaw() === true;
    if (chosen || this.refinement?.review?.applied) {
      this.retireCleanupCapture();
    }
    return chosen;
  }

  acceptCleanup(): boolean {
    const accepted = this.refinement?.accept() === true;
    if (accepted || this.refinement?.review?.applied) {
      this.retireCleanupCapture();
    }
    return accepted;
  }

  retryCleanup(): void {
    this.refinement?.retry(this.cleanupPolicy);
  }

  dismissCleanup(): void {
    this.retireCleanupCapture();
    this.refinement?.dismiss();
  }

  private retireCleanupCapture(): void {
    if (this.pendingCleanup) {
      this.pendingCleanup.cancelled = true;
      this.pendingCleanup = null;
      this.commits?.retire();
    }
    this.releasePlayback();
    this.pendingCommitsChanged();
  }

  get locksComposer(): boolean {
    return this.phase !== "idle";
  }

  /** Places a transcript in a draft; there is nothing to place before capture loads. */
  placeTranscript(
    ...args: Parameters<typeof placeComposerDictation>
  ): ReturnType<typeof placeComposerDictation> | undefined {
    return this.commits?.place(...args);
  }

  get inputLevel(): RealtimeTalkLevelSignal | undefined {
    return this.session?.inputLevel;
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
    if (
      this.phase !== "idle" ||
      !this.canHold() ||
      this.awaitingCleanup ||
      (this.cleanupPolicy.mode === "conservative" && this.transcribing)
    ) {
      return false;
    }
    // Surfaces without Talk do not need the hold discriminator. Enter the same
    // session start path directly so capture, errors, partials and finalization stay canonical.
    this.setPhase("holding");
    void this.start();
    return true;
  }

  update(options: ComposerDictationOwnerOptions): void {
    if (
      this.options.client !== options.client ||
      this.options.sessionKey !== options.sessionKey ||
      this.options.draftKey !== options.draftKey
    ) {
      this.cancel();
      this.scope = {};
      this.refinement?.dismiss();
    }
    this.options = options;
    if (this.refinement && (!options.connected || !options.enabled || options.realtimeTalkActive)) {
      this.retireCleanupCapture();
      this.refinement.dismiss();
    }
    if (!options.connected) {
      this.commits?.markGatewayDisconnected();
    }
    if (this.phase === "stopping") {
      return;
    }
    if (this.phase !== "idle" && !this.canHold()) {
      const keepFinal = this.active && !options.connected;
      const preservesText = keepFinal ? (this.session?.markGatewayDisconnected() ?? false) : false;
      void this.stop({ commit: keepFinal });
      // Empty drains report through the session; retained text still needs this notice.
      if (keepFinal && preservesText) {
        options.onError(t("chat.composer.dictationDisconnected"), {
          kind: "interrupted",
          preservesText,
        });
      }
    }
  }

  handlePointerDown(event: PointerEvent): boolean {
    if (
      event.button !== 0 ||
      this.phase !== "idle" ||
      !this.canHold() ||
      this.awaitingCleanup ||
      (this.cleanupPolicy.mode === "conservative" && this.transcribing)
    ) {
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
    this.refinement?.dismiss();
  }

  cancel(): void {
    this.clearClickSuppression();
    this.playback.stop();
    if (this.commits?.size) {
      this.commits.retire();
      this.pendingCommitsChanged();
    }
    if (this.pendingCleanup) {
      this.pendingCleanup.cancelled = true;
      this.pendingCleanup = null;
    }
    this.refinement?.cancel();
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
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      hasModalSurface(document) ||
      (this.phase === "idle" && !this.transcribing && !this.awaitingCleanup)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  // Leaving the window interrupts capture but keeps dictated text in the draft.
  // The browser's microphone permission prompt (Safari, Chrome) blurs the window
  // while the microphone is still opening, so a blur waits until listening: Allow
  // then starts listening and a denial reports its error. A hidden page still ends
  // dictation at any point.
  private readonly handleWindowLeave = (event: Event): void => {
    if (
      event.type === "visibilitychange" ? document.visibilityState !== "hidden" : this.connecting
    ) {
      return;
    }
    this.clearClickSuppression();
    void this.finishActive();
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
    if (this.options.dictationAvailable === false && !this.options.prepareSession) {
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
    const captureStart = {};
    this.captureStart = captureStart;
    this.setPhase("connecting");
    if (this.captureStart !== captureStart) {
      return;
    }
    let describeStartError = (error: unknown): [string, ComposerDictationFailure["kind"]] => [
      formatUiError(error),
      "start",
    ];
    try {
      // Preserve Safari playback activation before the lazy capture module loads.
      this.playback.prepare(client, () => this.cancel());
      const sessionKey = this.options.prepareSession
        ? await this.options.prepareSession()
        : this.options.sessionKey;
      const { ComposerDictationSession, ComposerDictationCommits, describeDictationStartError } =
        await import("./composer-dictation-session.ts");
      const cleanupPolicy = this.cleanupPolicy;
      if (cleanupPolicy.mode === "conservative" && !this.refinement) {
        const { DictationRefinement } = await import("./dictation-refinement.ts");
        this.refinement = new DictationRefinement(() => this.pendingCommitsChanged());
      }
      if (
        this.captureStart !== captureStart ||
        this.disposed ||
        !this.connecting ||
        !this.canHold()
      ) {
        return;
      }
      describeStartError = describeDictationStartError;
      this.refinement?.dismiss();
      this.cleanupCapture =
        cleanupPolicy.mode === "conservative"
          ? { policy: cleanupPolicy, cancelled: false, auth: client.auth }
          : null;
      const commits = (this.commits ??= new ComposerDictationCommits());
      const session = new ComposerDictationSession(
        client,
        {
          onError: (message, preservesText) => {
            if (this.session !== session && !commits.has(session)) {
              return;
            }
            try {
              this.options.onError(message, { kind: "interrupted", preservesText });
            } finally {
              if (this.session === session) {
                void this.stop({ commit: true });
              } else if (commits.has(session)) {
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
        { sessionKey },
      );
      this.session = session;
      await session.start();
    } catch (error) {
      if (this.captureStart !== captureStart || this.disposed || this.finalizing) {
        return;
      }
      const [message, kind] = describeStartError(error);
      this.options.onError(message, { kind, preservesText: false });
      await this.stop({ commit: false });
    }
  }

  private stop(options: { commit: boolean }): Promise<boolean> {
    this.captureStart = undefined;
    if (this.phase === "idle" || this.phase === "stopping") {
      return Promise.resolve(false);
    }
    const wasActive = this.active;
    this.clearPointerGesture();
    const session = this.session;
    if (!session) {
      this.setPhase("idle");
      this.releasePlayback();
      return Promise.resolve(false);
    }
    this.setPhase("stopping");
    this.session = null;
    this.setPhase("idle");
    const cleanup = this.cleanupCapture;
    this.cleanupCapture = null;
    // Capture the unlocked draft before waiting for final STT. Later typing must
    // not be replaced by either a refined candidate or an original-text choice.
    const draft = this.options.readDraft?.();
    const scope = this.scope;
    const client = this.options.client;
    const auth = cleanup ? cleanup.auth : client?.auth;
    const binding = {
      isCurrent: () =>
        !this.disposed &&
        this.scope === scope &&
        this.options.client === client &&
        client?.auth === auth &&
        this.options.connected &&
        this.options.enabled &&
        !this.options.realtimeTalkActive,
      readDraft: () => this.options.readDraft?.(),
      publish: (text: string) => this.options.onCommit(text, true),
    };
    // Register ownership before observers can choose original text synchronously.
    this.pendingCleanup = options.commit ? cleanup : null;
    if (cleanup && session.transcriptSnapshot()) {
      this.refinement!.prepare(
        session.cleanupSource(session.transcriptSnapshot()),
        cleanup.policy,
        binding,
        draft,
      );
    }
    if (!options.commit || cleanup?.cancelled) {
      this.refinement?.cancel();
      this.releasePlayback();
      void session.cancel().catch(() => undefined);
      return Promise.resolve(false);
    }
    // Capture and typing unlock immediately. Stopped recordings retain ownership
    // and commit in capture order, even when a later provider finishes first.
    const committed = this.commits!.add(session, (lateTranscript) => {
      this.releasePlayback();
      if (
        !lateTranscript ||
        !wasActive ||
        this.disposed ||
        !this.options.enabled ||
        this.options.realtimeTalkActive
      ) {
        if (this.pendingCleanup === cleanup) {
          this.pendingCleanup = null;
        }
        this.pendingCommitsChanged();
        return false;
      }
      if (cleanup) {
        if (cleanup.cancelled || !binding.isCurrent()) {
          if (this.pendingCleanup === cleanup) {
            this.pendingCleanup = null;
          }
          this.pendingCommitsChanged();
          return false;
        }
        this.pendingCleanup = null;
        this.refinement!.prepare(
          session.cleanupSource(lateTranscript),
          cleanup.policy,
          binding,
          draft,
        );
        return false;
      }
      this.pendingCommitsChanged();
      if (this.active) {
        this.options.onCommit(lateTranscript, true, true);
      } else {
        this.options.onCommit(lateTranscript, true);
      }
      this.dispatchEvent(new Event("change"));
      return true;
    });
    this.pendingCommitsChanged();
    return committed;
  }

  private releasePlayback(): void {
    if (this.phase === "idle" && !this.transcribing) {
      this.playback.stop();
    }
  }

  private pendingCommitsChanged(): void {
    this.syncCancellationListeners();
    this.dispatchEvent(new Event("change"));
  }

  private clearPointerGesture(): void {
    globalThis.clearTimeout(this.holdTimer ?? undefined);
    this.holdTimer = null;
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
    globalThis.clearTimeout(this.suppressClickTimer ?? undefined);
    this.suppressClickTimer = null;
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
    if (this.phase !== "idle" || this.transcribing || this.awaitingCleanup) {
      if (this.cancellationListeners) {
        return;
      }
      this.cancellationListeners = new AbortController();
      const options = { signal: this.cancellationListeners.signal };
      listen(document, "keydown", this.handleDocumentKeyDown, options);
      listen(document, "visibilitychange", this.handleWindowLeave, options);
      listen(window, "blur", this.handleWindowLeave, options);
    } else {
      this.cancellationListeners?.abort();
      this.cancellationListeners = null;
    }
  }
}
