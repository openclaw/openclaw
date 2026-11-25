import { template, type JSX } from "@solidjs/web";

export type LobsterEyeProps = { openEyeStyle: string; closedEyeStyle: string };

export function LobsterClosedEyes(props: JSX.IntrinsicElements["g"]) {
  return (
    <g class="lob-eye-closed" fill="none" stroke="#0a1014" stroke-linecap="round" {...props}>
      {props.children}
    </g>
  );
}

// Source-owned SVG only. Clone the parsed artwork without adding a wrapper
// around sibling paths: claw animations depend on their direct parent.
export function staticSprite(markup: string): () => Node[] {
  const clone = template(`<svg>${markup}</svg>`);
  return () => Array.from(clone().childNodes);
}
