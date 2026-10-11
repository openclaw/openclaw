/* @vitest-environment jsdom */
import { createComponent, createSignal } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createLobsterPetLook } from "./lobster-pet-look.ts";
import { LobsterPetScene, type LobsterPetSceneProps } from "./lobster-pet-scene-view.tsx";

it("hides a shed floor shell when resized controls consume its lane", () => {
  const [floor, setFloor] = createSignal({
    start: 150,
    end: 450,
    y: 115,
  } as LobsterPetSceneProps["scene"]["floor"]);
  const look = createLobsterPetLook(42);
  const props: LobsterPetSceneProps = {
    look,
    mode: "idle",
    presence: "out",
    shellVisible: true,
    shellAnchor: "floor",
    get scene() {
      return { top: { start: 38, end: 682, y: 0 }, floor: floor(), passage: null };
    },
    travel: null,
    floorEnabled: true,
    visitsEnabled: true,
    residentEnabled: true,
    dismissed: false,
    passer: null,
    twinPlanned: false,
    anniversary: false,
    entering: false,
    entrance: "walk",
    grumpy: false,
    vigil: false,
    elder: false,
    act: null,
    spotPct: 50,
    facing: 1,
    anchor: "top",
    shellScale: 2,
    shellSpotPct: 50,
    familiarityVisits: 0,
    seed: 42,
    movingDay: false,
    sailorDay: false,
    nameOverride: null,
    flavor: null,
    bottle: null,
    onPointerDown: () => {},
    onPointerUp: () => {},
    onPointerCancel: () => {},
    onContextMenu: () => {},
    onBottleOpen: () => {},
  };
  const view = mountSolid(() => createComponent(LobsterPetScene, { scene: props }));
  expect(view.container.querySelector(".lobster-pet--shell")).not.toBeNull();
  setFloor(null);
  flush();
  expect(view.container.querySelector(".lobster-pet--shell")).toBeNull();
});
