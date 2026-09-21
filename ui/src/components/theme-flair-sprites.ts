// Theme-contributed flair artwork: composer critters that join the ledge
// traffic beside the resident's regulars, and hats an agent avatar wears on a
// lucky page load. Portable themes reference these by catalog id; the artwork
// itself stays built in, so a theme definition never carries markup.
import { svg, type TemplateResult } from "lit";
import type {
  ThemeAvatarHatId,
  ThemeCritterId,
} from "../../../packages/gateway-protocol/src/theme.ts";

// A penguin in a red fedora. Faces right like the duck;
// the scene flips it through --lob-face for right-to-left crossings.
function renderPenguinSvg(): TemplateResult {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <ellipse cx="46" cy="99" rx="12" ry="4.5" fill="#f5921b" />
      <ellipse cx="72" cy="99" rx="12" ry="4.5" fill="#f5921b" />
      <ellipse cx="59" cy="62" rx="31" ry="39" fill="#151515" />
      <path d="M30 56 Q14 70 26 88 Q34 80 36 62 Z" fill="#151515" />
      <path d="M88 56 Q104 70 92 88 Q84 80 82 62 Z" fill="#151515" />
      <ellipse cx="60" cy="70" rx="19" ry="27" fill="#f2f2f2" />
      <ellipse cx="60" cy="40" rx="17" ry="12" fill="#f2f2f2" />
      <circle cx="52" cy="39" r="4.6" fill="#ffffff" />
      <circle cx="68" cy="39" r="4.6" fill="#ffffff" />
      <circle cx="53.5" cy="39.5" r="2.4" fill="#0a1014" />
      <circle cx="69.5" cy="39.5" r="2.4" fill="#0a1014" />
      <path d="M60 44 L79 49 L60 54 Q56 49 60 44 Z" fill="#f5921b" />
      <g transform="translate(0 3) rotate(-8 60 24)">
        <ellipse cx="60" cy="26" rx="30" ry="5.5" fill="#d40000" />
        <path d="M40 26 Q42 6 60 5 Q78 6 80 26 Z" fill="#ee0000" />
        <path d="M41 22 Q60 18 79 22 L79 26 L41 26 Z" fill="#a60000" />
        <path d="M48 9 Q60 4 72 9" stroke="#ff6b6b" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.7" />
      </g>
    </svg>
  `;
}

// A red fedora with nobody underneath. It crosses on its own, which is best
// not thought about too hard.
function renderFedoraSvg(): TemplateResult {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <ellipse cx="60" cy="82" rx="54" ry="11" fill="#d40000" />
      <path d="M26 80 Q28 30 60 26 Q92 30 94 80 Z" fill="#ee0000" />
      <path d="M52 30 Q60 24 68 30 Q64 40 60 42 Q56 40 52 30 Z" fill="#c40000" opacity="0.7" />
      <path d="M28 66 Q60 58 92 66 L92 78 Q60 72 28 78 Z" fill="#a60000" />
      <path d="M40 36 Q50 29 58 28" stroke="#ff6b6b" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.7" />
      <ellipse cx="60" cy="82" rx="54" ry="11" fill="none" stroke="#a60000" stroke-width="1.5" />
    </svg>
  `;
}

export const THEME_CRITTER_SPRITES: Record<ThemeCritterId, () => TemplateResult> = {
  penguin: renderPenguinSvg,
  fedora: renderFedoraSvg,
};

// Hover titles ride the pet-name tooltip channel, so no i18n surface.
export const THEME_CRITTER_TITLES: Record<ThemeCritterId, string> = {
  penguin: "on loan from the kernel",
  fedora: "a hat. nobody underneath",
};

// One full ledge crossing per critter; the hat is light and in a hurry.
export const THEME_CRITTER_CROSS_MS: Record<ThemeCritterId, number> = {
  penguin: 13_000,
  fedora: 9_000,
};

// Fixed sprite proportions, mirroring passerBaseStyle in lobster-pet-scene-view.ts.
export function themeCritterBaseStyle(kind: ThemeCritterId, direction: 1 | -1): string {
  const fixed: Record<ThemeCritterId, string> = {
    penguin: `--lob-scale:2;--lob-w:0.85;--lob-h:1.1;--lob-face:${direction}`,
    fedora: "--lob-scale:1.6;--lob-w:1;--lob-h:0.72;--lob-face:1",
  };
  return fixed[kind];
}

// Avatar hats overlay the top of the circular avatar; the circle's own
// overflow clip crops the crown, which reads as a hat worn, not held.
// Tilted 12°, the angle of Red Hat Display's ascenders.
export const AVATAR_HAT_SPRITES: Record<ThemeAvatarHatId, TemplateResult> = {
  fedora: svg`
    <svg class="identity-avatar__hat-svg" viewBox="0 0 100 100" aria-hidden="true">
      <g transform="rotate(-12 60 25)">
        <ellipse cx="60" cy="27" rx="27" ry="5" fill="#d40000" />
        <path d="M43 27 Q45 7 60 6 Q75 7 77 27 Z" fill="#ee0000" />
        <path d="M44 22 Q60 18 76 22 L76 27 L44 27 Z" fill="#a60000" />
        <path d="M50 10 Q60 6 70 10" stroke="#ff6b6b" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.7" />
      </g>
    </svg>
  `,
  crown: svg`
    <svg class="identity-avatar__hat-svg" viewBox="0 0 100 100" aria-hidden="true">
      <g transform="translate(60 27) rotate(-12) scale(2.2) translate(-60 -11)">
        <path d="M46 12 L46 2 L53 8 L60 0 L67 8 L74 2 L74 12 Q60 8 46 12 Z" fill="#f6c945" />
      </g>
    </svg>
  `,
  santa: svg`
    <svg class="identity-avatar__hat-svg" viewBox="0 0 100 100" aria-hidden="true">
      <g transform="translate(60 27) rotate(-12) scale(2.2) translate(-60 -10.5)">
        <g>
          <path d="M47 10 Q54 1 68 3 L72 9 Z" fill="#e0312f" />
          <circle cx="71" cy="3.5" r="3.5" fill="#f5f7fa" />
          <ellipse cx="59" cy="10.5" rx="15" ry="3.5" fill="#f5f7fa" />
        </g>
      </g>
    </svg>
  `,
  party: svg`
    <svg class="identity-avatar__hat-svg" viewBox="0 0 100 100" aria-hidden="true">
      <g transform="translate(60 27) rotate(-12) scale(2.2) translate(-60 -11)">
        <g>
          <path d="M52 11 L60 0.5 L68 11 Z" fill="#7c5cff" />
          <path d="M55.5 6.5 L64.5 6.5" stroke="#ffd166" stroke-width="2" />
          <circle cx="60" cy="1" r="2.4" fill="#ff5c8a" />
        </g>
      </g>
    </svg>
  `,
  pumpkin: svg`
    <svg class="identity-avatar__hat-svg" viewBox="0 0 100 100" aria-hidden="true">
      <g transform="translate(60 27) rotate(-12) scale(2.2) translate(-60 -12)">
        <g>
          <ellipse cx="60" cy="6.5" rx="8.5" ry="5.5" fill="#e8871e" />
          <path d="M56 2.5 Q56 6.5 56 10.5 M64 2.5 Q64 6.5 64 10.5" stroke="#c96a10" stroke-width="1.5" fill="none" />
          <path d="M60 1.5 Q60.5 0 63 0.5" stroke="#4c9a4c" stroke-width="2.5" stroke-linecap="round" fill="none" />
        </g>
      </g>
    </svg>
  `,
};
