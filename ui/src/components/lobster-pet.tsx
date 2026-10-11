import { createEffect, createSignal, onCleanup, onSettled } from "solid-js";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { LobsterPetController, type LobsterPetProps } from "./lobster-pet-controller.ts";
import { LobsterPetDismissMenu } from "./lobster-pet-dismiss-menu.tsx";
import { LobsterPetScene } from "./lobster-pet-scene-view.tsx";

// A bridge remount retires the view, not the host's once-per-load visitor history.
const pets = new WeakMap<HTMLElement, LobsterPetController>();

export const LobsterPet = defineSolidBridge<LobsterPetProps>(
  "openclaw-lobster-pet",
  (props, host) => {
    const [revision, setRevision] = createSignal(0);
    const notify = () => setRevision((n) => n + 1);
    const pet =
      pets.get(host) ??
      new LobsterPetController(host, notify, () => {
        host.visitsEnabled = false;
      });
    pets.set(host, pet);
    onSettled(() => {
      pet.connect(notify);
      pet.update({ ...props });
    });
    createEffect(
      () => ({ ...props }),
      (next) => pet.update(next),
    );
    createEffect(revision, () => pet.afterCommit());
    onCleanup(() => pet.dispose());
    const scene = () => {
      revision();
      return pet.scene();
    };
    const position = () => {
      revision();
      return pet.menuPosition();
    };
    return (
      <>
        <LobsterPetScene scene={scene()} />
        <LobsterPetDismissMenu
          position={position()}
          onDismiss={(permanently) => pet.dismiss(permanently)}
          onClose={() => pet.closeMenu()}
        />
      </>
    );
  },
  {
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
