import { createMemo, createSignal, isPending, onSettled } from "solid-js";
import { listen } from "../../lib/reactive/listener.ts";
import type { TerminalGatewayClient, TerminalSessionInfo } from "./terminal-connection.ts";
import type { TerminalSessionListOptions } from "./terminal-panel-session-types.ts";

export function createTerminalSessionPicker(deps: {
  client: () => TerminalGatewayClient | null;
  available: () => boolean;
  hosted: () => boolean;
  connected: () => boolean;
  initialOpen: () => boolean;
  standalone: () => boolean;
  presented: () => boolean;
  tabCount: () => number;
  currentSessionIds: () => ReadonlySet<string>;
  list: (options?: TerminalSessionListOptions) => Promise<TerminalSessionInfo[] | null>;
  showError: (error: unknown) => void;
  attach: (sessionId: string, agentOwned: boolean) => Promise<void>;
}) {
  const [open, setOpen] = createSignal(false);
  let acceptedSessions: TerminalSessionInfo[] = [];
  const [request, setRequest] = createSignal<{
    key: number;
    value: TerminalSessionInfo[] | Promise<TerminalSessionInfo[]>;
  }>({ key: 0, value: acceptedSessions });
  const sessions = createMemo<TerminalSessionInfo[]>(() => request().value);
  const loading = () => isPending(sessions);
  let generation = 0;
  let discoveredTabCount: number | undefined;
  let inlineTrigger: HTMLButtonElement | undefined;
  let hostedTrigger: HTMLButtonElement | undefined;
  const trigger = () => (deps.hosted() ? hostedTrigger : inlineTrigger);
  let menu: HTMLDivElement | undefined;
  let refresh: HTMLButtonElement | undefined;

  async function load(options?: TerminalSessionListOptions) {
    const key = ++generation;
    const client = deps.client();
    if (!client || !deps.available()) {
      setRequest({ key, value: acceptedSessions });
      return;
    }
    const isCurrent = () => key === generation && client === deps.client() && deps.available();
    let restoreFocus = false;
    const value = (async () => {
      try {
        const result = await deps.list(options);
        if (isCurrent() && result !== null) {
          acceptedSessions = result;
          reconcileVisibility(result);
        }
      } catch (error) {
        if (isCurrent()) {
          // Background discovery must leave focus in the terminal or composer.
          if (open()) {
            dismiss(false);
            restoreFocus = true;
          }
          deps.showError(error);
        }
      }
      // The panel owner routes failures; null and retired reads preserve the accepted list.
      return acceptedSessions;
    })();
    setRequest({ key, value });
    await value;
    if (restoreFocus && isCurrent()) {
      // Focus-triggered discovery must see the completed read, not its pending frame.
      onSettled(() => trigger()?.focus());
    }
  }

  function dismiss(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) {
      onSettled(() => trigger()?.focus());
    }
  }

  function hiddenFor(current: readonly TerminalSessionInfo[]) {
    const session = current[0];
    return (
      deps.standalone() &&
      deps.tabCount() <= 1 &&
      current.length === 1 &&
      session !== undefined &&
      deps.currentSessionIds().has(session.sessionId)
    );
  }

  function reconcileVisibility(current = acceptedSessions) {
    if (hiddenFor(current)) {
      // The trigger is being removed; focus must remain in the terminal.
      dismiss(false);
    }
  }

  function inside(target: EventTarget | null) {
    return target instanceof Node && (target === trigger() || menu?.contains(target));
  }

  onSettled(() => {
    // Lazy bridge inputs bind after the component body has created this picker.
    setOpen(deps.initialOpen());
    const stop = listen(
      document,
      "pointerdown",
      (event) => {
        if (
          !deps.hosted() &&
          open() &&
          !event.composedPath().some((node) => node === trigger() || node === menu)
        ) {
          dismiss(false);
        }
      },
      true,
    );
    return () => {
      generation += 1;
      stop();
    };
  });

  return {
    get connected() {
      return deps.connected();
    },
    get hosted() {
      return deps.hosted();
    },
    get currentSessionIds() {
      return deps.currentSessionIds();
    },
    open,
    sessions,
    requestKey: () => request().key,
    hidden: () => {
      // Track read settlement without holding the surrounding chrome on its async value.
      loading();
      return hiddenFor(acceptedSessions);
    },
    syncPresentation() {
      const count = deps.presented() && deps.standalone() ? deps.tabCount() : 0;
      const changed = count !== discoveredTabCount;
      discoveredTabCount = count;
      if (changed && count > 0) {
        void load({ preserveError: true });
      }
      reconcileVisibility();
    },
    triggerRef: (element: HTMLButtonElement) => {
      inlineTrigger = element;
    },
    hostedTriggerRef: (element: HTMLButtonElement) => {
      hostedTrigger = element;
    },
    menuRef: (element: HTMLDivElement) => {
      menu = element;
    },
    refreshRef: (element: HTMLButtonElement) => {
      refresh = element;
    },
    onToggle() {
      if (open()) {
        return dismiss(true);
      }
      setOpen(true);
      void load();
      onSettled(() => {
        if (open()) {
          refresh?.focus();
        }
      });
    },
    onDismiss: dismiss,
    onFocusOut(event: FocusEvent) {
      if (deps.hosted()) {
        return;
      }
      if (inside(event.relatedTarget)) {
        return;
      }
      queueMicrotask(() => {
        if (open() && !inside(document.activeElement)) {
          dismiss(false);
        }
      });
    },
    onRefresh: (options?: TerminalSessionListOptions) => void load(options),
    onDiscover() {
      // Activation can arrive through both pointer and focus. An open menu
      // already exposes Refresh; background discovery must not interrupt it.
      if (!loading() && !open()) {
        void load({ preserveError: true });
      }
    },
    onAttach(sessionId: string, owner: TerminalSessionInfo["owner"]) {
      setOpen(false);
      void deps.attach(sessionId, owner?.startsWith("agent:") === true);
    },
    reset() {
      generation += 1;
      discoveredTabCount = undefined;
      setOpen(false);
      acceptedSessions = [];
      setRequest({ key: generation, value: acceptedSessions });
    },
  };
}
