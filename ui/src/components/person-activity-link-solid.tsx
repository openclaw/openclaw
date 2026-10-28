import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { personActivityLink } from "./person-activity-link.ts";

type ActivityLink = ReturnType<typeof personActivityLink>;

export function PersonName(props: {
  label: string;
  link: ActivityLink;
  class: string;
  ref?: (element: HTMLAnchorElement) => void;
}) {
  return (
    <Show when={props.link} fallback={<span class={props.class}>{props.label}</span>}>
      <a
        ref={props.ref}
        class={[props.class, "person-activity-link"]}
        href={props.link?.href}
        onClick={(event) => props.link?.open(event)}
      >
        {props.label}
      </a>
    </Show>
  );
}

/** Standalone avatars are navigation targets; named-link siblings stay outside keyboard and AT. */
export function PersonAvatarLink(props: {
  children: JSX.Element;
  link: ActivityLink;
  standalone?: boolean;
}) {
  return (
    <Show when={props.link} fallback={props.children}>
      <a
        class="person-activity-avatar-link"
        href={props.link?.href}
        tabindex={props.standalone ? undefined : "-1"}
        aria-hidden={props.standalone ? undefined : "true"}
        onClick={(event) => props.link?.open(event)}
      >
        {props.children}
      </a>
    </Show>
  );
}
