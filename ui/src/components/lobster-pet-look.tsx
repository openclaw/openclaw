import { renderSolidSnapshot } from "../lib/dom/solid-snapshot.ts";
import { LobsterSvg, type LobsterSvgProps } from "./lobster-pet-artwork.tsx";
import type { LobsterPetLook } from "./lobster-pet-contract.ts";

export function renderLobsterSvg(
  look: LobsterPetLook,
  options: Omit<LobsterSvgProps, "look"> = {},
) {
  return renderSolidSnapshot(() => <LobsterSvg look={look} {...options} />);
}
