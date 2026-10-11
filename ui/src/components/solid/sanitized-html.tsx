import { dynamic, type JSX } from "@solidjs/web";
import { createEffect, onCleanup } from "solid-js";
import { MarkdownDomReconciler } from "../../lib/markdown-dom-reconciler.ts";

/** Render HTML already sanitized by the shared Markdown owner. */
export function SanitizedHtml(props: {
  html: string;
  tag?: "div" | "article";
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  style?: JSX.HTMLAttributes<HTMLElement>["style"];
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
}) {
  let container!: HTMLElement;
  let renderer: MarkdownDomReconciler | undefined;
  const ref = (element: HTMLElement) => {
    container = element;
  };
  // eslint-disable-next-line solid/reactivity -- Solid 2 dynamic owns the tracked tag source.
  const Container = dynamic(() => props.tag ?? "div");
  const onClick: JSX.EventHandler<HTMLElement, MouseEvent> = (event) => props.onClick?.(event);
  createEffect(
    () => props.html,
    (html) => {
      renderer ??= new MarkdownDomReconciler(container);
      renderer.updateHtml(html);
    },
  );
  onCleanup(() => renderer?.dispose());
  return <Container ref={ref} class={props.class} style={props.style} onClick={onClick} />;
}
