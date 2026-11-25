import { createContext } from "solid-js";

/** Pending media custody ends on disconnect, even when the row DOM is retained. */
export const TranscriptMediaDisconnect = createContext<Set<() => void> | null>(null);
