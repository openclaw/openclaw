import { render, type JSX } from "@solidjs/web";
import { createMemo, createSignal } from "solid-js";
import type { ControlUiComponentHandle } from "../../../src/plugin-sdk/control-ui-components.js";
import type { ControlUiSettingsComponents } from "../../../src/plugin-sdk/control-ui-settings.js";
import type { PluginManifestControlUiSettingsView } from "../../../src/plugins/manifest-types.js";
import { LobsterSvg } from "../components/lobster-pet-artwork.tsx";
import { lobsterPetSeed } from "../components/lobster-pet-contract.ts";
import { createLobsterPetLook, lobsterLookStyle } from "../components/lobster-pet-identity.ts";
import {
  SettingsNavRow,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../components/solid/settings-ui.tsx";
import { listen } from "../lib/reactive/listener.ts";
import { declaredPluginSetting } from "./control-ui-setting-places.ts";

/**
 * Host-drawn Settings components for one plugin view. `settings` is what the view's manifest
 * declares; a row naming any other setting ID throws before it renders.
 */
export function createControlUiSettingsComponents(
  signal: AbortSignal,
  settings: PluginManifestControlUiSettingsView["settings"],
): ControlUiSettingsComponents {
  const settingId = (row: { setting?: string }) =>
    row.setting === undefined ? undefined : declaredPluginSetting(settings, row.setting);
  function mount<P extends object>(
    container: HTMLElement,
    initial: P,
    view: (props: () => P) => JSX.Element,
    admit?: (props: P) => unknown,
  ): ControlUiComponentHandle<P> {
    signal.throwIfAborted();
    admit?.(initial);
    // Only rows name a setting, so only rows pass `admit`.
    if (admit) {
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
        admit?.(next);
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
            setting={settingId(props())}
            info={props().info}
            title={props().title}
            description={props().description}
            control={props().control}
          />
        ),
        settingId,
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
            setting={settingId(props())}
            info={props().info}
            title={props().title}
            onClick={() => {
              signal.throwIfAborted();
              props().onClick();
            }}
          />
        ),
        settingId,
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
