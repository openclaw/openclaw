// Whimsical long-wait status word ("Clawing…") for the chat working row.
// Silent for the first stretch of a run, then rotates through crab-themed
// gerunds so long quiet runs feel alive without claiming progress data the
// UI does not have. Decorative only — the row keeps its sr-only "Working…".
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { PollController } from "../lit/poll-controller.ts";

const PHRASE_KEYS = [
  "shelling",
  "scuttling",
  "clawing",
  "pinching",
  "molting",
  "bubbling",
  "tiding",
  "reefing",
  "cracking",
  "sifting",
  "brining",
  "nautiling",
  "krilling",
  "barnacling",
  "lobstering",
  "tidepooling",
  "pearling",
  "snapping",
  "surfacing",
] as const;

/** Quiet grace period before the first phrase appears. Mirrored as literals
 * in working-phrase.test.ts (knip forbids test-only exports). */
const WORKING_PHRASE_SHOW_AFTER_MS = 30_000;
/** How long each phrase holds before rotating to the next. */
const WORKING_PHRASE_ROTATE_EVERY_MS = 45_000;

function greatestCommonDivisor(first: number, second: number): number {
  let left = first;
  let right = second;
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return left;
}

/** A coprime stride visits every authored phrase before repeating. Keep the
 * existing seed walk for the prime-length default list and stay O(1) in bucket,
 * since a persisted run can have an arbitrarily old start time. */
function displayedPhraseIndex(seed: string, bucket: number, length: number): number {
  const offset = fnv1aUtf16(`${seed}:offset`) % length;
  let stride = length === 1 ? 0 : 1 + (fnv1aUtf16(`${seed}:stride`) % (length - 1));
  while (greatestCommonDivisor(stride, length) !== 1) {
    stride = (stride % (length - 1)) + 1;
  }
  return (offset + bucket * stride) % length;
}

class WorkingPhrase extends OpenClawLightDomContentsElement {
  @property({ type: Number }) startMs: number | null = null;
  @property() seed = "";
  @property({ attribute: false }) phrases: readonly string[] | undefined;

  private phrase: string | undefined;
  private readonly polling = new PollController(
    this,
    1_000,
    () => this.requestUpdate(),
    false,
    "visible",
  );

  override connectedCallback() {
    super.connectedCallback();
    this.syncTimer();
  }

  override updated() {
    this.syncTimer();
  }

  private syncTimer() {
    if (this.isConnected && this.startMs != null && this.phrases?.length !== 0) {
      this.polling.start();
    } else {
      this.polling.stop();
    }
  }

  override shouldUpdate(changed: PropertyValues<this>) {
    const phrase = this.currentPhrase();
    const phraseChanged = phrase !== this.phrase;
    this.phrase = phrase;
    return !this.hasUpdated || changed.size > 0 || phraseChanged;
  }

  private currentPhrase() {
    if (this.startMs == null || this.phrases?.length === 0) {
      return undefined;
    }
    const elapsed = Date.now() - this.startMs;
    if (elapsed < WORKING_PHRASE_SHOW_AFTER_MS) {
      return undefined;
    }
    const sinceShown = elapsed - WORKING_PHRASE_SHOW_AFTER_MS;
    const bucket = Math.floor(sinceShown / WORKING_PHRASE_ROTATE_EVERY_MS);
    const index = displayedPhraseIndex(
      this.seed,
      bucket,
      this.phrases?.length ?? PHRASE_KEYS.length,
    );
    return this.phrases ? this.phrases[index] : t(`chat.progressLabels.${PHRASE_KEYS[index]}`);
  }

  override render() {
    return this.phrase === undefined ? nothing : html`<span>·</span> ${this.phrase}…`;
  }
}

if (!customElements.get("openclaw-working-phrase")) {
  customElements.define("openclaw-working-phrase", WorkingPhrase);
}
