import { createSignal, onSettled } from "solid-js";
import { listen } from "../../lib/reactive/listener.ts";
import type { TerminalGatewayClient, TerminalSessionInfo } from "./terminal-connection.ts";
import type { TerminalSessionListOptions } from "./terminal-panel-session-types.ts";

type PickerDependencies = {
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
};

export function createTerminalSessionPicker(deps: PickerDependencies) {
  const [open, setOpen] = createSignal(deps.initialOpen());
  const [loading, setLoading] = createSignal(false);
  const [sessions, setSessions] = createSignal<TerminalSessionInfo[]>([]);
  let generation = 0;
  let discoveredTabCount: number | undefined;
  let inlineTrigger: HTMLButtonElement | undefined;
  let hostedTrigger: HTMLButtonElement | undefined;
  const trigger = () => (deps.hosted() ? hostedTrigger : inlineTrigger);
  let menu: HTMLDivElement | undefined;
  let refresh: HTMLButtonElement | undefined;

  async function load(options?: TerminalSessionListOptions) {
    const request = ++generation;
    const client = deps.client();
    if (!client || !deps.available()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const isCurrent = () => request === generation && client === deps.client() && deps.available();
    try {
      const result = await deps.list(options);
      if (isCurrent() && result !== null) {
        setSessions(result);
        reconcileVisibility(result);
      }
    } catch (error) {
      if (isCurrent()) {
        // Background discovery must leave focus in the terminal or composer.
        if (open()) {
          dismiss(true);
        }
        deps.showError(error);
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
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

  function reconcileVisibility(current = sessions()) {
    if (hiddenFor(current)) {
      // The trigger is being removed; focus must remain in the terminal.
      dismiss(false);
    }
  }

  function inside(target: EventTarget | null) {
    return target instanceof Node && (target === trigger() || menu?.contains(target));
  }

  onSettled(() => {
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
    loading,
    sessions,
    hidden: () => hiddenFor(sessions()),
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
      setLoading(false);
      setSessions([]);
    },
  };
}
