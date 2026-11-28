import { getLobsterdex } from "./lobster-dex.ts";
import { loadLobsterImage } from "./lobster-image.ts";

/** Favicons use collected looks; the identity picker can use the full catalog. */
export async function loadUnlockedLobsterFavicon(
  paletteId: string,
): Promise<HTMLImageElement | null> {
  if (!getLobsterdex().has(paletteId)) {
    return null;
  }
  const image = await loadLobsterImage(paletteId);
  // Clearing the collection during decode must not revive an unavailable pick.
  return getLobsterdex().has(paletteId) ? image : null;
}
