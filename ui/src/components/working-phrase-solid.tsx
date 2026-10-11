// Decorative long-wait text; the working row owns the accessible status.
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import { t } from "../lib/reactive/i18n.ts";
import { useVisiblePoll } from "../lib/reactive/visible-poll.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";

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
  let divisor = left;
  let remainder = right;
  while (remainder !== 0) {
    [divisor, remainder] = [remainder, divisor % remainder];
  }
  return divisor;
}

// A coprime stride visits every phrase in O(1) per bucket, even for old runs.
function displayedPhraseIndex(seed: string, bucket: number, length: number): number {
  const offset = fnv1aUtf16(`${seed}:offset`) % length;
  let stride = length === 1 ? 0 : 1 + (fnv1aUtf16(`${seed}:stride`) % (length - 1));
  while (greatestCommonDivisor(stride, length) !== 1) {
    stride = (stride % (length - 1)) + 1;
  }
  return (offset + bucket * stride) % length;
}

export const WorkingPhrase = defineSolidBridge<{
  startMs: number | null;
  seed: string;
  phrases: readonly string[] | undefined;
}>(
  "openclaw-working-phrase",
  (props, host) => {
    host.style.display = "contents";
    const [tick, setTick] = createSignal(0);
    const polling = useVisiblePoll(1_000, () => setTick((value) => value + 1));
    createEffect(
      () => props.startMs != null && props.phrases?.length !== 0,
      (ticking) => {
        if (ticking) {
          polling.start();
        } else {
          polling.stop();
        }
      },
    );
    const label = createMemo(() => {
      tick();
      if (props.startMs == null || props.phrases?.length === 0) {
        return undefined;
      }
      const sinceShown = Date.now() - props.startMs - WORKING_PHRASE_SHOW_AFTER_MS;
      if (sinceShown < 0) {
        return undefined;
      }
      const bucket = Math.floor(sinceShown / WORKING_PHRASE_ROTATE_EVERY_MS);
      const length = props.phrases?.length ?? PHRASE_KEYS.length;
      const index = displayedPhraseIndex(props.seed, bucket, length);
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
