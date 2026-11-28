import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ComposerDictationRefinement,
  ComposerPunctuationCapture,
  ComposerRefinementScope,
} from "./composer-dictation-refinement.ts";
import {
  ComposerDictationCommits,
  ComposerDictationSession,
} from "./composer-dictation-session.ts";
import type { ComposerDictationOwnerOptions } from "./composer-dictation.ts";

export { describeDictationStartError } from "./composer-dictation-session.ts";

/** Media sessions and their final transcripts only exist after a gesture admits capture. */
export class ComposerDictationRecording {
  readonly commits = new ComposerDictationCommits();
  session: ComposerDictationSession | null = null;
  refinement: ComposerDictationRefinement | undefined;

  constructor(
    private readonly host: {
      options: () => ComposerDictationOwnerOptions;
      readScope: (punctuation: boolean) => ComposerRefinementScope;
      changed: () => void;
      ready: () => void;
      stop: (commit: boolean) => Promise<boolean>;
    },
  ) {}

  async start(
    client: GatewayBrowserClient,
    sessionKey: string | undefined,
    scope: ComposerRefinementScope | undefined,
    punctuation: ComposerPunctuationCapture | undefined,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (scope) {
      const { ComposerDictationRefinement } = await import("./composer-dictation-refinement.ts");
      if (!isCurrent()) {
        return;
      }
      this.refinement ??= new ComposerDictationRefinement({
        readScope: this.host.readScope,
        readTarget: () => this.host.options().readRefinementTarget?.(),
        changed: this.host.changed,
        commit: (text, reviewed) =>
          reviewed
            ? this.host.options().onCommit(text, undefined, undefined, reviewed)
            : this.host.options().onCommit(text, true),
      });
      this.refinement.begin(scope, punctuation);
      this.refinement.reconcile();
      if (!isCurrent()) {
        return;
      }
      if (this.refinement.phase !== "recording") {
        await this.host.stop(false);
        return;
      }
    }
    const session = new ComposerDictationSession(
      client,
      {
        onError: (message, preservesText) => {
          if (this.session !== session && !this.commits.has(session)) {
            return;
          }
          try {
            this.host.options().onError(message, { kind: "interrupted", preservesText });
          } finally {
            if (this.session === session) {
              void this.host.stop(true);
            } else if (this.commits.has(session)) {
              this.host.changed();
            }
          }
        },
        onTranscriptChange: this.host.changed,
        onReady: () => {
          if (this.session === session && isCurrent()) {
            this.host.ready();
          }
        },
      },
      { sessionKey },
    );
    this.session = session;
    await session.start();
  }
}
