import { html, svg } from "lit";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";

const silhouettes = [
  "M6 15V5l8 5h4l8-5v10a10 10 0 0 1-20 0Z",
  "M8 12C1 5 10 1 13 10h6c3-9 12-5 5 2a10 10 0 1 1-16 0Z",
  "M8 12V5a3 3 0 0 1 6 0v5h4V5a3 3 0 0 1 6 0v7a10 10 0 1 1-16 0Z",
  "M7 10h18v11a9 9 0 0 1-18 0Zm-3 2h3v9H4Zm21 0h3v9h-3ZM15 4h2v6h-2Z",
  "M6 17a10 11 0 0 1 20 0v9l-5-2-5 3-5-3-5 2Z",
  "M5 14 9 6l7 4 7-4 4 8-3 10-8 5-8-5Z",
  "M6 17a10 10 0 0 1 20 0v2a10 10 0 0 1-20 0Z",
] as const;
const hues = [8, 32, 48, 82, 142, 174, 202, 232, 272, 322] as const;

/** Fixed geometry and palette keep the same identity legible at small sizes. */
export function renderAgentAvatarFace(agentId: string) {
  const seed = fnv1aUtf16(agentId);
  const silhouette = silhouettes[seed % silhouettes.length];
  const hue = hues[Math.floor(seed / silhouettes.length) % hues.length];
  return html`<svg
    class="identity-avatar__agent-face"
    viewBox="0 0 32 32"
    width="100%"
    height="100%"
    aria-hidden="true"
  >
    ${svg`<rect width="32" height="32" rx="9" fill=${`hsl(${hue} 65% 90%)`} />
      <path d=${silhouette} fill=${`hsl(${hue} 58% 62%)`} />
      <g fill=${`hsl(${hue} 55% 18%)`}>
        <circle cx="12" cy="17" r="1.5" /><circle cx="20" cy="17" r="1.5" />
      </g>
      <path d="M13 22q3 3 6 0" fill="none" stroke=${`hsl(${hue} 55% 18%)`} stroke-width="1.5" stroke-linecap="round" />`}
  </svg>`;
}
