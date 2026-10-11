import "../styles/lobster-pet.css";
import { createComponent } from "solid-js";
import { renderSolidSnapshot } from "../lit/solid-snapshot.ts";
import { LobsterSvg, type LobsterSvgProps } from "./lobster-pet-artwork.tsx";
import type { LobsterPetLook } from "./lobster-pet-contract.ts";
export {
  canonicalLobsterLook,
  lobsterPetName,
  mulberry32,
  pickWeighted,
  randomBetween,
  createLobsterPetLook,
  lobsterLookStyle,
} from "./lobster-pet-identity.ts";

export function renderLobsterSvg(
  look: LobsterPetLook,
  options: Omit<LobsterSvgProps, "look"> = {},
) {
  return renderSolidSnapshot(() => createComponent(LobsterSvg, { look, ...options }));
}
