import { createMemo, For } from "solid-js";
import { PersonReferenceLabel } from "../../../components/solid/person-reference-label.tsx";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";

/** Paint only: the textarea remains the sole text, selection, clipboard and IME owner. */
export function ComposerMentionLayer(props: {
  text: string;
  mentions: readonly HumanMention[];
  dir: "ltr" | "rtl";
  capture: (node: HTMLDivElement) => (() => void) | void;
}) {
  const layerRef = elementRef<HTMLDivElement>((node) => props.capture(node));
  const parts = createMemo(() => {
    const result: { text: string; mention?: HumanMention }[] = [];
    let offset = 0;
    for (const mention of props.mentions) {
      result.push({ text: props.text.slice(offset, mention.start) });
      result.push({ text: props.text.slice(mention.start, mention.end), mention });
      offset = mention.end;
    }
    result.push({ text: props.text.slice(offset) });
    return result;
  });
  return (
    <div class="chat-composer-mention-layer" aria-hidden="true" dir={props.dir} ref={layerRef}>
      <For each={parts()}>
        {(part) =>
          part.mention ? (
            <span
              class="markdown-person-reference chat-composer-mention"
              data-profile-id={part.mention.profileId}
            >
              <PersonReferenceLabel
                profileId={part.mention.profileId}
                label={part.text}
                literalPrefix={true}
              />
            </span>
          ) : (
            part.text
          )
        }
      </For>
      {"\u200b"}
    </div>
  );
}

/** The scroll event does not bubble: bind it to the native field, not a delegated JSX handler. */
export function createComposerMentionLayerBinding(getInput: () => HTMLTextAreaElement | undefined) {
  let layer: HTMLDivElement | undefined;
  const sync = () => {
    const input = getInput();
    if (layer?.isConnected && input?.isConnected) {
      if (input.clientWidth && input.clientHeight) {
        layer.style.width = `${input.clientWidth}px`;
        layer.style.height = `${input.clientHeight}px`;
      }
      layer.scrollTop = input.scrollTop;
      layer.scrollLeft = input.scrollLeft;
    }
  };
  createResizeObserver(() => {
    const input = getInput();
    return input ? [input] : [];
  }, sync);
  return {
    inputRef: elementRef<HTMLTextAreaElement>((node) => listen(node, "scroll", sync)),
    capture: (node: HTMLDivElement) => {
      layer = node;
      sync();
      return () => {
        if (layer === node) {
          layer = undefined;
        }
      };
    },
  };
}
