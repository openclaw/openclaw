import type { JSX } from "@solidjs/web";
import type {
  ThemeAvatarHatId,
  ThemeCritterId,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { LOBSTER_HAT_SPRITES } from "./lobster-hat-sprites.tsx";
import { staticSprite } from "./lobster-pet-sprite.tsx";

export const THEME_CRITTER_SPRITES: Record<ThemeCritterId, () => JSX.Element> = {
  // A penguin in a red fedora. Faces right like the duck;
  // the scene flips it through --lob-face for right-to-left crossings.
  penguin: staticSprite(`
<svg class="lobster-pet__svg" viewBox="0 0 120 105" preserveAspectRatio="none" aria-hidden="true">
  <ellipse cx="46" cy="99" rx="12" ry="4.5" fill="#f5921b"></ellipse>
  <ellipse cx="72" cy="99" rx="12" ry="4.5" fill="#f5921b"></ellipse>
  <ellipse cx="59" cy="62" rx="31" ry="39" fill="#151515"></ellipse>
  <path d="M30 56 Q14 70 26 88 Q34 80 36 62 Z" fill="#151515"></path>
  <path d="M88 56 Q104 70 92 88 Q84 80 82 62 Z" fill="#151515"></path>
  <ellipse cx="60" cy="70" rx="19" ry="27" fill="#f2f2f2"></ellipse>
  <ellipse cx="60" cy="40" rx="17" ry="12" fill="#f2f2f2"></ellipse>
  <circle cx="52" cy="39" r="4.6" fill="#ffffff"></circle>
  <circle cx="68" cy="39" r="4.6" fill="#ffffff"></circle>
  <circle cx="53.5" cy="39.5" r="2.4" fill="#0a1014"></circle>
  <circle cx="69.5" cy="39.5" r="2.4" fill="#0a1014"></circle>
  <path d="M60 44 L79 49 L60 54 Q56 49 60 44 Z" fill="#f5921b"></path>
  <g transform="translate(0 3) rotate(-8 60 24)">
    <ellipse cx="60" cy="26" rx="30" ry="5.5" fill="#d40000"></ellipse>
    <path d="M40 26 Q42 6 60 5 Q78 6 80 26 Z" fill="#ee0000"></path>
    <path d="M41 22 Q60 18 79 22 L79 26 L41 26 Z" fill="#a60000"></path>
    <path d="M48 9 Q60 4 72 9" stroke="#ff6b6b" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.7"></path>
  </g>
</svg>
`),
  fedora: staticSprite(`
<svg class="lobster-pet__svg" viewBox="0 0 120 105" preserveAspectRatio="none" aria-hidden="true">
  <ellipse cx="60" cy="82" rx="54" ry="11" fill="#d40000"></ellipse>
  <path d="M26 80 Q28 30 60 26 Q92 30 94 80 Z" fill="#ee0000"></path>
  <path d="M52 30 Q60 24 68 30 Q64 40 60 42 Q56 40 52 30 Z" fill="#c40000" opacity="0.7"></path>
  <path d="M28 66 Q60 58 92 66 L92 78 Q60 72 28 78 Z" fill="#a60000"></path>
  <path d="M40 36 Q50 29 58 28" stroke="#ff6b6b" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.7"></path>
  <ellipse cx="60" cy="82" rx="54" ry="11" fill="none" stroke="#a60000" stroke-width="1.5"></ellipse>
</svg>
`),
};

// Avatar hats overlay the top of the circular avatar; the circle's own
// overflow clip crops the crown, which reads as a hat worn, not held.
// Tilted 12°, the angle of Red Hat Display's ascenders.
function avatarLobsterHat(hat: keyof typeof LOBSTER_HAT_SPRITES, brimY: number) {
  return (
    <svg class="identity-avatar__hat-svg" viewBox="0 0 100 100" aria-hidden="true">
      <g transform={`translate(60 27) rotate(-12) scale(2.2) translate(-60 ${-brimY})`}>
        {LOBSTER_HAT_SPRITES[hat]()}
      </g>
    </svg>
  );
}

export const AVATAR_HAT_ARTWORK: Record<ThemeAvatarHatId, () => JSX.Element> = {
  fedora: staticSprite(`
<svg class="identity-avatar__hat-svg" viewBox="0 0 100 100" aria-hidden="true">
  <g transform="rotate(-12 60 25)">
    <ellipse cx="60" cy="27" rx="27" ry="5" fill="#d40000"></ellipse>
    <path d="M43 27 Q45 7 60 6 Q75 7 77 27 Z" fill="#ee0000"></path>
    <path d="M44 22 Q60 18 76 22 L76 27 L44 27 Z" fill="#a60000"></path>
    <path d="M50 10 Q60 6 70 10" stroke="#ff6b6b" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.7"></path>
  </g>
</svg>
`),
  crown: () => avatarLobsterHat("crown", 11),
  santa: () => avatarLobsterHat("santa", 10.5),
  party: () => avatarLobsterHat("party", 11),
  pumpkin: () => avatarLobsterHat("pumpkin", 12),
};

// Hover titles ride the pet-name tooltip channel, so no i18n surface.
export const THEME_CRITTER_TITLES: Record<ThemeCritterId, string> = {
  penguin: "on loan from the kernel",
  fedora: "a hat. nobody underneath",
};

// Fixed sprite proportions, mirroring passerBaseStyle in lobster-pet-scene-view.ts.
export function themeCritterBaseStyle(kind: ThemeCritterId, direction: 1 | -1): string {
  const fixed: Record<ThemeCritterId, string> = {
    penguin: `--lob-scale:2;--lob-w:0.85;--lob-h:1.1;--lob-face:${direction}`,
    fedora: "--lob-scale:1.6;--lob-w:1;--lob-h:0.72;--lob-face:1",
  };
  return fixed[kind];
}
