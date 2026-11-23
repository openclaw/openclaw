import { onTestFinished, vi } from "vitest";
import type {
  ControlUiAccessoryRegistration,
  ControlUiComposerDecorationProps,
  ControlUiHost,
} from "../../../src/plugin-sdk/control-ui.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createInertViewHost } from "../plugins/control-ui-view.test-support.ts";

/** Tests the host boundary without reintroducing the retired lobster custom-element API. */
export function accessoryFixture(
  accessories: ControlUiAccessoryRegistration[],
  host?: ControlUiHost,
) {
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  let revision = 0;
  const publish = () => {
    revision++;
    for (const listener of listeners) {
      listener();
    }
  };
  const entries = accessories.map((value) => ({
    key: "fixture/" + value.id,
    pluginId: "fixture",
    value,
    host: host ?? createInertViewHost(abort.signal),
    signal: abort.signal,
  }));
  // SAFETY: unit consumers use only this registry projection; asset admission is exercised in native-bundle E2E.
  const plugins = {
    get revision() {
      return revision;
    },
    registrations: (kind: string) => (kind === "accessories" ? entries : []),
    selectedReplacement: () => undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportError: vi.fn((_: string, error: unknown) => {
      throw error;
    }),
  } as unknown as ApplicationContext["plugins"];
  onTestFinished(() => {
    abort.abort();
    listeners.clear();
  });
  return {
    plugins,
    publish,
    retire: () => {
      abort.abort();
      entries.length = 0;
      publish();
    },
  };
}

export type ComposerDecorationProbe = HTMLElement & { value: ControlUiComposerDecorationProps };
export function installComposerDecorationProbe(context: ApplicationContext) {
  const fixture = accessoryFixture([
    {
      id: "visitors",
      placement: "composer-decoration",
      mount(container, initial) {
        const element = Object.assign(document.createElement("div"), { value: initial.props });
        element.dataset.composerDecorationProbe = "";
        container.append(element);
        return {
          update(next) {
            element.value = next.props;
          },
          dispose() {
            element.remove();
          },
        };
      },
    },
  ]);
  Object.assign(context, { plugins: fixture.plugins });
  return fixture;
}
