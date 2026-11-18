import { createContext } from "solid-js";

/** A prepared/forecast row may mount resources but has not been shown to the reader. */
export const TranscriptReadPresentation = createContext<() => boolean>(() => false);
