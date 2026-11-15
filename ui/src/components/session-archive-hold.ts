import { listen } from "../lib/reactive/listener.ts";

type HeldArchive = { readonly keys: readonly string[]; settle(commit: boolean): void };

// Archives inside their Undo window. Kept outside the lazy archive runtime so an open
// conversation can offer the same Undo synchronously.
const heldArchives = new Set<HeldArchive>();
const listeners = new Set<() => void>();
let commitsOnPageHide = false;

const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};

export function holdArchive(archive: HeldArchive): () => void {
  heldArchives.add(archive);
  notify();
  if (!commitsOnPageHide) {
    commitsOnPageHide = true;
    listen(globalThis, "pagehide", () => {
      // Each commit removes only itself, which Set iteration tolerates.
      for (const entry of heldArchives) {
        entry.settle(true);
      }
    });
  }
  return () => {
    heldArchives.delete(archive);
    notify();
  };
}

/** Held archives start without a session-roster publish when their window closes. */
export function subscribeHeldArchives(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const heldArchiveFor = (key: string) =>
  [...heldArchives].find((archive) => archive.keys.includes(key));

/** True while the archive including this session can still be cancelled. */
export function isArchiveHeld(key: string): boolean {
  return heldArchiveFor(key) !== undefined;
}

/** Undo from outside the notice: cancels the held archive that includes this session. */
export function undoHeldArchive(key: string): void {
  heldArchiveFor(key)?.settle(false);
}
