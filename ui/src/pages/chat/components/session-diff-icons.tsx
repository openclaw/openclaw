import { Show } from "solid-js";

/** Approved Tabler eye-code glyph; kept local until the shared icon owner exports it. */
export function SessionDiffOpenIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" />
      <path d="M11.11 17.958c-3.209 -.307 -5.91 -2.293 -8.11 -5.958c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6c-.21 .352 -.427 .688 -.647 1.008" />
      <path d="M20 21l2 -2l-2 -2" />
      <path d="M17 17l-2 2l2 2" />
    </svg>
  );
}

export function SessionDiffActionIcon(icon: { action: "jump" | "expand" | "collapse" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Show
        when={icon.action === "jump"}
        fallback={
          <>
            <path d="M3 5h8M3 12h8M3 19h8" />
            <path
              d={
                icon.action === "collapse"
                  ? "m15 5 3 3 3-3m-6 14 3-3 3 3"
                  : "m15 8 3-3 3 3m-6 8 3 3 3-3"
              }
            />
          </>
        }
      >
        <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
        <path d="M14 2v5a1 1 0 0 0 1 1h5" />
        <circle cx="11.5" cy="14.5" r="2.5" />
        <path d="M13.3 16.3 15 18" />
      </Show>
    </svg>
  );
}

export function SessionDiffScopeIcon(props: { action: "uncommitted" | "commit" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Show
        when={props.action === "commit"}
        fallback={
          <>
            <circle cx="5" cy="6" r="3" />
            <path d="M12 6h5a2 2 0 0 1 2 2v7m-4-6-3-3 3-3" />
            <circle cx="19" cy="18" r="3" />
            <path d="M12 18H7a2 2 0 0 1-2-2V9m4 6 3 3-3 3" />
          </>
        }
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M3 12h6m6 0h6" />
      </Show>
    </svg>
  );
}
export function SessionDiffEditorIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M10 4v4M2 8h20M6 4v4" />
    </svg>
  );
}
export function SessionDiffCollapseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m7 20 5-5 5 5m-10-16 5 5 5-5" />
    </svg>
  );
}
