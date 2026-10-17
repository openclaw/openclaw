import type { notifyRenderLifecycleForTest } from "../pages/chat/render-lifecycle.ts";

export function createControlUiPaneRuntimeTestAdapterScript(): string {
  return `;(() => { const __name = (target) => target; (${installControlUiPaneRuntimeTestAdapter.toString()})(); })();`;
}

/** Keeps the existing private pane probes on their actual owner during the Solid migration. */
function installControlUiPaneRuntimeTestAdapter() {
  // SAFETY: The existing opt-in render instrumentation uses this shared hook contract.
  const scope = window as Window & {
    openclawRenderLifecycleTestHook?: typeof notifyRenderLifecycleForTest;
    openclawPaneRuntimeTestAdapterInstalled?: boolean;
  };
  if (scope.openclawPaneRuntimeTestAdapterInstalled) {
    return;
  }
  const owners = new WeakMap<HTMLElement, WeakRef<object>>();
  let probe = scope.openclawRenderLifecycleTestHook;

  const forwardPaneProbes = (element: HTMLElement) => {
    const readOwner = () => owners.get(element)?.deref();
    for (const key of [
      "state",
      "chatState",
      "context",
      "taskSuggestions",
      "catalogMessages",
      "loadingOlder",
      "historyIntentTimer",
      "presencePayload",
      "boardProviderLease",
    ] as const) {
      Object.defineProperty(element, key, {
        configurable: true,
        get() {
          const owner = readOwner();
          const source =
            owner && (key === "catalogMessages" || key === "loadingOlder")
              ? Reflect.get(owner, "history")
              : owner;
          return source && Reflect.get(source, key);
        },
      });
    }
    const forwardMethod =
      (method: unknown) =>
      (...args: unknown[]) => {
        const owner = readOwner();
        return owner && typeof method === "function"
          ? Reflect.apply(method, owner, args)
          : undefined;
      };
    Object.defineProperty(element, "render", {
      configurable: true,
      get() {
        const owner = readOwner();
        const method: unknown = owner && Reflect.get(owner, "render");
        return typeof method === "function" ? forwardMethod(method) : method;
      },
      set(method: unknown) {
        const owner = readOwner();
        if (owner) {
          Reflect.set(owner, "render", method);
        }
      },
    });
  };

  const notify: typeof notifyRenderLifecycleForTest = (host, phase) => {
    const element: unknown = host instanceof HTMLElement ? host : Reflect.get(host, "element");
    if (element instanceof HTMLElement && element.localName === "openclaw-chat-pane") {
      if (!(host instanceof HTMLElement)) {
        if (!owners.has(element)) {
          forwardPaneProbes(element);
        }
        if (owners.get(element)?.deref() !== host) {
          owners.set(element, new WeakRef(host));
        }
      }
    }
    probe?.(host, phase);
  };
  // Keep capture installed while the existing stream probe replaces its callback.
  Object.defineProperty(scope, "openclawRenderLifecycleTestHook", {
    configurable: true,
    get: () => notify,
    set(next: typeof notifyRenderLifecycleForTest | undefined) {
      probe = next;
    },
  });
  scope.openclawPaneRuntimeTestAdapterInstalled = true;
}
