import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ChatDetailsDesktopSectionId } from "./chat-details-types.ts";
import "../../../styles/chat/details-desktop.css";

export type ChatDetailsDesktopSectionProps = {
  section: ChatDetailsDesktopSectionId;
  title: string;
  expanded: boolean;
  presented: boolean;
  onExpandedChange: (expanded: boolean) => void;
  metadata?: JSX.Element;
  children: JSX.Element;
};

/** Shared desktop reveal; callers retain disclosure choice and native content/chrome. */
export function createDetailsDesktopReveal(
  read: () => readonly [expanded: boolean, presented: boolean],
) {
  let disclosure!: HTMLDetailsElement;
  let body!: HTMLDivElement;
  let content!: HTMLDivElement;
  let animation: Animation | undefined;
  let ready = false;
  let keyboard = false;
  // Effect/animation callbacks must not evaluate lazy JSX prop getters without an owner.
  let presentation: readonly [expanded: boolean, presented: boolean] = [false, false];
  const finish = () => {
    animation?.cancel();
    animation = undefined;
    disclosure.open = presentation[0];
    body.style.height = "";
    body.style.overflow = "";
  };
  const transition = () => {
    const [expanded, presented] = presentation;
    const from = body.getBoundingClientRect().height;
    animation?.cancel();
    animation = undefined;
    if (!ready || !presented || keyboard) {
      keyboard = false;
      finish();
      return;
    }
    // Keep the closing body paintable until its height settles. It is already inert.
    disclosure.open = true;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const to = expanded ? content.getBoundingClientRect().height : 0;
    body.style.height = `${to}px`;
    body.style.overflow = "hidden";
    animation = body.animate(
      reduced
        ? [{ opacity: expanded ? 0 : 1 }, { opacity: expanded ? 1 : 0 }]
        : [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: reduced ? 100 : 300, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    );
    animation.onfinish = finish;
  };
  createEffect(read, (current, previous) => {
    presentation = current;
    // Presentation restores the saved choice immediately; it is not a user disclosure change.
    if (!previous || current[1] !== previous[1] || !current[1]) {
      keyboard = false;
      finish();
    } else if (current[0] !== previous[0]) {
      transition();
    }
  });
  onSettled(() => {
    ready = true;
    const resize = new ResizeObserver(() => {
      if (animation && presentation[0]) {
        transition();
      }
    });
    resize.observe(content);
    return () => resize.disconnect();
  });
  onCleanup(() => animation?.cancel());
  return {
    details: (element: HTMLDetailsElement) => {
      disclosure = element;
    },
    body: (element: HTMLDivElement) => {
      body = element;
    },
    content: (element: HTMLDivElement) => {
      content = element;
    },
    prepareClick: (event: MouseEvent) => {
      keyboard = event.detail === 0;
    },
  };
}

/** Desktop section chrome; the caller owns the choice and the leaf owns its data. */
export function ChatDetailsDesktopSection(props: ChatDetailsDesktopSectionProps) {
  const reveal = createDetailsDesktopReveal(() => [props.expanded, props.presented]);
  return (
    <details
      ref={reveal.details}
      class="chat-details-desktop-section"
      data-details-group={props.section}
      data-expanded={props.expanded ? "" : undefined}
    >
      <summary
        class="chat-details-desktop-section__heading"
        aria-expanded={props.expanded ? "true" : "false"}
        onClick={(event) => {
          event.preventDefault();
          if (props.presented) {
            reveal.prepareClick(event);
            props.onExpandedChange(!props.expanded);
          }
        }}
      >
        <span class="chat-details-desktop-section__title">{props.title}</span>
        <Icon name="chevronDown" />
        <span class="chat-details-desktop-section__metadata">{props.metadata}</span>
      </summary>
      <div
        ref={reveal.body}
        class="chat-details-desktop-section__body"
        inert={!props.expanded || !props.presented}
        aria-hidden={props.expanded ? "false" : "true"}
      >
        <div ref={reveal.content}>{props.children}</div>
      </div>
    </details>
  );
}
