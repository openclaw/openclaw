import { expectDefined } from "@openclaw/normalization-core";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import type {
  LobsterPetAccessory,
  LobsterPetAntennae,
  LobsterPetClawSize,
  LobsterPetLook,
  LobsterPetPalette,
  LobsterPetPersonalityId,
} from "./lobster-pet-contract.ts";
import { lobsterPaletteName, lobsterRandomName } from "./lobster-pet-lore.ts";
import { LOBSTER_PALETTE_WEIGHTS, LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";

const CHIMERA_DONOR_IDS = ["crimson", "blue", "gold", "banana", "watermelon"] as const;

const CANONICAL_CHIMERA_PARTS: NonNullable<LobsterPetLook["chimeraParts"]> = {
  body: "#ff4f40",
  clawLeft: "#4a7dfc",
  clawRight: "#f4b840",
  antennae: "#3f9d63",
};

function rollChimeraParts(rng: () => number): NonNullable<LobsterPetLook["chimeraParts"]> {
  const remaining = CHIMERA_DONOR_IDS.map((id) =>
    expectDefined(
      LOBSTER_PET_PALETTES.find((palette) => palette.id === id),
      `chimera donor palette ${id}`,
    ),
  );
  const pick = (): LobsterPetPalette => {
    const index = Math.floor(rng() * remaining.length);
    return expectDefined(remaining.splice(index, 1)[0], "distinct chimera donor");
  };
  return {
    body: pick().shell,
    clawLeft: pick().shell,
    clawRight: pick().shell,
    antennae: pick().shell,
  };
}

// A neutral look used to render catalog minis outside the pet lifecycle.
export function canonicalLobsterLook(palette: LobsterPetPalette): LobsterPetLook {
  const paletteHash = fnv1aUtf16(palette.id);
  return {
    palette,
    scale: 2,
    accessory: "none",
    antennae: "perky",
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

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickWeighted<T>(
  rng: () => number,
  entries: ReadonlyArray<readonly [T, number]>,
): T {
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
  const palette = pickWeighted<LobsterPetPalette>(rng, LOBSTER_PALETTE_WEIGHTS);
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

const SPOT_ZONES = { left: [12, 38], right: [60, 84] } as const;

// Shared inline vars for every surface that renders a look (ledge sprite,
// twin, stranger passer). The seeded glint rides
// --lob-glint-seed instead of --lob-glint so the class-driven palette and
// offline overrides in lobster-pet.css still out-cascade it.
export function lobsterLookStyle(look: LobsterPetLook): string {
  const crusher = look.crusherSide;
  const paletteHash = fnv1aUtf16(look.palette.id);
  const breatheDelayS = ((paletteHash >>> 8) % 34) / 10;
  const chimeraParts = look.chimeraParts;
  const bodyDonorClaw = chimeraParts
    ? LOBSTER_PET_PALETTES.find((palette) => palette.shell === chimeraParts.body)?.claw
    : undefined;
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
