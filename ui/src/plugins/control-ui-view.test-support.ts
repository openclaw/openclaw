import { vi } from "vitest";
import type { ControlUiHost, ControlUiReplacement } from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";

export function replacement<S extends "workspace" | "composer">(
  surface: S,
  mount: ControlUiReplacement<S>["mount"],
): ControlUiReplacement<S> {
  return { id: "fixture", label: "Fixture", surface, mount };
}

export function createViewRuntime(
  initial?: ControlUiReplacement,
  options: {
    pluginId?: string;
    key?: string;
    request?: ReturnType<typeof vi.fn>;
    hostInvalidation?: boolean;
  } = {},
) {
  let selected = initial;
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  const request = options.request ?? vi.fn().mockResolvedValue({ ok: true });
  const invalidate = () => listeners.forEach((listener) => listener());
  // SAFETY: these fixtures exercise only view mounting and scoped host requests.
  const host = {
    signal: abort.signal,
    request,
    sessions: {},
    agents: {},
    navigation: {},
    ui: options.hostInvalidation === false ? {} : { invalidate },
    components: {},
  } as unknown as ControlUiHost;
  const reportError = vi.fn();
  // SAFETY: the views read only this plugin capability, not other app owners.
  const context = {
    plugins: {
      selectedReplacement: () =>
        selected
          ? {
              key: options.key ?? "review/composed",
              pluginId: options.pluginId ?? "review",
              value: selected,
              host,
              signal: abort.signal,
            }
          : undefined,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reportError,
    },
  } as unknown as ApplicationContext;
  return {
    context,
    listeners,
    reportError,
    request,
    invalidate,
    select(value?: ControlUiReplacement) {
      selected = value;
      invalidate();
    },
  };
}
