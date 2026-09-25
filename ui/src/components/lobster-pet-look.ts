import "../styles/lobster-pet.css";
import { expectDefined } from "@openclaw/normalization-core";
import { nothing, svg } from "lit";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import type {
  LobsterPetAccessory,
  LobsterPetAntennae,
  LobsterPetClawSize,
  LobsterPetLook,
  LobsterPetPalette,
  LobsterPetPaletteId,
  LobsterPetPersonalityId,
} from "./lobster-pet-contract.ts";
import { lobsterPaletteName, lobsterRandomName } from "./lobster-pet-lore.ts";
import { moonPhaseFraction } from "./lobster-pet-moon.ts";
import {
  CANONICAL_CHIMERA_PARTS,
  LOBSTER_PALETTE_WEIGHTS,
  chimeraBodyClaw,
  rollChimeraParts,
} from "./lobster-pet-palettes.ts";
import {
  ACTUAL_LOBSTER,
  ASCII_LOBSTER,
  BALLOON_LOBSTER,
  FLATPACK_LOBSTER,
  LOADING_LOBSTER,
  PORTAL_LOBSTER,
  TINFOIL_PARTS,
} from "./lobster-pet-sprites-wild.ts";
import {
  ACCESSORY_SPRITES,
  ANTENNAE_SPRITES,
  BINDLE,
  FRECKLE_SPOTS,
  GLITCH_GHOSTS,
  GRUMPY_FACE,
  HEADWEAR,
  PALETTE_OVERLAYS,
  PATTERNED_PALETTES,
  PIXEL_LOBSTER,
  RETRO_ANTENNAE,
  RETRO_FACE,
  RETRO_MEGA_CLAW,
  SAILOR_CAP,
  SELENE_MOON,
  SPLIT_HALF,
  TAIL_FAN,
} from "./lobster-pet-sprites.ts";

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

// A neutral look used to render catalog minis outside the pet lifecycle.
export function canonicalLobsterLook(palette: LobsterPetPalette): LobsterPetLook {
  const paletteHash = fnv1aUtf16(palette.id);
  return {
    palette,
    scale: 2,
    accessory: "none",
    antennae: "perky",
    side: "left",
    spotPct: 0,
    facing: 1,
    personality: "friendly",
    blinkDelayS: (paletteHash % 36) / 10,
    clawSize: "regular",
    tailFan: false,
    shiny: false,
    crusherSide: null,
    freckles: false,
    glint: null,
    chimeraParts: palette.id === "chimera" ? CANONICAL_CHIMERA_PARTS : null,
  };
}

const ACCESSORIES: Array<[LobsterPetAccessory, number]> = [
  ["none", 62],
  ["sprout", 14],
  ["patch", 14],
  ["crown", 10],
];

// OpenClaw's repository was born 2025-11-24 (GitHub created_at); on the
// anniversary every visitor dresses as the classic logo and parties.
const ANNIVERSARY = { month: 10, day: 24 } as const;

function isLobsterAnniversary(now: Date): boolean {
  return now.getMonth() === ANNIVERSARY.month && now.getDate() === ANNIVERSARY.day;
}

// Seasonal wardrobe: extra accessory entries join the pool on the right
// dates. One weighted roll either way, so the rest of the look sequence is
// unchanged on any given seed.
function seasonalAccessories(now: Date): Array<[LobsterPetAccessory, number]> {
  const month = now.getMonth();
  const day = now.getDate();
  if (month === 11) {
    return [["santa", 18]];
  }
  if (month === 9 && day >= 20) {
    return [["pumpkin", 18]];
  }
  // National Lobster Day (US, Sept 25): dress fancy. We do not cook friends.
  if (month === 8 && day === 25) {
    return [["monocle", 24]];
  }
  return [];
}

const PERSONALITY_IDS: Array<[LobsterPetPersonalityId, number]> = [
  ["sleepy", 25],
  ["zoomy", 25],
  ["friendly", 25],
  ["showoff", 25],
];

