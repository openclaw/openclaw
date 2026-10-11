import type { JSX } from "@solidjs/web";

export type LobsterEyeProps = { openEyeStyle: string; closedEyeStyle: string };

export function PasserSprite(props: { children: JSX.Element }) {
  return (
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}
