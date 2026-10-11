import "../styles/lobster-pet.css";
import { dynamic } from "@solidjs/web";
import type { LobsterPetLook, LobsterPetPaletteId } from "./lobster-pet-contract.ts";
import { moonPhaseFraction } from "./lobster-pet-moon.ts";
import {
  GLITCH_GHOSTS,
  PALETTE_OVERLAYS,
  PALETTE_RIGHT_CLAW_PROPS,
  PATTERNED_PALETTES,
} from "./lobster-pet-palette-sprites.tsx";
import {
  ACTUAL_LOBSTER,
  ASCII_LOBSTER,
  BALLOON_LOBSTER,
  FLATPACK_LOBSTER,
  LOADING_LOBSTER,
  PORTAL_LOBSTER,
  TINFOIL_PARTS,
} from "./lobster-pet-sprites-wild.tsx";
import {
  ACCESSORY_SPRITES,
  ANTENNAE_SPRITES,
  BINDLE,
  FRECKLE_SPOTS,
  GRUMPY_FACE,
  HEADWEAR,
  PIXEL_LOBSTER,
  RETRO_ANTENNAE,
  RETRO_FACE,
  RETRO_MEGA_CLAW,
  SAILOR_CAP,
  seleneMoon,
  SPLIT_HALF,
  TAIL_FAN,
} from "./lobster-pet-sprites.tsx";

const RETRO_GEOMETRY_PALETTES: ReadonlySet<LobsterPetPaletteId> = new Set(["retro", "goldenretro"]);

const PALETTE_FRAME_CLASSES: Partial<Record<LobsterPetPaletteId, string>> = {
  heisenbug: "lob-heisenbug-frame",
  cryptid: "lob-cryptid-frame",
  balloon: "lob-balloon-frame",
};

const PALETTE_GEOMETRY: Partial<Record<LobsterPetPaletteId, typeof PIXEL_LOBSTER>> = {
  flatpack: FLATPACK_LOBSTER,
  loading: LOADING_LOBSTER,
  actual: ACTUAL_LOBSTER,
  balloon: BALLOON_LOBSTER,
  ascii: ASCII_LOBSTER,
  portal: PORTAL_LOBSTER,
  pixel: PIXEL_LOBSTER,
};

const ReadingBook = () => (
  <>
    <g class="lob-reading-book" transform="translate(0 2)">
      <path
        d="M25 62 Q43 56 59 66 L59 92 Q43 82 25 86 Z M61 66 Q77 56 95 62 L95 86 Q77 82 61 92 Z"
        fill="var(--lob-claw)"
        stroke="color-mix(in srgb, var(--lob-claw) 72%, #0a1014)"
        stroke-width="2.5"
        stroke-linejoin="round"
      />
      <path d="M29 62 Q44 58 59 68 L59 88 Q44 79 29 82 Z" fill="#fffaf0" />
      <path d="M61 68 Q76 58 91 62 L91 82 Q76 79 61 88 Z" fill="#fffaf0" />
      <path d="M60 67 L60 89" stroke="#d7cfc0" stroke-width="1.5" />
      <g stroke="#b8b0a3" stroke-width="1.25" stroke-linecap="round" opacity="0.58">
        <path d="M34 67 L51 71" />
        <path d="M34 72 L50 75" />
        <path d="M67 71 L85 67" />
        <path d="M68 76 L85 72" />
        <path d="M70 80 L83 77" />
      </g>
      <path
        class="lob-reading-book__page-glow"
        d="M31 62 Q45 59 57 68 L57 72 Q44 65 31 67 Z"
        fill="#ffffff"
        opacity="0"
      />
    </g>
  </>
);

export type LobsterSvgProps = {
  look: LobsterPetLook;
  grumpy?: boolean;
  shell?: boolean;
  sleeping?: boolean;
  standalone?: boolean;
  bindle?: boolean;
  sailorCap?: boolean;
  reading?: boolean;
};