const SCALES: Array<[number, number]> = [
  [1.7, 25],
  [2, 55],
  [2.5, 20],
];

const CLAW_SIZES: Array<[LobsterPetClawSize, number]> = [
  ["regular", 55],
  ["dainty", 25],
  ["mighty", 20],
];

const LOBSTER_PET_CLAW_MULS: Record<LobsterPetClawSize, number> = {
  dainty: 0.85,
  regular: 1,
  mighty: 1.18,
};

export function lobsterPetName(look: LobsterPetLook, seed: number): string {
  const signatureName = lobsterPaletteName(look.palette.id);
  return signatureName !== look.palette.id ? signatureName : lobsterRandomName(seed);
}

// A stranger wears a different palette than the resident pet.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickWeighted<T>(rng: () => number, entries: Array<[T, number]>): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) {
      return value;
    }
  }
  return expectDefined(entries.at(-1), "weighted lobster choice fallback")[0];
}

export function randomBetween(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

// Seeded glint tints for common palettes (rare palettes pin their own via
// CSS). Applied through --lob-glint-seed so offline grey still wins.
const GLINT_TINTS = ["#ffd166", "#ff8ac2", "#b79bff"] as const;

export function createLobsterPetLook(seed: number, now: Date = new Date()): LobsterPetLook {
  const rng = mulberry32(seed);
  const palette = pickWeighted(rng, LOBSTER_PALETTE_WEIGHTS);
  const scale = pickWeighted(rng, SCALES);
  const accessory = pickWeighted(rng, [...ACCESSORIES, ...seasonalAccessories(now)]);
  const antennae: LobsterPetAntennae = rng() < 0.6 ? "perky" : "droopy";
  const side = rng() < 0.5 ? "left" : "right";
  const zone = SPOT_ZONES[side];
  const spotPct = Math.round(randomBetween(rng, zone[0], zone[1]));
  const facing = rng() < 0.5 ? 1 : -1;
  const personality = pickWeighted(rng, PERSONALITY_IDS);
  const blinkDelayS = Math.round(randomBetween(rng, 0, 4) * 10) / 10;
  // Retain the former body-build draw so removing stretched silhouettes does
  // not reroll the remaining seeded traits, including shiny and claw choices.
  rng();
  const clawSize = pickWeighted(rng, CLAW_SIZES);
  const tailFan = rng() < 0.3;
  const shiny = rng() < 1 / 512;
  // Chance-and-pick pairs always burn both rolls so later traits stay
  // aligned across seeds whichever way the chance lands.
  const crusherRoll = rng();
  const crusherPick: "left" | "right" = rng() < 0.5 ? "left" : "right";
  const crusherSide = crusherRoll < 0.15 ? crusherPick : null;
  const freckles = rng() < 0.12;
  const glintRoll = rng();
  const glintPick = GLINT_TINTS[Math.floor(rng() * GLINT_TINTS.length)] ?? null;
  const glint = glintRoll < 0.3 ? glintPick : null;
  // Append-only trait discipline: always burn all four distinct donor rolls,
  // then expose them only for Chimera so older seeded traits never shift.
  const rolledChimeraParts = rollChimeraParts(rng);
  const chimeraParts = palette.id === "chimera" ? rolledChimeraParts : null;
  const look: LobsterPetLook = {
    palette,
    scale,
    accessory,
    antennae,
    side,
    spotPct,
    facing,
    personality,
    blinkDelayS,
    clawSize,
    tailFan,
    shiny,
    crusherSide,
    freckles,
    glint,
    chimeraParts,
  };
  // The LED rides the perky antenna tip. Keep the original antenna roll above
  // so adding Clawtron does not shift any later seeded trait.
  let preparedLook = palette.id === "clawtron" ? { ...look, antennae: "perky" as const } : look;
  // The undead do not do perky. Preserve the antenna roll above so later
  // seeded traits stay aligned, then enforce the identity at the end.
  if (palette.id === "zombie") {
    preparedLook = { ...look, antennae: "droopy" };
  }
  if (isLobsterAnniversary(now)) {
    // Birthday dress code: everyone is the classic logo, party hats on.
    const retro = LOBSTER_PALETTE_WEIGHTS.find(([entry]) => entry.id === "retro")?.[0];
    return {
      ...preparedLook,
      palette: retro ?? palette,
      accessory: "party",
      chimeraParts: null,
    };
  }
  return preparedLook;
}

// Same species as icons.lobster / the dreams-scene sleeper: smooth dome body
// with stubby legs, side claws, antennae, and teal-glint eyes.
const READING_BOOK = svg`
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
      <path d="M34 67 L51 71" /><path d="M34 72 L50 75" /><path d="M67 71 L85 67" />
      <path d="M68 76 L85 72" /><path d="M70 80 L83 77" />
    </g>
    <path
      class="lob-reading-book__page-glow"
      d="M31 62 Q45 59 57 68 L57 72 Q44 65 31 67 Z"
      fill="#ffffff"
      opacity="0"
    />
  </g>
`;

export function renderLobsterSvg(
  look: LobsterPetLook,
  options: {
    grumpy?: boolean;
    shell?: boolean;
    sleeping?: boolean;
    standalone?: boolean;
    bindle?: boolean;
    sailorCap?: boolean;
    reading?: boolean;
  } = {},
) {
  const isFlatpack = look.palette.id === "flatpack";
  const paletteGeometry = PALETTE_GEOMETRY[look.palette.id];
  const hasRetroGeometry = RETRO_GEOMETRY_PALETTES.has(look.palette.id);
  const eyesClosed = options.shell || (options.sleeping && !options.reading);
  const openEyeStyle = eyesClosed ? "display:none" : "";
  const closedEyeStyle = eyesClosed
    ? "opacity:1"
    : options.standalone || options.reading
      ? "display:none"
      : "";
  const selenePhase = Math.round(moonPhaseFraction(new Date()) * 8) % 8;
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
    >
      <g class=${PALETTE_FRAME_CLASSES[look.palette.id] ?? ""}>
        ${
          paletteGeometry
            ? paletteGeometry(openEyeStyle, closedEyeStyle)
            : svg`
              ${hasRetroGeometry ? RETRO_ANTENNAE : ANTENNAE_SPRITES[look.antennae]}
              ${look.tailFan ? TAIL_FAN : nothing}
              <g class="lob-claw lob-claw--l">
                <path d="M20 42 C5 37 0 47 5 57 C10 67 20 62 25 52 C28 45 25 42 20 42 Z" fill="var(--lob-claw)" />
              </g>
              ${
                hasRetroGeometry
                  ? nothing
                  : svg`<g class="lob-claw lob-claw--r"><path d="M100 42 C115 37 120 47 115 57 C110 67 100 62 95 52 C92 45 95 42 100 42 Z" fill="var(--lob-claw)" /></g>`
              }
              ${look.palette.id === "heisenbug" ? GLITCH_GHOSTS : nothing}
              <path class="lob-standard-dome" d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z" fill="var(--lob-shell)" />
              ${look.palette.id === "split" || look.palette.id === "geode" ? SPLIT_HALF : nothing}
              ${look.palette.id === "selene" ? SELENE_MOON(selenePhase) : nothing}
              ${PALETTE_OVERLAYS[look.palette.id] ?? nothing}
              ${
                look.palette.id === "tinfoil"
                  ? TINFOIL_PARTS(!HEADWEAR.has(look.accessory))
                  : nothing
              }
              ${look.freckles && !PATTERNED_PALETTES.has(look.palette.id) ? FRECKLE_SPOTS : nothing}
              ${look.palette.id === "invisible" ? nothing : svg`<ellipse cx="48" cy="28" rx="20" ry="11" fill="#ffffff" opacity="0.1" />`}
              <g class="lob-eye-open" style=${openEyeStyle}>
                <circle cx="45" cy="32" r="5.5" fill="#0a1014" />
                <circle cx="75" cy="32" r="5.5" fill="#0a1014" />
                <circle cx="46.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
                <circle cx="76.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
              </g>
              ${
                options.sleeping && !options.reading
                  ? svg`<g class="lob-eye-peek"><circle cx="45" cy="32" r="4" fill="#0a1014" /><circle cx="46" cy="30.8" r="1.6" fill="var(--lob-glint, #00e5cc)" /></g>`
                  : nothing
              }
              <g class="lob-eye-closed" stroke="#0a1014" stroke-width="3" stroke-linecap="round" fill="none" style=${closedEyeStyle}>
                <path d="M39 33 Q45 28 51 33" /><path d="M69 33 Q75 28 81 33" />
              </g>
            `
        }
      ${
        hasRetroGeometry
          ? svg`
            ${RETRO_FACE}
            <g class="lob-claw lob-claw--r">${RETRO_MEGA_CLAW}</g>
          `
          : nothing
      }
      ${
        options.grumpy && !hasRetroGeometry && (!paletteGeometry || look.palette.id === "pixel")
          ? GRUMPY_FACE
          : nothing
      }
      ${
        look.accessory === "none" || options.shell || isFlatpack
          ? nothing
          : ACCESSORY_SPRITES[look.accessory]
      }
      ${
        // The retro grail's mega claw owns the same shoulder; it moves light.
        options.bindle && !hasRetroGeometry && !isFlatpack ? BINDLE : nothing
      }
      ${
        // The foil hat is palette identity; Mulder declines the navy-issued
        // sailor cap rather than stacking two hats on lobster days.
        options.sailorCap &&
        !options.shell &&
        !isFlatpack &&
        !HEADWEAR.has(look.accessory) &&
        look.palette.id !== "tinfoil"
          ? SAILOR_CAP
          : nothing
      }
      ${options.reading ? READING_BOOK : nothing}
      </g>
    </svg>
  `;
}

const SPOT_ZONES = { left: [12, 38], right: [60, 84] } as const;

// Shared inline vars for every surface that renders a look (ledge sprite,
// twin, stranger passer). The seeded glint rides
// --lob-glint-seed instead of --lob-glint so the class-driven palette and
// offline overrides in lobster-pet.css still out-cascade it.
export function lobsterLookStyle(look: LobsterPetLook): string {
  const crusher = look.crusherSide;
  const paletteHash = fnv1aUtf16(look.palette.id);
  const breatheDelayS = ((paletteHash >>> 8) % 34) / 10;
  const bodyDonorClaw = look.chimeraParts ? chimeraBodyClaw(look.chimeraParts.body) : undefined;
  const clawMul = (side: "left" | "right") =>
    crusher === null
      ? LOBSTER_PET_CLAW_MULS[look.clawSize]
      : crusher === side
        ? LOBSTER_PET_CLAW_MULS.mighty
        : LOBSTER_PET_CLAW_MULS.dainty;
  return [
    `--lob-shell:${look.chimeraParts?.body ?? look.palette.shell}`,
    `--lob-claw:${bodyDonorClaw ?? look.palette.claw}`,
    `--lob-blink-delay:${look.blinkDelayS}s`,
    `--lob-breathe-delay:-${breatheDelayS}s`,
    `--lob-claw-l:${clawMul("left")}`,
    `--lob-claw-r:${clawMul("right")}`,
    ...(look.chimeraParts
      ? [
          `--lob-chimera-l:${look.chimeraParts.clawLeft}`,
          `--lob-chimera-r:${look.chimeraParts.clawRight}`,
          `--lob-antennae-color:${look.chimeraParts.antennae}`,
        ]
      : []),
    ...(look.glint ? [`--lob-glint-seed:${look.glint}`] : []),
  ].join(";");
}
