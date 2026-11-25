import { createContext, type Accessor } from "solid-js";

/** Retained views keep their DOM while foreground work is paused. */
export const ContentPresentation = createContext<Accessor<boolean>>(() => true);
