import { render, type JSX } from "@solidjs/web";
import { createMemo, createSignal } from "solid-js";
import type { ControlUiComponentHandle } from "../../../src/plugin-sdk/control-ui-components.js";
import type { ControlUiSettingsComponents } from "../../../src/plugin-sdk/control-ui-settings.js";
import { LobsterSvg } from "../components/lobster-pet-artwork.tsx";
import { lobsterPetSeed } from "../components/lobster-pet-contract.ts";
import { createLobsterPetLook, lobsterLookStyle } from "../components/lobster-pet-look.ts";
import {
  SettingsNavRow,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../components/solid/settings-ui.tsx";
import { listen } from "../lib/reactive/listener.ts";

export function createControlUiSettingsComponents(
  signal: AbortSignal,
): ControlUiSettingsComponents {
  function mount<P extends object>(
    container: HTMLElement,
    initial: P,
    view: (props: () => P) => JSX.Element,
    row = false,
  ): ControlUiComponentHandle<P> {
    signal.throwIfAborted();
    if (row) {
      container.classList.add("settings-row-mount");
    }
    // The bridge applies imperative plugin updates to the host-owned visual root.
    const [state, setState] = createSignal({ value: initial }, { ownedWrite: true });
    const stop = render(() => view(() => state().value), container);
    let active = true;
    const dispose = () => {
      if (!active) {
        return;
      }
      active = false;
      stopAbort();
      stop();
    };
    const stopAbort = listen(signal, "abort", dispose, { once: true });
    return {
      update(next) {
        signal.throwIfAborted();
        if (!active) {
          throw new Error("This Settings component has ended.");
        }
        setState({ value: next });
      },
      dispose,
    };
  }
  return {
    mountSection: (container, initial) =>
      mount(container, initial, (props) => (
        <SettingsSection title={props().title}>{props().content}</SettingsSection>
      )),
    mountRow: (container, initial) =>
      mount(
        container,
        initial,
        (props) => (
          <SettingsRow
            title={props().title}
            description={props().description}
            control={props().control}
          />
        ),
        true,
      ),
    mountStatus: (container, initial) =>
      mount(container, initial, (props) => (
        <SettingsStatus kind={props().kind} label={props().label} />
      )),
    mountValue: (container, initial) =>
      mount(container, initial, (props) => (
        <SettingsValue value={props().value} mono={props().mono} />
      )),
    mountNavigation: (container, initial) =>
      mount(
        container,
        initial,
        (props) => (
          <SettingsNavRow
            title={props().title}
            onClick={() => {
              signal.throwIfAborted();
              props().onClick();
            }}
          />
        ),
        true,
      ),
    mountLobster: (container, initial) =>
      mount(container, initial, (props) => {
        const look = createMemo(() => createLobsterPetLook(lobsterPetSeed(props().seed)));
        return (
          <div style={`${lobsterLookStyle(look())};display:contents`}>
            <LobsterSvg
              look={look()}
              sleeping={props().sleeping}
              reading={props().reading}
              grumpy={props().grumpy}
              standalone={props().standalone}
            />
          </div>
        );
      }),
  };
}
