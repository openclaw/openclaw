import type { JSX } from "@solidjs/web";
import { createHoverMarquee, type MarqueeOptions } from "../hover-marquee-controller.ts";

export function HoverMarquee(props: {
  content: JSX.Element;
  class: string;
  options: MarqueeOptions;
}) {
  const marquee = createHoverMarquee(() => ({ className: props.class, ...props.options }));
  return (
    <span
      ref={marquee.labelRef}
      class={[props.class, "hover-marquee", { "hover-marquee--loop": props.options.loop }]}
      dir={props.options.loop ? "auto" : undefined}
    >
      <span ref={marquee.textRef} class="hover-marquee__text">
        {props.content}
      </span>
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
