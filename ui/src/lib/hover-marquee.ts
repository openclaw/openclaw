import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { HoverMarqueeController, type MarqueeOptions } from "./hover-marquee-controller.ts";

class HoverMarqueeDirective extends AsyncDirective {
  private readonly controller = new HoverMarqueeController();

  render(_options: MarqueeOptions, _className: string) {
    return nothing;
  }

  override update(part: ElementPart, [options, className]: [MarqueeOptions, string]) {
    this.controller.update(
      part.element instanceof HTMLElement ? part.element : undefined,
      options,
      className,
    );
    return nothing;
  }

  protected override reconnected() {
    this.controller.connect();
  }

  protected override disconnected() {
    this.controller.disconnect();
  }
}
const hoverMarquee = directive(HoverMarqueeDirective);

export function renderHoverMarquee(
  content: unknown,
  className: string,
  options: MarqueeOptions = {},
) {
  return html`<span
    class="${className} hover-marquee ${options.loop ? "hover-marquee--loop" : ""}"
    dir=${options.loop ? "auto" : nothing}
    ${hoverMarquee(options, className)}
    ><span class="hover-marquee__text">${content}</span></span
  >`;
}
