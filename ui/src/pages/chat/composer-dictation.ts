import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import type {
  ComposerDictationCommits,
  ComposerDictationSession,
  placeComposerDictation,
} from "./composer-dictation-session.ts";
import type { RealtimeTalkLevelSignal } from "./talk/level.ts";

type DictationPhase = "idle" | "starting" | "connecting" | "recording" | "stopping";

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
  onCommit: (text: string, late?: true, preservePreview?: true) => void;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onDictationUnavailable?: () => void;
};

// Session admission must remain synchronous across user and media callbacks.
export class ComposerDictationOwner extends EventTarget {
  private readonly playback = new GatewaySpeechPlayback();
  private phase: DictationPhase = "idle";
  private cancellationListeners: AbortController | null = null;
  private captureStart: object | undefined;
  private session: ComposerDictationSession | null = null;
  // Created with the lazy capture module, before the first transcript exists.
  private commits: ComposerDictationCommits | undefined;
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

  get finalizing(): boolean {
    return this.phase === "stopping";
  }

  // Stop releases the microphone and typing lock before the final text arrives.
  get transcribing(): boolean {
    return Boolean(this.commits?.size);
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
    if (this.phase !== "idle" || !this.canStart()) {
      return false;
    }
    // Enter the session start path directly so capture, errors, partials and
    // finalization stay canonical.
    this.setPhase("starting");
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
    }
    this.options = options;
    if (!options.connected) {
      this.commits?.markGatewayDisconnected();
    }
    if (this.phase === "stopping") {
      return;
    }
    if (this.phase !== "idle" && !this.canStart()) {
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

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  cancel(): void {
    this.playback.stop();
    if (this.commits?.size) {
      this.commits.retire();
      this.pendingCommitsChanged();
    }
    void this.stop({ commit: false });
  }

  private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || (this.phase === "idle" && !this.transcribing)) {
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
    void this.finishActive();
  };

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
    if (this.phase !== "starting" || !client || !this.canStart()) {
      await this.stop({ commit: false });
      return;
    }
    if (this.options.dictationAvailable === false && !this.options.prepareSession) {
      this.setPhase("idle");
      this.options.onDictationUnavailable?.();
      return;
    }
    // Escape/visibility/blur guard the live capture lifecycle.
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
      if (
        this.captureStart !== captureStart ||
        this.disposed ||
        !this.connecting ||
        !this.canStart()
      ) {
        return;
      }
      describeStartError = describeDictationStartError;
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
    const session = this.session;
    if (!session) {
      this.setPhase("idle");
      this.releasePlayback();
      return Promise.resolve(false);
    }
    this.setPhase("stopping");
    this.session = null;
    this.setPhase("idle");
    if (!options.commit) {
      this.releasePlayback();
      void session.cancel().catch(() => undefined);
      return Promise.resolve(false);
    }
    // Capture and typing unlock immediately. Stopped recordings retain ownership
    // and commit in capture order, even when a later provider finishes first.
    const committed = this.commits!.add(session, (lateTranscript) => {
      this.releasePlayback();
      this.pendingCommitsChanged();
      if (
        !lateTranscript ||
        !wasActive ||
        this.disposed ||
        !this.options.enabled ||
        this.options.realtimeTalkActive
      ) {
        return false;
      }
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

  private setPhase(phase: DictationPhase): void {
    if (this.phase === phase) {
      return;
    }
    this.phase = phase;
    this.syncCancellationListeners();
    this.dispatchEvent(new Event("change"));
  }

  private syncCancellationListeners(): void {
    if (this.phase !== "idle" || this.transcribing) {
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
