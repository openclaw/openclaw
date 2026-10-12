import { createMemo, For } from "solid-js";
import { lobsterPetSeed } from "../../../components/lobster-pet-contract.ts";
import { createLobsterPetLook, renderLobsterSvg } from "../../../components/lobster-pet-look.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "../../../lit/solid-bridge.ts";
import { formatPhaseRun } from "./dreaming-phase-run.ts";
import type { DreamingProps } from "./view-types.ts";

const DREAM_PHASES = ["light", "deep", "rem"] as const;

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

export function renderScene(props: DreamingProps, dreamText: () => string) {
  // Keep the sleeper's seeded identity consistent with this agent's sidebar pet.
  const look = createMemo(() => createLobsterPetLook(lobsterPetSeed(props.selectedAgentId)));
  const statusDetail = () => {
    const promotedCount =
      props.scenePromotedCount === undefined ? props.promotedCount : props.scenePromotedCount;
    return [
      promotedCount === null ? null : `${promotedCount} ${t("dreaming.status.promotedSuffix")}`,
      props.nextCycle ? `${t("dreaming.status.nextSweepPrefix")} ${props.nextCycle}` : null,
      props.timezone,
    ]
      .filter((segment) => segment)
      .join(" · ");
  };
  const style = () => `--lob-shell:${look().palette.shell};--lob-claw:${look().palette.claw}`;
  return (
    <section class={`dreams ${!props.active ? "dreams--idle" : ""}`}>
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
          <div
            class="dreams__bubble-dot"
            style="top: calc(50% - 160px); left: calc(50% - 120px); width: 12px; height: 12px; animation-delay: 0.2s;"
          />
          <div
            class="dreams__bubble-dot"
            style="top: calc(50% - 120px); left: calc(50% - 90px); width: 8px; height: 8px; animation-delay: 0.4s;"
          />
        </>
      ) : undefined}

      <div class="dreams__glow" />
      <div class="dreams__lobster" style={style()}>
        <LitContent render={() => renderLobsterSvg(look(), { sleeping: true })} />
      </div>
      <span class="dreams__z">z</span>
      <span class="dreams__z">z</span>
      <span class="dreams__z">Z</span>

      <div class="dreams__status">
        <span class="dreams__status-label">
          {props.active ? t("dreaming.status.active") : t("dreaming.status.idle")}
        </span>
        <div class="dreams__status-detail">
          <div class="dreams__status-dot" />
          <span>{statusDetail()}</span>
        </div>
      </div>

      <div class="dreams__phases">
        <For each={DREAM_PHASES}>
          {(phaseId) => {
            const phase = createMemo(() => props.phases?.[phaseId]);
            const enabled = () => phase()?.enabled === true;
            const status = () => {
              const current = phase();
              if (!current) {
                return "—";
              }
              if (!current.enabled) {
                return t("dreaming.phase.off");
              }
              return formatPhaseRun(current);
            };
            return (
              <div
                class={[
                  "dreams__phase",
                  { "dreams__phase--off": phase() !== undefined && !enabled() },
                ]}
              >
                <div class={["dreams__phase-dot", { "dreams__phase-dot--on": enabled() }]} />
                <span class="dreams__phase-name">{t(`dreaming.phase.${phaseId}`)}</span>
                <span class="dreams__phase-next">{status()}</span>
              </div>
            );
          }}
        </For>
      </div>

      {props.statusError ? (
        <div class="dreams__controls-error">{props.statusError}</div>
      ) : undefined}
    </section>
  );
}
