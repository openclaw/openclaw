import { render } from "@solidjs/web";
import { createComponent, createSignal, flush } from "solid-js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { normalizeApplicationContext } from "./application-context-fixtures.ts";
import { trackSolidRoot } from "./solid-cleanup.ts";

export {
  createApplicationGateway,
  createNavigationPreferencesFixture,
  hiddenScopeUpgradeCapability,
} from "./application-context-fixtures.ts";

type ContextCallback = (value: ApplicationContext, unsubscribe?: () => void) => void;
/** Plain-DOM fixture for callers still crossing the application context bridge. */
export function requestApplicationContext(
  host: Element,
  callback: ContextCallback,
  subscribe = false,
) {
  host.dispatchEvent(
    Object.assign(new Event("context-request", { bubbles: true, composed: true }), {
      context: applicationContext,
      contextTarget: host,
      callback,
      subscribe,
    }),
  );
}

export function createApplicationContextProvider(context: ApplicationContext) {
  const host = document.createElement("div");
  const [value, setValue] = createSignal(normalizeApplicationContext(context));
  const dispose = render(
    () =>
      createComponent(ApplicationProvider, {
        host,
        get value() {
          return value();
        },
      }),
    document.createDocumentFragment(),
  );
  trackSolidRoot(dispose);
  return Object.assign(host, {
    setContext: (next: ApplicationContext) => {
      setValue(normalizeApplicationContext(next));
      flush();
    },
  });
}

export type ApplicationContextProvider = ReturnType<typeof createApplicationContextProvider>;
