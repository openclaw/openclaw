import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";

export function PickerLabel(props: { icon: JSX.Element; label: string; summary?: string }) {
  return (
    <>
      <span class="new-session-page__target-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span class="new-session-page__trigger-label">{props.label}</span>
      {props.summary ? (
        <>
          {" "}
          <span class="new-session-page__trigger-summary">{props.summary}</span>
        </>
      ) : undefined}
      <span
        class="new-session-page__trigger-chevron new-session-page__trigger-chevron--desktop"
        aria-hidden="true"
      >
        <Icon name="chevronDown" />
      </span>
      <span
        class="new-session-page__trigger-chevron new-session-page__trigger-chevron--mobile"
        aria-hidden="true"
      >
        <Icon name="chevronsUpDown" />
      </span>
    </>
  );
}
