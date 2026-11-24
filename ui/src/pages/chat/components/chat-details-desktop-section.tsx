import type { JSX } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import { animateDetailsSection } from "../../../components/details-section-motion.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import type { ChatDetailsDesktopSectionId } from "./chat-details-types.ts";
import "../../../styles/chat/details-desktop.css";

/** First data arrival shares one entrance and focus/reduced-motion cleanup owner. */
export function animateDetailsDesktopEntrance(shell: HTMLElement) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const height = shell.getBoundingClientRect().height;
  shell.style.overflow = "clip";
  const animation = shell.animate(
    reduced.matches
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { height: "0px", opacity: 0 },
          { height: `${height}px`, opacity: 1 },
        ],
    {
      duration: reduced.matches ? 100 : 200,
      easing: getComputedStyle(shell).getPropertyValue("--ease-out").trim(),
    },
  );
  const finish = () => {
    animation.cancel();
    shell.style.overflow = "";
  };
  animation.onfinish = finish;
  const stopMotion = listen(reduced, "change", finish);
  const stopFocus = listen(shell, "focusin", finish);
  return () => {
    animation.cancel();
    stopMotion();
    stopFocus();
  };
}

/** Shared desktop reveal; callers retain disclosure choice and native content/chrome. */
export function createDetailsDesktopReveal(
  read: () => readonly [expanded: boolean, presented: boolean, animateContentResize?: boolean],
  onMotionChange?: (active: boolean) => void,
) {
  let disclosure!: HTMLDetailsElement;
  let body!: HTMLDivElement;
  let content!: HTMLDivElement;
  let animation: Animation | undefined;
  let keyboard = false;
  let destination: number | undefined;
  // Layout callbacks consume the prepared snapshot without evaluating lazy JSX props.
  let presentation:
    | readonly [expanded: boolean, presented: boolean, animateContentResize?: boolean]
    | undefined;
  const finish = () => {
    animation?.cancel();
    animation = undefined;
    onMotionChange?.(false);
    disclosure.open = presentation?.[0] ?? false;
    // Keep new content clipped to the last measured size until its resize is scheduled.
    const retainHeight =
      presentation?.[0] && presentation?.[1] && (presentation?.[2] || destination === 0);
    const height = retainHeight ? destination : undefined;
    body.style.height = height === undefined ? "" : `${height}px`;
    body.style.overflow = retainHeight ? "hidden" : "";
    body.style.opacity = presentation?.[0] ? "1" : "0";
    body.style.marginTop = presentation?.[0] ? "2px" : "0px";
  };
  createLayoutMeasurement(
    read,
    (current) => {
      if (!current) {
        return undefined;
      }
      const previous = presentation;
      presentation = current;
      const [expanded, presented, animateContentResize] = current;
      const resizingContent =
        expanded && presented && (animateContentResize || destination === 0 || Boolean(animation));
      // Restore presentation and keyboard access before the next paint.
      if (!previous || presented !== previous[1] || !presented || keyboard) {
        keyboard = false;
        if (resizingContent) {
          disclosure.open = true;
          destination = content.getBoundingClientRect().height;
        } else {
          destination = undefined;
        }
        return finish;
      }
      if (expanded === previous[0] && !resizingContent) {
        return undefined;
      }
      // Closed details still reports its hidden body's intrinsic height.
      // Read visible in-flight geometry only while the native disclosure is open.
      const from = disclosure.open
        ? !animation && expanded === previous[0]
          ? (destination ?? body.getBoundingClientRect().height)
          : body.getBoundingClientRect().height
        : 0;
      const style = getComputedStyle(body);
      const fromOpacity = disclosure.open ? style.opacity : "0";
      const fromMargin = disclosure.open ? style.marginTop : "0px";
      // Native details must expose its content before measuring the opening destination.
      if (expanded) {
        disclosure.open = true;
      }
      const to = expanded ? content.getBoundingClientRect().height : 0;
      if (expanded === previous[0] && to === destination) {
        return undefined;
      }
      destination = to;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (resizingContent && expanded === previous[0] && reduced) {
        return finish;
      }
      return () => {
        animation?.cancel();
        // Keep the closing body paintable until its height settles. It is already inert.
        disclosure.open = true;
        body.style.height = `${to}px`;
        body.style.overflow = "hidden";
        body.style.opacity = expanded ? "1" : "0";
        body.style.marginTop = expanded ? "2px" : "0px";
        onMotionChange?.(true);
        const revealAnimation = animateDetailsSection(body, {
          from: { height: from, opacity: fromOpacity, marginTop: fromMargin },
          height: to,
          expanded,
          reduced,
        });
        animation = revealAnimation;
        revealAnimation.onfinish = () => {
          if (animation === revealAnimation) {
            finish();
          }
        };
      };
    },
    { targets: () => [content], changeTiming: "sync" },
  );
  onSettled(() => () => {
    animation?.cancel();
    onMotionChange?.(false);
  });
  return {
    finishOnFocus: () => {
      if (!presentation?.[2]) {
        return;
      }
      if (presentation[0] && presentation[1]) {
        destination = content.getBoundingClientRect().height;
      }
      finish();
    },
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
export function ChatDetailsDesktopSection(props: {
  section: ChatDetailsDesktopSectionId;
  title: string;
  expanded: boolean;
  presented: boolean;
  animateContentResize?: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onRevealMotionChange?: (active: boolean) => void;
  metadata?: JSX.Element;
  children: JSX.Element;
}) {
  // Closed sections need only their heading; retain content after its first reveal.
  const [contentMounted] = createSignal((previous = false) => previous || props.expanded);
  const reveal = createDetailsDesktopReveal(
    () => [props.expanded, props.presented, props.animateContentResize],
    (active) => props.onRevealMotionChange?.(active),
  );
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
        onFocusIn={reveal.finishOnFocus}
        inert={!props.expanded || !props.presented}
        aria-hidden={props.expanded ? "false" : "true"}
      >
        <div ref={reveal.content}>
          <Show when={contentMounted()}>{props.children}</Show>
        </div>
      </div>
    </details>
  );
}
