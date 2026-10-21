import type { JSX } from "@solidjs/web";
import { onCleanup } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
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
  let keyboard = false;
  // Layout callbacks consume the prepared snapshot without evaluating lazy JSX props.
  let presentation: readonly [expanded: boolean, presented: boolean] | undefined;
  const finish = () => {
    animation?.cancel();
    animation = undefined;
    disclosure.open = presentation?.[0] ?? false;
    body.style.height = "";
    body.style.overflow = "";
  };
  createLayoutMeasurement(
    read,
    (current) => {
      if (!current) {
        return undefined;
      }
      const previous = presentation;
      presentation = current;
      const [expanded, presented] = current;
      // Restore presentation and keyboard access before the next paint.
      if (!previous || presented !== previous[1] || !presented || keyboard) {
        keyboard = false;
        return finish;
      }
      if (expanded === previous[0] && !(animation && expanded)) {
        return undefined;
      }
      // Closed details still reports its hidden body's intrinsic height.
      // Read visible in-flight geometry only while the native disclosure is open.
      const from = disclosure.open ? body.getBoundingClientRect().height : 0;
      // Native details must expose its content before measuring the opening destination.
      if (expanded) {
        disclosure.open = true;
      }
      const to = expanded ? content.getBoundingClientRect().height : 0;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      return () => {
        animation?.cancel();
        // Keep the closing body paintable until its height settles. It is already inert.
        disclosure.open = true;
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
    },
    { targets: () => [content], changeTiming: "sync" },
  );
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
