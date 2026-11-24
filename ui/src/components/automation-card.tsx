import type { JSX } from "@solidjs/web";
import { Icon } from "./solid/icon.tsx";
import "./automation-card.css";

export function AutomationCard(props: { class?: string; label?: string; children: JSX.Element }) {
  return (
    <div
      class={["automation-card", props.class]}
      role={props.label ? "group" : undefined}
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

export function AutomationCardClock(props: { class?: string; tile?: boolean }) {
  return (
    <span
      class={[
        "automation-card__clock",
        props.class,
        { "automation-card__clock--tile": props.tile },
      ]}
      aria-hidden="true"
    >
      <Icon name="clock" />
    </span>
  );
}
