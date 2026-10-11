import type {
  ThemeAvatarHatId,
  ThemeCritterId,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { renderSolidSnapshot } from "../lit/solid-snapshot.ts";
import { AVATAR_HAT_ARTWORK } from "./theme-flair-artwork.tsx";

// Hover titles ride the pet-name tooltip channel, so no i18n surface.
export const THEME_CRITTER_TITLES: Record<ThemeCritterId, string> = {
  penguin: "on loan from the kernel",
  fedora: "a hat. nobody underneath",
};

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

// Existing Lit avatars consume inert snapshots; Solid artwork owns every shape.
export const AVATAR_HAT_SPRITES: Record<ThemeAvatarHatId, DocumentFragment> = {
  get fedora() {
    return renderSolidSnapshot(AVATAR_HAT_ARTWORK.fedora);
  },
  get crown() {
    return renderSolidSnapshot(AVATAR_HAT_ARTWORK.crown);
  },
  get santa() {
    return renderSolidSnapshot(AVATAR_HAT_ARTWORK.santa);
  },
  get party() {
    return renderSolidSnapshot(AVATAR_HAT_ARTWORK.party);
  },
  get pumpkin() {
    return renderSolidSnapshot(AVATAR_HAT_ARTWORK.pumpkin);
  },
};
