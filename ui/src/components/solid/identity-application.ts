import { ContextNotFoundError } from "@solidjs/signals";
import { useApplication } from "../../lib/reactive/context.ts";

/** Identity chrome also renders in standalone cards without an application provider. */
export function useIdentityApplication() {
  try {
    return useApplication();
  } catch (error) {
    if (error instanceof ContextNotFoundError) {
      return undefined;
    }
    throw error;
  }
}
