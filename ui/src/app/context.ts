import type { ApplicationContext } from "./context-types.ts";

export type * from "./context-types.ts";

/** Native custom elements request the Solid provider at their DOM boundary. */
export const applicationContext = "openclaw.application";

export type ApplicationContextRequest = Event & {
  context: typeof applicationContext;
  contextTarget: HTMLElement;
  subscribe?: boolean;
  callback: (value: ApplicationContext, unsubscribe?: () => void) => void;
};
