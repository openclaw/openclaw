import { dynamic, type JSX } from "@solidjs/web";
import { untrack } from "solid-js";

/** Only accepts HTML escaped or sanitized by the caller's content owner. */
export function SanitizedHtml(props: {
  html: string;
  tag?: "article" | "code" | "div";
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  style?: JSX.HTMLAttributes<HTMLElement>["style"];
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
}) {
  const tag = untrack(() => props.tag ?? "div");
  const Container = dynamic(() => tag);
  return (
    <Container
      class={props.class}
      style={props.style}
      onClick={props.onClick}
      // eslint-disable-next-line solid/no-innerhtml -- Content is escaped or sanitized by the caller's canonical owner.
      innerHTML={props.html}
    />
  );
}
