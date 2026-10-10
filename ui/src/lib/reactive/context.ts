import { createContext, useContext } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";

/** The existing capability object; providing it never transfers owner lifetimes. */
export const ApplicationProvider = createContext<ApplicationContext>();

export function useApplication(): ApplicationContext {
  return useContext(ApplicationProvider);
}
