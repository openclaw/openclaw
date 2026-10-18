import { html, svg } from "lit";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";

const hues = [8, 32, 48, 82, 142, 174, 202, 232, 272, 322] as const;

/** The agent ID keeps every feature stable across clients and render order. */
export function renderAgentAvatarFace(agentId: string) {
  const seed = fnv1aUtf16(agentId);
  const hue = hues[seed % hues.length];
  const color = `hsl(${hue} 58% 62%)`;
  const pale = `hsl(${hue} 65% 90%)`;
  const ink = `hsl(${hue} 55% 18%)`;
  const eyes = [
    svg`<circle cx="11" cy="13.5" r="1.6" /><circle cx="21" cy="13.5" r="1.6" />`,
    svg`<ellipse cx="11" cy="13" rx="1.5" ry="2" /><ellipse cx="21" cy="13" rx="1.5" ry="2" />`,
    svg`<path d="M9 14q2-3 4 0m6 0q2-3 4 0" fill="none" stroke=${ink} stroke-width="1.6" stroke-linecap="round" />`,
    svg`<rect x="6.5" y="9" width="19" height="9.5" rx="4.75" />
      <g fill=${pale}><rect x="10.5" y="12" width="2.5" height="3.5" rx="1.25" /><rect x="19" y="12" width="2.5" height="3.5" rx="1.25" /></g>`,
  ];
  const mouths = [
    svg`<path d="M11.5 20q4.5 4.5 9 0" fill="none" stroke=${ink} stroke-width="1.6" stroke-linecap="round" />`,
    svg`<path d="M11 19q5 1.5 10 0c-.5 4.5-3 6-5 6s-4.5-1.5-5-6Z" />
      <path d="M13.5 23q2.5-2 5 0-2.5 2-5 0Z" fill=${pale} />`,
    svg`<path d="M12 22q5 2 8-1" fill="none" stroke=${ink} stroke-width="1.6" stroke-linecap="round" />`,
    svg`<path d="M13.5 22.5h5" fill="none" stroke=${ink} stroke-width="1.6" stroke-linecap="round" />`,
  ];
  // Consume separate digits so palette and expression can vary independently.
  const eyeSeed = Math.floor(seed / hues.length);
  const mouthSeed = Math.floor(eyeSeed / eyes.length);
  const pastel = Math.floor(mouthSeed / mouths.length) % 2 === 1;
  return html`<svg
    class="identity-avatar__agent-face"
    viewBox="0 0 32 32"
    width="100%"
    height="100%"
    aria-hidden="true"
  >
    ${svg`<circle cx="16" cy="16" r="16" fill=${pastel ? pale : color} />
      <g fill=${ink}>${eyes[eyeSeed % eyes.length]}${mouths[mouthSeed % mouths.length]}</g>`}
  </svg>`;
}
