import { html, nothing } from "lit";

export function renderCloudWorkerAction(
  label: string,
  target: string | undefined,
  onClick: (() => void) | undefined,
  disabled: boolean,
  options: { danger?: boolean; title?: string } = {},
) {
  return onClick
    ? html`<button
        class=${options.danger ? "btn btn--sm danger" : "btn btn--sm"}
        type="button"
        aria-label=${`${label}: ${target}`}
        title=${options.title ?? nothing}
        ?disabled=${disabled}
        @click=${onClick}
      >
        ${label}
      </button>`
    : nothing;
}
