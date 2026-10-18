import { lazy, Loading, onSettled, Show } from "solid-js";
import { projectOwner } from "../lib/reactive/projection.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import type { LobsterPetProps } from "./lobster-pet-contract.ts";
import { LobsterPetOwner } from "./lobster-pet-owner.ts";
import { LobsterPetScene } from "./lobster-pet-scene-view.tsx";

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
            <Loading>
              <LobsterPetDismissMenu
                position={menuPosition()}
                onDismiss={(permanently) => pet.dismiss(permanently)}
                onClose={() => pet.closeMenu()}
              />
            </Loading>
          )}
        </Show>
      </>
    );
  },
  {
    propertyChanged: (host) => inputUpdates.get(host)?.(),
    properties: {
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
