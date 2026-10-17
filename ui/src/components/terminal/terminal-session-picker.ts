import { createSignal, onSettled } from "solid-js";
import { listen } from "../../lib/reactive/listener.ts";
import type { TerminalGatewayClient, TerminalSessionInfo } from "./terminal-connection.ts";

type PickerDependencies = {
  client: () => TerminalGatewayClient | null;
  available: () => boolean;
  hosted: () => boolean;
  currentSessionIds: () => ReadonlySet<string>;
  list: () => Promise<TerminalSessionInfo[] | null>;
  attach: (sessionId: string, agentOwned: boolean) => Promise<void>;
};

export function createTerminalSessionPicker(deps: PickerDependencies) {
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [sessions, setSessions] = createSignal<TerminalSessionInfo[]>([]);
  let generation = 0;
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  let refresh: HTMLButtonElement | undefined;

  async function load() {
    const request = ++generation;
    const client = deps.client();
    if (!client || !deps.available()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await deps.list();
    if (request !== generation || client !== deps.client() || !deps.available()) {
      return;
    }
    if (result !== null) {
      setSessions(result);
    }
    setLoading(false);
  }

  function dismiss(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) {
      onSettled(() => trigger?.focus());
    }
  }

  function inside(target: EventTarget | null) {
    return target instanceof Node && (target === trigger || menu?.contains(target));
  }

  onSettled(() => {
    const stop = listen(
      document,
      "pointerdown",
      (event) => {
        if (open() && !event.composedPath().some((node) => node === trigger || node === menu)) {
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
    get hosted() {
      return deps.hosted();
    },
    get currentSessionIds() {
      return deps.currentSessionIds();
    },
    open,
    loading,
    sessions,
    triggerRef: (element: HTMLButtonElement) => {
      trigger = element;
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
      if (inside(event.relatedTarget)) {
        return;
      }
      queueMicrotask(() => {
        if (open() && !inside(document.activeElement)) {
          dismiss(false);
        }
      });
    },
    onRefresh: () => void load(),
    onAttach(sessionId: string, owner: TerminalSessionInfo["owner"]) {
      setOpen(false);
      void deps.attach(sessionId, owner?.startsWith("agent:") === true);
    },
    reset() {
      generation += 1;
      setOpen(false);
      setLoading(false);
      setSessions([]);
    },
  };
}
