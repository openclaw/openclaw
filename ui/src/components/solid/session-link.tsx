import { onSettled } from "solid-js";
import type { ChatRowDisplay } from "../../lib/chat/row-display-facts.ts";
import { registerSessionTitleTarget } from "../markdown-link-display.ts";

export function SessionLink(props: {
  sessionKey?: string;
  label: string;
  titled?: boolean;
  agent?: boolean;
  href?: string;
  display?: ChatRowDisplay;
  onOpen?: () => void;
}) {
  let target: HTMLAnchorElement;
  let label: HTMLSpanElement;
  onSettled(() => registerSessionTitleTarget(target, label, props.display));
  return (
    <a
      ref={(element) => (target = element)}
      class={[
        "markdown-session-link",
        {
          "markdown-session-link--titled": props.titled,
          "markdown-session-link--agent": props.agent,
        },
      ]}
      role="link"
      tabindex="0"
      data-session-key={props.sessionKey}
      href={props.href}
      onClick={(event) => {
        if (props.onOpen && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          props.onOpen();
        }
      }}
      onKeyDown={(event) => {
        if (
          props.onOpen &&
          event.key === " " &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          props.onOpen();
        }
      }}
    >
      <span ref={(element) => (label = element)} class="session-label" textContent={props.label} />
    </a>
  );
}
