import { createSignal, onSettled } from "solid-js";
import { listen } from "./listener.ts";

/** A browser capability that follows changes and releases its listener with the owner. */
export function createMediaQuery(query: string, fallback = false) {
  const [matches, setMatches] = createSignal(fallback);
  onSettled(() => {
    const media = window.matchMedia?.(query);
    if (!media) {
      return undefined;
    }
    const update = () => setMatches(media.matches);
    update();
    return listen(media, "change", update);
  });
  return matches;
}

/** Whether the document can present work; refresh on setup in case it changed before settlement. */
export function createDocumentVisibility() {
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden");
  onSettled(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    return listen(document, "visibilitychange", update);
  });
  return visible;
}
