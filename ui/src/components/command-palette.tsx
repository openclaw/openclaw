import { createEffect, onCleanup } from "solid-js";
import { useApplication } from "../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { useSolidControllerHost } from "../lit/solid-controller-host.ts";
import type {
  CommandPaletteOpenInput,
  CommandPaletteInputHandoff,
} from "./command-palette-contract.ts";
import { PaletteController, type CommandPaletteProperties } from "./command-palette-controller.ts";
import { CommandPaletteView } from "./command-palette-view.tsx";

type CommandPaletteMethods = {
  openPalette(input?: CommandPaletteOpenInput | CommandPaletteInputHandoff): void;
  togglePalette(): void;
};
export type CommandPalette = SolidBridgeElement<CommandPaletteProperties, CommandPaletteMethods> & {
  readonly isOpen: boolean;
};

const controllers = new WeakMap<HTMLElement, PaletteController>();
// A retained Lit caller can reopen immediately after reconnecting, before Solid mounts.
const pendingOpen = new WeakMap<
  HTMLElement,
  { input?: CommandPaletteOpenInput | CommandPaletteInputHandoff }
>();

export const CommandPalette = defineSolidBridge<CommandPaletteProperties, CommandPaletteMethods>(
  "openclaw-command-palette",
  (props, host) => {
    const context = useApplication();
    const lifecycle = useSolidControllerHost(() => [
      props.onNavigate,
      props.onSelectSession,
      props.desktopAvailable,
      props.custodianAvailable,
    ]);
    const legacyHost = {
      ...lifecycle.host,
      get updateComplete() {
        return lifecycle.host.updateComplete;
      },
      get isConnected() {
        return host.isConnected;
      },
      get ownerDocument() {
        return host.ownerDocument;
      },
      querySelector: host.querySelector.bind(host),
      querySelectorAll: host.querySelectorAll.bind(host),
    };
    const controller = new PaletteController(
      host,
      props,
      () => context,
      legacyHost,
      () => lifecycle.host.requestUpdate(),
    );
    controllers.set(host, controller);
    Object.defineProperty(host, "isOpen", { configurable: true, get: () => controller.isOpen });
    host.style.display = "contents";
    controller.connect();
    const pending = pendingOpen.get(host);
    if (pending) {
      pendingOpen.delete(host);
      controller.openPalette(pending.input);
    }
    createEffect(lifecycle.revision, () => controller.updated());
    onCleanup(() => {
      controller.disconnect();
      controllers.delete(host);
    });
    return (
      <CommandPaletteView
        readProps={() => {
          lifecycle.revision();
          return controller.readProps();
        }}
      />
    );
  },
  {
    properties: {
      onNavigate: { default: undefined, attribute: false },
      onSelectSession: { default: undefined, attribute: false },
      onSlashCommand: { default: undefined, attribute: false },
      desktopAvailable: { default: false, attribute: false },
      custodianAvailable: { default: false, attribute: false },
    },
    methods: {
      openPalette: (host, input) => {
        const controller = controllers.get(host);
        if (controller) {
          controller.openPalette(input);
        } else {
          pendingOpen.set(host, { input });
        }
      },
      togglePalette: (host) => {
        const controller = controllers.get(host);
        if (controller) {
          controller.togglePalette();
        } else if (pendingOpen.has(host)) {
          pendingOpen.delete(host);
        } else {
          pendingOpen.set(host, {});
        }
      },
    },
    connected: (host) => controllers.get(host)?.connect(),
    disconnected: (host) => controllers.get(host)?.disconnect(),
  },
);
