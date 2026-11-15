import { Portal } from "@solidjs/web";
import { Errored, lazy, Loading, onSettled, Show } from "solid-js";
import { t } from "../i18n/index.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import type { LobsterPetProps } from "./lobster-pet-contract.ts";
import { LobsterPetOwner } from "./lobster-pet-owner.ts";
import { LobsterPetScene } from "./lobster-pet-scene-view.tsx";
import { LazyViewError } from "./solid/lazy-view-error.tsx";

const LobsterPetDismissMenu = lazy(() => import("./lobster-pet-dismiss-menu.tsx"), {
  export: "LobsterPetDismissMenu",
});

// A bridge remount retires the view, not the host's once-per-load visitor history.
const pets = new WeakMap<HTMLElement, LobsterPetOwner>();
const inputUpdates = new WeakMap<HTMLElement, () => void>();

export const LobsterPet = defineSolidBridge<LobsterPetProps>(
  "openclaw-lobster-pet",
  (props, host) => {
    const pet =
      pets.get(host) ?? new LobsterPetOwner(host, () => (host.visitsEnabled = false), props);
    pets.set(host, pet);
    const state = projectOwner(pet, (owner) => owner.snapshot()).read;
    onSettled(() => {
      let active = true;
      let pending = false;
      // Native setters arrive separately; reconcile their complete settled snapshot.
      inputUpdates.set(host, () => {
        if (pending) {
          return;
        }
        pending = true;
        onSettled(() => {
          pending = false;
          if (active) {
            pet.update({ ...props });
          }
        });
      });
      pet.connect();
      pet.update({ ...props });
      return () => {
        active = false;
        inputUpdates.delete(host);
        pet.dispose();
      };
    });
    return (
      <>
        <LobsterPetScene scene={state().scene} />
        <Show when={state().menuPosition}>
          {(menuPosition) => (
            <Errored
              fallback={(error, reset) => (
                <Portal>
                  <div
                    class="lobster-pet-dismiss-menu"
                    style={{
                      position: "fixed",
                      right: "1rem",
                      bottom: "1rem",
                      width: "min(320px, calc(100vw - 2rem))",
                      "z-index": "var(--z-dropdown)",
                    }}
                  >
                    <LazyViewError
                      error={error()}
                      subtitle={t("quickSettings.appearance.lobsterVisits")}
                      onRetry={() => reset()}
                      onClose={() => pet.closeMenu()}
                      inline
                    />
                  </div>
                </Portal>
              )}
            >
              <Loading>
                <LobsterPetDismissMenu
                  position={menuPosition()}
                  onDismiss={(permanently) => pet.dismiss(permanently)}
                  onClose={() => pet.closeMenu()}
                />
              </Loading>
            </Errored>
          )}
        </Show>
      </>
    );
  },
  {
    propertyChanged: (host) => inputUpdates.get(host)?.(),
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
