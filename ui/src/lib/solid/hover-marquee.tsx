import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup } from "solid-js";
import { HoverMarqueeController, type MarqueeOptions } from "../hover-marquee-controller.ts";

export function HoverMarquee(props: {
  content: JSX.Element;
  class: string;
  options: MarqueeOptions;
}) {
  let label: HTMLSpanElement | undefined;
  const controller = new HoverMarqueeController();
  createEffect(
    () => ({ className: props.class, ...props.options }),
    (options) => {
      controller.update(label, options, options.className);
      controller.connect();
    },
  );
  onCleanup(() => controller.disconnect());
  return (
    <span
      ref={(element) => {
        label = element;
      }}
      class={[props.class, "hover-marquee", { "hover-marquee--loop": props.options.loop }]}
      dir={props.options.loop ? "auto" : undefined}
    >
      <span class="hover-marquee__text">{props.content}</span>
    </span>
  );
}

export function renderHoverMarquee(
  content: JSX.Element,
  className: string,
  options: MarqueeOptions = {},
): JSX.Element {
  return <HoverMarquee content={content} class={className} options={options} />;
}
