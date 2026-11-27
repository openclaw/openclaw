import { createContext } from "solid-js";

/** Reading is stricter than resource preparation; bubbles outside a transcript cannot admit reads. */
export const TranscriptReadPresentation = createContext<() => boolean>(() => false);
