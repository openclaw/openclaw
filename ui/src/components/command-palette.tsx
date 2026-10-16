import { onCleanup, Show } from "solid-js";
import { useApplication } from "../lib/reactive/context.ts";
import { listen } from "../lib/reactive/listener.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import type {
  CommandPaletteOpenInput,
  CommandPaletteInputHandoff,
} from "./command-palette-contract.ts";
import { CommandPaletteState, type CommandPaletteProperties } from "./command-palette-state.ts";
import { CommandPaletteView } from "./command-palette-view.tsx";

type CommandPaletteMethods = {
  openPalette(input?: CommandPaletteOpenInput | CommandPaletteInputHandoff): void;
  togglePalette(): void;
};
export type CommandPalette = SolidBridgeElement<CommandPaletteProperties, CommandPaletteMethods> & {
  readonly isOpen: boolean;
};

const states = new WeakMap<HTMLElement, CommandPaletteState>();
// A retained Lit caller can reopen immediately after reconnecting, before Solid mounts.
const pendingOpen = new WeakMap<
  HTMLElement,
  { input?: CommandPaletteOpenInput | CommandPaletteInputHandoff }
>();

export const CommandPalette = defineSolidBridge<CommandPaletteProperties, CommandPaletteMethods>(
  "openclaw-command-palette",
  (props, host) => {
    const context = useApplication();
    let draftStops: Array<() => void> = [];
    const state = new CommandPaletteState(
      host,
      props,
      context,
      () => host.updateComplete,
      () => {
        if (!draftStops.length) {
          // Closed palettes still own pending submissions and preference acknowledgments.
          draftStops = [
            context.agents,
            context.agentIdentity,
            context.sessions,
            context.config,
          ].map((source) => source.subscribe(state.changed));
        }
      },
    );
    const projection = projectOwner(state, (owner) => owner);
    states.set(host, state);
    Object.defineProperty(host, "isOpen", { configurable: true, get: () => state.open });
    host.style.display = "contents";
    const stops = [
      context.gateway.subscribeEvents(state.handleGatewayEvent),
      context.agentSelection.subscribe(state.handleAgentSelection),
      listen(host.ownerDocument, "keydown", state.handleGlobalKeydown),
    ];
    state.connect();
    const pending = pendingOpen.get(host);
    if (pending) {
      pendingOpen.delete(host);
      state.openPalette(pending.input);
    }
    // Event handlers read owner changes immediately, before Solid settles.
    const readProps = () => projection.read().readProps();
    onCleanup(() => {
      state.disconnect();
      for (const stop of [...stops, ...draftStops]) {
        stop();
      }
      states.delete(host);
    });
    return (
      <Show when={readProps().open}>
        <CommandPaletteView readProps={readProps} />
      </Show>
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
        const state = states.get(host);
        if (state) {
          state.openPalette(input);
        } else {
          pendingOpen.set(host, { input });
        }
      },
      togglePalette: (host) => {
        const state = states.get(host);
        if (state) {
          state.togglePalette();
        } else if (pendingOpen.has(host)) {
          pendingOpen.delete(host);
        } else {
          pendingOpen.set(host, {});
        }
      },
    },
    connected: (host) => states.get(host)?.connect(),
    disconnected: (host) => states.get(host)?.disconnect(),
  },
);
