import type { ThemeAvatarHatId } from "../../../packages/gateway-protocol/src/theme.ts";
import { renderSolidSnapshot } from "../lit/solid-snapshot.ts";
import { AVATAR_HAT_ARTWORK } from "./theme-flair-artwork.tsx";

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
