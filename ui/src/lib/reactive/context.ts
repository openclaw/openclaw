import { ContextNotFoundError } from "@solidjs/signals";
import { createContext, useContext } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";

/** The existing capability object; providing it never transfers owner lifetimes. */
export const ApplicationProvider = createContext<ApplicationContext>();

export function useApplication(): ApplicationContext {
  return useContext(ApplicationProvider);
}

/** Standalone leaves can render without application-owned capabilities. */
export function useOptionalApplication(): ApplicationContext | undefined {
  try {
    return useApplication();
  } catch (error) {
    if (!(error instanceof ContextNotFoundError)) {
      throw error;
    }
    return undefined;
  }
}
