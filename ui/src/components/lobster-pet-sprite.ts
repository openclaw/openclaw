import { svg, type SVGTemplateResult } from "lit";

export function passerSprite(content: SVGTemplateResult): SVGTemplateResult {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      ${content}
    </svg>
  `;
}
