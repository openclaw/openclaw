import { vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiReplacement,
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";

export function createInertViewHost(signal: AbortSignal): ControlUiHost {
  return {
    signal,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
}

type Surface = "workspace" | "composer";
type ViewContext<S extends Surface> = ControlUiViewContext<ControlUiSurfaceProps[S]>;

export function composerProps(
  overrides: Partial<ControlUiSurfaceProps["composer"]> = {},
): ControlUiSurfaceProps["composer"] {
  return {
    sessionKey: "main",
    agentId: "main",
    draft: "",
    canSend: true,
    sending: false,
    disabledReason: null,
    setDraft: vi.fn(),
    send: async () => true,
    ...overrides,
  };
}

export function replacement<S extends Surface>(
  surface: S,
  mount: ControlUiReplacement<S>["mount"],
): ControlUiReplacement<S> {
  return { id: "fixture", label: "Fixture", surface, mount };
}

export function recordReplacement<S extends Surface>(
  surface: S,
  content: string | ((context: ViewContext<S>) => string),
  updates = false,
) {
  const contexts: ViewContext<S>[] = [];
  const roots: HTMLElement[] = [];
  const dispose = vi.fn();
  const mount = vi.fn((container: HTMLElement, context: ViewContext<S>) => {
    roots.push(container);
    contexts.push(context);
    container.textContent = typeof content === "string" ? content : content(context);
    return updates
      ? { dispose, update: (next: typeof context) => contexts.push(next) }
      : { dispose };
  });
  return { view: replacement(surface, mount), contexts, roots, dispose, mount };
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
    ...createInertViewHost(abort.signal),
    request,
    ui: options.hostInvalidation === false ? {} : { invalidate },
  };
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
    select: (value?: ControlUiReplacement) => {
      selected = value;
      invalidate();
    },
  };
}
