import type { JSX } from "@solidjs/web";
import { Show, createSignal } from "solid-js";
import type { ApplicationContext } from "../app/context-types.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { normalizeApplicationContext } from "./application-context-fixtures.ts";

export {
  createApplicationGateway,
  hiddenScopeUpgradeCapability,
} from "./application-context-fixtures.ts";

export function createSolidApplicationContextProvider(initial: ApplicationContext) {
  const [context, setContext] = createSignal(normalizeApplicationContext(initial));
  return {
    setContext(value: ApplicationContext) {
      setContext(normalizeApplicationContext(value));
    },
    wrapper(this: void, props: { children: JSX.Element }) {
      // Solid's context is owner-scoped; replacing it retires the old consumer tree.
      return (
        <Show when={context()} keyed>
          {(value) => <ApplicationProvider value={value}>{props.children}</ApplicationProvider>}
        </Show>
      );
    },
  };
}
