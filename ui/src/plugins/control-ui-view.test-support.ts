import { onTestFinished, vi } from "vitest";
import type {
  ControlUiReplacementV2 as ControlUiReplacement,
  ControlUiSurfaceProps,
  ControlUiViewContextV2 as ControlUiViewContext,
  ControlUiViewV2,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { createInitializationContext } from "../pages/chat/chat-application-context.test-support.ts";
import { createTestControlUiPluginHost } from "../test-helpers/control-ui-plugin-host.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
  type GatewayRequestMock,
} from "../test-helpers/gateway-client.ts";

export function createInertViewHost(signal: AbortSignal, request?: GatewayRequestHandler) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  if (signal.aborted) {
    stop();
  } else {
    signal.addEventListener("abort", stop, { once: true });
  }
  onTestFinished(() => signal.removeEventListener("abort", stop));
  const context = createInitializationContext(
    createTestGatewayClient(request ?? (async () => ({}))),
  );
  return createTestControlUiPluginHost(context, "fixture", abort);
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
  mount: ControlUiViewV2<ControlUiSurfaceProps[S]>,
) {
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
    request?: GatewayRequestMock;
    hostInvalidation?: boolean;
  } = {},
) {
  let selected = initial;
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  const request = options.request ?? vi.fn<GatewayRequestHandler>().mockResolvedValue({ ok: true });
  const invalidate = () => listeners.forEach((listener) => listener());
  const host = createInertViewHost(abort.signal, request);
  host.ui.invalidate = options.hostInvalidation === false ? () => undefined : invalidate;
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
