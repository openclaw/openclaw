import type { DictationRefinementResult } from "../../../../src/shared/dictation-refinement.js";
import { recognizeSnippetPhrase } from "../../../../src/shared/dictation-snippets.js";
import type { VoiceSnippetCatalog } from "../../../../src/shared/voice-snippets.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showVoiceSnippetReview } from "./components/voice-snippet-review.tsx";
import { VoiceSnippetCatalogView } from "./voice-snippet-catalog.ts";
import { VoiceSnippetReview } from "./voice-snippet-review.ts";

export type ComposerSnippetTarget = {
  isCurrent: () => boolean;
  commit: (text: string) => boolean;
};

/** One generation's optional refinement, attached to the existing capture/delivery queue. */
export class ComposerSnippetCapture {
  private readonly abort = new AbortController();
  private readonly view: VoiceSnippetCatalogView;
  private readonly connection: Promise<boolean>;
  private readonly snapshot: Promise<VoiceSnippetCatalog | null>;
  private catalog: VoiceSnippetCatalog | null = null;
  private unavailableInvocation = false;
  reviewing = false;

  constructor(
    private readonly options: {
      client: GatewayBrowserClient;
      captureId: string;
      generation: number;
      target: ComposerSnippetTarget | undefined;
      isCurrent: () => boolean;
      changed: () => void;
      unavailable: () => void;
    },
  ) {
    this.connection = options.client.connectSent;
    this.view = new VoiceSnippetCatalogView(options.client, this.abort.signal);
    this.snapshot = this.view.load().then((loaded) => {
      this.catalog = loaded ? this.view.catalog : null;
      return this.catalog;
    });
  }

  get requiresReview(): boolean {
    return this.catalog?.enabled === true || this.unavailableInvocation;
  }

  private current(): boolean {
    return (
      !this.abort.signal.aborted &&
      this.options.isCurrent() &&
      this.options.client.connected &&
      this.options.client.connectSent === this.connection
    );
  }

  cancel(): void {
    if (this.abort.signal.aborted) {
      return;
    }
    this.abort.abort();
    this.reviewing = false;
    this.options.changed();
  }

  /** undefined keeps the feature-off baseline; true/false is an explicitly reviewed outcome. */
  async finish(
    transcript: string,
    structured?: { text: string; revision: number; finalized: boolean; qualified: boolean },
  ): Promise<boolean | undefined> {
    const catalog = await this.snapshot;
    if (!catalog?.enabled) {
      if (
        !catalog &&
        this.view.error !== "identity" &&
        this.current() &&
        recognizeSnippetPhrase(transcript)
      ) {
        this.unavailableInvocation = true;
        this.options.unavailable();
      }
      return undefined;
    }
    if (!this.current()) {
      return false;
    }
    this.reviewing = true;
    this.options.changed();
    const rawTranscript =
      structured?.qualified && structured.finalized ? structured.text : transcript;
    const owner = new VoiceSnippetReview({
      request: {
        schemaVersion: 1,
        captureId: this.options.captureId,
        generation: this.options.generation,
        transcriptRevision: structured?.revision ?? 0,
        mode: "dictation",
        rawTranscript,
      },
      catalog,
      signal: this.abort.signal,
      isCurrent: () => this.current(),
      // Missing stable provider receipts permit deliberate UI selection, never automatic activation.
      literalCode: !structured?.qualified || !structured.finalized,
      loadCatalog: async () => {
        if (!this.current() || !(await this.view.load()) || !this.current() || !this.view.catalog) {
          throw new Error("unavailable");
        }
        return this.view.catalog;
      },
      deliver: (result: DictationRefinementResult) => {
        if (!this.current() || !this.options.target?.isCurrent()) {
          return "not-committed";
        }
        try {
          return this.options.target.commit(result.text) ? "committed" : "not-committed";
        } catch {
          return "outcome-unknown";
        }
      },
    });
    try {
      await owner.prepare();
      if (!this.current()) {
        return false;
      }
      return this.current()
        ? await showVoiceSnippetReview({ owner, signal: this.abort.signal })
        : false;
    } finally {
      owner.cancel();
      this.reviewing = false;
      this.options.changed();
    }
  }
}
