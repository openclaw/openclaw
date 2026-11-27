import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  ComposerDictationCommits,
  ComposerDictationSession,
} from "./composer-dictation-session.ts";
import type { ComposerDictationOwnerOptions } from "./composer-dictation.ts";

// A later failure loading the full review must not require another fetch to
// render the original transcript and its recovery actions.
export { ComposerCorrectionPresentation } from "./components/composer-correction-recovery.tsx";
export { describeDictationStartError } from "./composer-dictation-session.ts";

type CorrectionCapture = {
  literal: boolean;
  draftRevision: number;
  isDraftCurrent?: () => boolean;
  transportInterrupted: boolean;
};

type CaptureHooks = {
  options: () => ComposerDictationOwnerOptions;
  active: () => boolean;
  ready: () => void;
  idle: () => void;
  interrupted: () => void;
  changed: () => void;
  commitsChanged: () => void;
};

/** Owns the live session, ordered stopped sessions, and retained review text. */
export class ComposerDictationCapture {
  private readonly commits = new ComposerDictationCommits();
  readonly place = this.commits.place;
  private session: ComposerDictationSession | null = null;
  private correction: CorrectionCapture | null = null;
  private pendingOriginal: string | null = null;

  constructor(private readonly hooks: CaptureHooks) {}

  get recording() {
    return this.session !== null;
  }

  get transcribing() {
    return this.commits.size > 0;
  }

  get inputLevel() {
    return this.session?.inputLevel;
  }

  get transcript() {
    return this.session?.transcriptSnapshot() ?? "";
  }

  get correctionCommitRequired() {
    return this.correction !== null;
  }

  get correctionReview() {
    const original = this.pendingOriginal;
    const capture = this.correction;
    if (original === null || !capture) {
      return null;
    }
    const canKeepOriginal = this.isCorrectionSourceCurrent(capture);
    return {
      original,
      canKeepOriginal,
      invalidated: !canKeepOriginal || capture.transportInterrupted,
    };
  }

  keepOriginal(): boolean {
    const original = this.pendingOriginal;
    const capture = this.correction;
    if (original === null || !capture || !this.isCorrectionSourceCurrent(capture)) {
      this.hooks.changed();
      return false;
    }
    this.clearReview();
    this.hooks.options().onCommit(original, true, undefined, true);
    this.hooks.commitsChanged();
    return true;
  }

  disconnect(interrupted: boolean): void {
    if (interrupted && this.correction) {
      // Same-destination recovery may keep Literal text but may not insert it automatically.
      this.correction.transportInterrupted = true;
      this.hooks.changed();
    }
    this.commits.markGatewayDisconnected();
  }

  markRecordingDisconnected(): boolean {
    return this.session?.markGatewayDisconnected() ?? false;
  }

  retire(): void {
    this.clearReview();
    if (this.transcribing) {
      this.commits.retire();
      this.hooks.commitsChanged();
    }
  }

  start(
    client: GatewayBrowserClient,
    sessionKey: string | undefined,
    literal: boolean | undefined,
    isDraftCurrent: (() => boolean) | undefined,
  ): Promise<void> {
    const session = new ComposerDictationSession(
      client,
      {
        onError: (message, preservesText) => {
          if (this.session !== session && !this.commits.has(session)) {
            return;
          }
          try {
            this.hooks.options().onError(message, { kind: "interrupted", preservesText });
          } finally {
            if (this.session === session) {
              this.hooks.interrupted();
            } else if (this.commits.has(session)) {
              this.hooks.changed();
            }
          }
        },
        onTranscriptChange: this.hooks.changed,
        onReady: () => {
          if (this.session === session) {
            this.hooks.ready();
          }
        },
      },
      { sessionKey },
    );
    if (literal !== undefined) {
      this.correction = { literal, isDraftCurrent, draftRevision: 0, transportInterrupted: false };
    }
    this.session = session;
    return session.start();
  }

  stop(commit: boolean, wasActive: boolean): Promise<boolean> {
    const session = this.session;
    if (!session) {
      return Promise.resolve(false);
    }
    this.session = null;
    this.hooks.idle();
    if (!commit) {
      this.clearReview();
      this.hooks.commitsChanged();
      void session.cancel().catch(() => undefined);
      return Promise.resolve(false);
    }
    // Typing is unlocked before the snapshot. Even an edit back to the same
    // text advances the owning draft revision while this result drains.
    const correction = this.correction;
    if (correction) {
      correction.draftRevision = this.hooks.options().getDraftRevision?.() ?? 0;
    }
    const committed = this.commits.add(session, (original) => {
      if (!original) {
        if (this.correction === correction) {
          this.clearReview();
        }
        this.hooks.commitsChanged();
        return false;
      }
      const options = this.hooks.options();
      if (!wasActive || !options.enabled || options.realtimeTalkActive) {
        this.hooks.commitsChanged();
        return false;
      }
      if (correction) {
        if (this.correction !== correction) {
          this.hooks.commitsChanged();
          return false;
        }
        if (
          !correction.literal ||
          correction.transportInterrupted ||
          !this.isCorrectionSourceCurrent(correction)
        ) {
          this.pendingOriginal = original;
          this.hooks.commitsChanged();
          return false;
        }
        this.clearReview();
        options.onCommit(original, true, undefined, true);
      } else if (this.hooks.active()) {
        options.onCommit(original, true, true);
      } else {
        options.onCommit(original, true);
      }
      this.hooks.commitsChanged();
      return true;
    });
    this.hooks.commitsChanged();
    return committed;
  }

  private isCorrectionSourceCurrent(capture: CorrectionCapture): boolean {
    const options = this.hooks.options();
    return (
      this.correction === capture &&
      !this.hooks.active() &&
      options.connected &&
      options.enabled &&
      !options.realtimeTalkActive &&
      options.getDraftRevision?.() === capture.draftRevision &&
      (capture.isDraftCurrent?.() ?? true)
    );
  }

  private clearReview(): void {
    this.correction = null;
    this.pendingOriginal = null;
  }
}
