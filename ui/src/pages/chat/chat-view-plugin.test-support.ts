import { onTestFinished, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiReplacement,
  ControlUiSurface,
} from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";

export function createPluginFixture<S extends ControlUiSurface>(
  pluginId: string,
  replacements: readonly ControlUiReplacement<S>[],
  initiallySelected = true,
) {
  const lifetime = new AbortController();
  const host = {
    signal: lifetime.signal,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  const registrations = replacements.map((value) => ({
    key: `${pluginId}/${value.id}`,
    pluginId,
    signal: lifetime.signal,
    host,
    value,
  }));
  const reportError = vi.fn();
  let selected = initiallySelected;
  const listeners = new Set<() => void>();
  const context = {
    gateway: createApplicationGateway().gateway,
    agentSelection: { state: { selectedId: "main" }, subscribe: () => () => undefined },
    plugins: {
      registrations: () => [],
      selectedReplacement: (surface: ControlUiSurface) =>
        selected ? registrations.find((entry) => entry.value.surface === surface) : undefined,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reportError,
    },
  } as unknown as ApplicationContext;
  const provider = document.body.appendChild(createApplicationContextProvider(context));
  return {
    provider,
    reportError,
    query: <T extends Element = HTMLElement>(selector: string) =>
      provider.querySelector<T>(selector),
    count: (selector: string) => provider.querySelectorAll(selector).length,
    selectReplacement() {
      selected = true;
      for (const listener of listeners) {
        listener();
      }
    },
    mount(render: Parameters<typeof mountSolid>[0], dispose?: () => void) {
      const view = mountSolid(render, {
        container: provider,
        wrapper: createSolidApplicationContextProvider(context).wrapper,
      });
      onTestFinished(() => {
        view.unmount();
        dispose?.();
        lifetime.abort();
        provider.remove();
      });
    },
  };
}
