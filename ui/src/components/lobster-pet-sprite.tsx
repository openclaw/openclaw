import { template } from "@solidjs/web";

export type LobsterEyeProps = { openEyeStyle: string; closedEyeStyle: string };

// Source-owned SVG only. Clone the parsed artwork without adding a wrapper
// around sibling paths: claw animations depend on their direct parent.
export function staticSprite(markup: string): () => Node[] {
  const clone = template(`<svg>${markup}</svg>`);
  return () => Array.from(clone().childNodes);
}