export function LobsterSvg(props: LobsterSvgProps) {
  const isFlatpack = () => props.look.palette.id === "flatpack";
  const paletteGeometry = () => PALETTE_GEOMETRY[props.look.palette.id];
  const PaletteGeometry = dynamic(() => PALETTE_GEOMETRY[props.look.palette.id]);
  const hasRetroGeometry = () => RETRO_GEOMETRY_PALETTES.has(props.look.palette.id);
  const clawProp = () =>
    props.shell ? undefined : PALETTE_RIGHT_CLAW_PROPS[props.look.palette.id];
  const eyesClosed = () => props.shell || (props.sleeping && !props.reading);
  const openEyeStyle = () => (eyesClosed() ? "display:none" : "");
  const closedEyeStyle = () =>
    eyesClosed() ? "opacity:1" : props.standalone || props.reading ? "display:none" : "";
  const selenePhase = Math.round(moonPhaseFraction(new Date()) * 8) % 8;
  return (
    <>
      <svg
        class="lobster-pet__svg"
        viewBox="0 0 120 105"
        preserveAspectRatio="xMidYMax meet"
        aria-hidden="true"
      >
        <g class={PALETTE_FRAME_CLASSES[props.look.palette.id] ?? ""}>
          {paletteGeometry() ? (
            <PaletteGeometry openEyeStyle={openEyeStyle()} closedEyeStyle={closedEyeStyle()} />
          ) : (
            <>
              {hasRetroGeometry() ? RETRO_ANTENNAE() : ANTENNAE_SPRITES[props.look.antennae]()}
              {props.look.tailFan ? TAIL_FAN() : null}
              <g class="lob-claw lob-claw--l">
                <path
                  d="M20 42 C5 37 0 47 5 57 C10 67 20 62 25 52 C28 45 25 42 20 42 Z"
                  fill="var(--lob-claw)"
                />
              </g>
              {hasRetroGeometry() ? null : (
                <>
                  <g class="lob-claw lob-claw--r">
                    {clawProp()?.() ?? null}
                    <path
                      d="M100 42 C115 37 120 47 115 57 C110 67 100 62 95 52 C92 45 95 42 100 42 Z"
                      fill="var(--lob-claw)"
                    />
                  </g>
                </>
              )}
              {props.look.palette.id === "heisenbug" ? GLITCH_GHOSTS() : null}
              <path
                class="lob-standard-dome"
                d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z"
                fill="var(--lob-shell)"
              />
              {props.look.palette.id === "split" || props.look.palette.id === "geode"
                ? SPLIT_HALF()
                : null}
              {props.look.palette.id === "selene" ? seleneMoon(selenePhase) : null}
              {PALETTE_OVERLAYS[props.look.palette.id]?.() ?? null}
              {props.look.palette.id === "tinfoil"
                ? TINFOIL_PARTS(!HEADWEAR.has(props.look.accessory))
                : null}
              {props.look.freckles && !PATTERNED_PALETTES.has(props.look.palette.id)
                ? FRECKLE_SPOTS()
                : null}
              {props.look.palette.id === "invisible" ? null : (
                <>
                  <ellipse cx="48" cy="28" rx="20" ry="11" fill="#ffffff" opacity="0.1" />
                </>
              )}
              <g class="lob-eye-open" style={openEyeStyle()}>
                <circle cx="45" cy="32" r="5.5" fill="#0a1014" />
                <circle cx="75" cy="32" r="5.5" fill="#0a1014" />
                <circle cx="46.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
                <circle cx="76.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
              </g>
              {props.sleeping && !props.reading ? (
                <>
                  <g class="lob-eye-peek">
                    <circle cx="45" cy="32" r="4" fill="#0a1014" />
                    <circle cx="46" cy="30.8" r="1.6" fill="var(--lob-glint, #00e5cc)" />
                  </g>
                </>
              ) : null}
              <g
                class="lob-eye-closed"
                stroke="#0a1014"
                stroke-width="3"
                stroke-linecap="round"
                fill="none"
                style={closedEyeStyle()}
              >
                <path d="M39 33 Q45 28 51 33" />
                <path d="M69 33 Q75 28 81 33" />
              </g>
            </>
          )}
          {hasRetroGeometry() ? (
            <>
              {RETRO_FACE()}
              <g class="lob-claw lob-claw--r">{RETRO_MEGA_CLAW()}</g>
            </>
          ) : null}
          {props.grumpy &&
          !hasRetroGeometry() &&
          (!paletteGeometry() || props.look.palette.id === "pixel")
            ? GRUMPY_FACE()
            : null}
          {props.look.accessory === "none" || props.shell || isFlatpack()
            ? null
            : ACCESSORY_SPRITES[props.look.accessory]()}
          {
            // Oversized claws and signature props already occupy the carrying shoulder.
            props.bindle && !hasRetroGeometry() && !isFlatpack() && !clawProp() ? BINDLE() : null
          }
          {
            // The foil hat is palette identity; Mulder declines the navy-issued
            // sailor cap rather than stacking two hats on lobster days.
            props.sailorCap &&
            !props.shell &&
            !isFlatpack() &&
            !HEADWEAR.has(props.look.accessory) &&
            props.look.palette.id !== "tinfoil"
              ? SAILOR_CAP()
              : null
          }
          {props.reading ? ReadingBook() : null}
        </g>
      </svg>
    </>
  );
}
