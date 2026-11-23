import { onSettled } from "solid-js";
import type { LobsterPetProps } from "../../../extensions/lobsterdex/browser/api.ts";
import { LobsterPetOwner, LobsterPetView } from "../../../extensions/lobsterdex/browser/pet-api.ts";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import type { ControlUiHost } from "../../../src/plugin-sdk/control-ui.ts";
import type { ApplicationContext } from "../app/context.ts";
import { patchSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { fetchPluginThemeArtworkBlobUrl } from "../pages/plugins/icon-loader.ts";
import { createControlUiComponents } from "../plugins/control-ui-components.ts";

// Unit fixture for the same plugin scene/owner. Native activation is proven separately.
const owners = new WeakMap<HTMLElement, LobsterPetOwner>();
const updates = new WeakMap<HTMLElement, () => void>();

defineSolidBridge<LobsterPetProps>(
  "openclaw-lobster-pet",
  (props, element) => {
    const signal = new AbortController().signal;
    const inputs = () => ({
      ...props,
      onVisitsDisabled: () => {
        element.visitsEnabled = false;
        patchSettings({ lobsterPetVisits: false });
        props.onVisitsDisabled();
      },
    });
    const owner = owners.get(element) ?? new LobsterPetOwner(element, inputs());
    owners.set(element, owner);
    // SAFETY: The scene consumes only menu, translations, and theme artwork from this host fixture.
    const host = {
      signal,
      presentation: {
        version: 1,
        branding: resolveThemeBranding(undefined),
        translate: t,
        loadThemeArtwork: (url: string) => fetchPluginThemeArtworkBlobUrl({ url }),
      },
      components: createControlUiComponents({
        // SAFETY: Context menus need lifetime validation, not application services.
        current: () => ({}) as ApplicationContext,
        signal,
        onError: (error) => {
          throw error;
        },
      }),
    } as ControlUiHost;
    onSettled(() => {
      let active = true;
      let pending = false;
      updates.set(element, () => {
        if (pending) {
          return;
        }
        pending = true;
        onSettled(() => {
          pending = false;
          if (active) {
            owner.update(inputs());
          }
        });
      });
      owner.update(inputs());
      owner.connect();
      owner.update(inputs());
      return () => {
        active = false;
        updates.delete(element);
        owner.dispose();
      };
    });
    return <LobsterPetView owner={owner} host={host} />;
  },
  {
    propertyChanged: (host) => updates.get(host)?.(),
    properties: {
      composerElements: { default: undefined, attribute: false },
      seed: { default: 0, attribute: false },
      mode: { default: "idle", attribute: false },
      visitsEnabled: { default: true, attribute: false },
      residentEnabled: { default: true, attribute: false },
      critters: { default: undefined, attribute: false },
      critterArtwork: { default: undefined, attribute: false },
      floorEnabled: { default: false, attribute: false },
      runOutcome: { default: "ok", attribute: false },
      soundsEnabled: { default: false, attribute: false },
      gatewayVersion: { default: null, attribute: false },
      onVisitsDisabled: { default: () => undefined, attribute: false },
    },
  },
);

// Only the legacy owner unit fixture exposes imperative element properties.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-lobster-pet": HTMLAttributes<HTMLElement> & {
        [Key in keyof LobsterPetProps as `prop:${string & Key}`]?: LobsterPetProps[Key];
      };
    }
  }
}
