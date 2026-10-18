import { template, type JSX } from "@solidjs/web";

export type LobsterEyeProps = { openEyeStyle: string; closedEyeStyle: string };

// Source-owned SVG only. Clone the parsed artwork without adding a wrapper
// around sibling paths: claw animations depend on their direct parent.
export function staticSprite(markup: string): () => Node[] {
  const clone = template(`<svg>${markup}</svg>`);
  return () => Array.from(clone().childNodes);
}

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
