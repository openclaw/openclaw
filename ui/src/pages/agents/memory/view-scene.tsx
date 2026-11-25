import { createMemo, For } from "solid-js";
import { LobsterSvg } from "../../../components/lobster-pet-artwork.tsx";
import { lobsterPetSeed } from "../../../components/lobster-pet-contract.ts";
import { createLobsterPetLook } from "../../../components/lobster-pet-identity.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { DREAM_PHRASE_KEYS } from "./dreaming.ts";
import type { DreamingProps } from "./view-types.ts";

const STARS: {
  top: number;
  left: number;
  size: number;
  delay: number;
  hue: "neutral" | "accent";
}[] = [
  { top: 8, left: 15, size: 3, delay: 0, hue: "neutral" },
  { top: 12, left: 72, size: 2, delay: 1.4, hue: "neutral" },
  { top: 22, left: 35, size: 3, delay: 0.6, hue: "accent" },
  { top: 18, left: 88, size: 2, delay: 2.1, hue: "neutral" },
  { top: 35, left: 8, size: 2, delay: 0.9, hue: "neutral" },
  { top: 45, left: 92, size: 2, delay: 1.7, hue: "neutral" },
  { top: 55, left: 25, size: 3, delay: 2.5, hue: "accent" },
  { top: 65, left: 78, size: 2, delay: 0.3, hue: "neutral" },
  { top: 75, left: 45, size: 2, delay: 1.1, hue: "neutral" },
  { top: 82, left: 60, size: 3, delay: 1.8, hue: "accent" },
  { top: 30, left: 55, size: 2, delay: 0.4, hue: "neutral" },
  { top: 88, left: 18, size: 2, delay: 2.3, hue: "neutral" },
];

export function DreamingScene(props: DreamingProps) {
  // A word joiner after each hyphen keeps compounds whole when the phrase wraps.
  const dreamText = () =>
    t(DREAM_PHRASE_KEYS[props.viewState.dreamIndex] ?? DREAM_PHRASE_KEYS[0]).replaceAll(
      "-",
      "-\u2060",
    );
  // Keep the sleeper's seeded identity consistent with this agent's sidebar pet.
  const look = createMemo(() => createLobsterPetLook(lobsterPetSeed(props.selectedAgentId)));
  const style = () => `--lob-shell:${look().palette.shell};--lob-claw:${look().palette.claw}`;
  return (
    <section class={["dreams", { "dreams--idle": !props.active }]}>
      <For each={STARS}>
        {(s) => (
          <div
            class="dreams__star"
            style={`
              top: ${s.top}%;
              left: ${s.left}%;
              width: ${s.size}px;
              height: ${s.size}px;
              background: ${s.hue === "accent" ? "var(--accent-muted)" : "var(--text)"};
              animation-delay: ${s.delay}s;
            `}
          />
        )}
      </For>

      <div class="dreams__moon" />

      {props.active ? (
        <>
          <div class="dreams__bubble">
            <span class="dreams__bubble-text">{dreamText()}</span>
          </div>
          <div class="dreams__bubble-dot dreams__bubble-dot--far" />
          <div class="dreams__bubble-dot dreams__bubble-dot--near" />
        </>
      ) : undefined}

      <div class="dreams__glow" />
      <div class="dreams__lobster" style={style()}>
        <LobsterSvg look={look()} sleeping />
      </div>
      <span class="dreams__z">z</span>
      <span class="dreams__z">z</span>
      <span class="dreams__z">Z</span>
    </section>
  );
}
