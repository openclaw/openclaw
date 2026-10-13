import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { personActivityLink } from "./person-activity-link.ts";

type ActivityLink = ReturnType<typeof personActivityLink>;

export function PersonName(props: { label: string; link: ActivityLink; class: string }) {
  return (
    <>
      <Show when={props.link} fallback={<span class={props.class}>{props.label}</span>}>
        <a
          class={`${props.class} person-activity-link`}
          href={props.link?.href}
          onClick={(event) => props.link?.open(event)}
        >
          {props.label}
        </a>
      </Show>
    </>
  );
}

/** Beside a named link, the duplicate avatar target stays outside keyboard and AT navigation. */
export function PersonAvatarLink(props: { children: JSX.Element; link: ActivityLink }) {
  return (
    <>
      <Show when={props.link} fallback={props.children}>
        <a
          class="person-activity-avatar-link"
          href={props.link?.href}
          tabindex="-1"
          aria-hidden="true"
          onClick={(event) => props.link?.open(event)}
        >
          {props.children}
        </a>
      </Show>
    </>
  );
}
