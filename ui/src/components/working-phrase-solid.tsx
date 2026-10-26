// Decorative long-wait text; the working row owns the accessible status.
import { createMemo, Show } from "solid-js";
import { registerChatComposerEnglish } from "../i18n/locales/en-chat-composer.ts";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import { t, registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { readVisibleTime } from "../lib/reactive/visible-clock.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";

registerEnglishCatalog(registerChatComposerEnglish);

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

const WORKING_PHRASE_SHOW_AFTER_MS = 30_000;
const WORKING_PHRASE_ROTATE_EVERY_MS = 45_000;

function greatestCommonDivisor(left: number, right: number): number {
  return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

type WorkingPhraseProps = {
  startMs: number | null;
  seed: string;
  phrases: readonly string[] | undefined;
};

defineSolidBridge<WorkingPhraseProps>(
  "openclaw-working-phrase",
  (props, host) => {
    host.style.display = "contents";
    const label = createMemo(() => {
      if (props.startMs == null || props.phrases?.length === 0) {
        return undefined;
      }
      const sinceShown = readVisibleTime(1_000) - props.startMs - WORKING_PHRASE_SHOW_AFTER_MS;
      if (sinceShown < 0) {
        return undefined;
      }
      const bucket = Math.floor(sinceShown / WORKING_PHRASE_ROTATE_EVERY_MS);
      const length = props.phrases?.length ?? PHRASE_KEYS.length;
      const seed = props.seed;
      // A coprime stride visits every phrase in O(1) per bucket, even for old runs.
      const offset = fnv1aUtf16(`${seed}:offset`) % length;
      let stride = length === 1 ? 0 : 1 + (fnv1aUtf16(`${seed}:stride`) % (length - 1));
      while (greatestCommonDivisor(stride, length) !== 1) {
        stride = (stride % (length - 1)) + 1;
      }
      const index = (offset + bucket * stride) % length;
      return props.phrases ? props.phrases[index] : t(`chat.progressLabels.${PHRASE_KEYS[index]}`);
    });
    return (
      <Show when={label() !== undefined}>
        <span>·</span> {label()}…
      </Show>
    );
  },
  {
    properties: {
      startMs: { default: null, type: Number },
      seed: { default: "" },
      phrases: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-working-phrase": SolidBridgeElement<WorkingPhraseProps>;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-working-phrase": HTMLAttributes<HTMLElementTagNameMap["openclaw-working-phrase"]> &
        Properties<HTMLElementTagNameMap["openclaw-working-phrase"]> & {
          "prop:phrases"?: WorkingPhraseProps["phrases"];
        };
    }
  }
}
