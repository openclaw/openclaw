import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, svg, type TemplateResult } from "lit";
import { lobsterHonorific } from "./lobster-dex.ts";
import type {
  LobsterPasserKind,
  LobsterPetAccessory,
  LobsterPetAntennae,
  LobsterPetBuild,
  LobsterPetClawSize,
  LobsterPetEntrance,
  LobsterPetLook,
  LobsterPetMode,
  LobsterPetPalette,
  LobsterPetPaletteId,
  LobsterPetPersonalityId,
} from "./lobster-pet-contract.ts";

// Rarity ladder loosely mirrors real lobster genetics: blue ~1 in 2 million,
// yellow ~1 in 30 million, calico ~1 in 30 million, split two-tone ~1 in
// 50 million, albino/ghost ~1 in 100 million, cotton candy ~1 in 100 million.
// Abyss and lumen are our deep-sea fantasies. Split/calico extra geometry and
// ghost/abyss/lumen/cottoncandy styling key off the palette id (see
// lobster-pet.css and renderLobsterSvg).
const PALETTES: Array<[LobsterPetPalette, number]> = [
  [{ id: "crimson", shell: "#ff4f40", claw: "#ff775f" }, 26],
  [{ id: "coral", shell: "#d0836a", claw: "#de9b80" }, 26],
  [{ id: "teal", shell: "#2fbfa7", claw: "#5cd9c4" }, 10],
  [{ id: "violet", shell: "#9f7dfa", claw: "#bba4fd" }, 10],
  [{ id: "ink", shell: "#5e6b7a", claw: "#7b8996" }, 9],
  [{ id: "blue", shell: "#4a7dfc", claw: "#7fa4ff" }, 7],
  [{ id: "gold", shell: "#f4b840", claw: "#f9d47a" }, 5],
  [{ id: "calico", shell: "#d97a3d", claw: "#e89a63" }, 3],
  [{ id: "abyss", shell: "#2c3b68", claw: "#465b96" }, 2],
  // Bioluminescent: photophore freckles that only really glow in the dark
  // theme (see .lob-lumen in lobster-pet.css).
  [{ id: "lumen", shell: "#1d2f4e", claw: "#2e4a77" }, 2],
  [{ id: "ghost", shell: "#dce8f2", claw: "#ecf3fa" }, 1],
  [{ id: "split", shell: "#ff4f40", claw: "#ff775f" }, 1],
  // Pastel pink/blue iridescence, after the famous Maine catches.
  [{ id: "cottoncandy", shell: "#f6a8c9", claw: "#a5c6f0" }, 0.8],
  // The grail: homage to the classic OpenClaw logo (big raised claw, smirk,
  // angry brows, white sticker outline). ~0.5% of sessions.
  [{ id: "retro", shell: "#e8262c", claw: "#f04a3e" }, 0.5],
];

// Catalog order for collection UIs (Lobsterdex): common to grail.
export const LOBSTER_PET_PALETTES: readonly LobsterPetPalette[] = PALETTES.map(
  ([palette]) => palette,
);

// A neutral look used to render catalog minis outside the pet lifecycle.
export function canonicalLobsterLook(palette: LobsterPetPalette): LobsterPetLook {
  return {
    palette,
    scale: 2,
    accessory: "none",
    antennae: "perky",
    side: "left",
    spotPct: 0,
    facing: 1,
    personality: "friendly",
    blinkDelayS: 0,
    build: "round",
    clawSize: "regular",
    tailFan: false,
    shiny: false,
    crusherSide: null,
    freckles: false,
    glint: null,
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

const BUILDS: Array<[LobsterPetBuild, number]> = [
  ["round", 40],
  ["squat", 30],
  ["slender", 30],
];

const CLAW_SIZES: Array<[LobsterPetClawSize, number]> = [
  ["regular", 55],
  ["dainty", 25],
  ["mighty", 20],
];

// Builds reshape the whole sprite by stretching its aspect ratio (the svg
// renders with preserveAspectRatio="none"), so eyes, claws, accessories, and
// rare-variant geometry stay aligned for every silhouette.
const LOBSTER_PET_BUILD_MULS: Record<LobsterPetBuild, { w: number; h: number }> = {
  round: { w: 1, h: 1 },
  squat: { w: 1.14, h: 0.9 },
  slender: { w: 0.88, h: 1.1 },
};

const LOBSTER_PET_CLAW_MULS: Record<LobsterPetClawSize, number> = {
  dainty: 0.85,
  regular: 1,
  mighty: 1.18,
};

// Seeded pet names; rare palettes carry signature names. Shown via the
// sprite's native title tooltip, so no i18n surface.
const PET_NAMES = [
  "Pinchy",
  "Barnaby",
  "Thermidor",
  "Clawdette",
  "Sheldon",
  "Scuttles",
  "Bisque",
  "Crusty",
  "Snips",
  "Bubbles",
  "Clawdia",
  "Ferdinand",
  "Maple",
  "Pearl",
  "Biscuit",
  "Captain",
  "Ziggy",
  "Noodle",
  "Waffles",
  "Pippin",
  "Squirt",
  "Chip",
  "Clementine",
  "Moss",
] as const;

const RARE_NAMES: Partial<Record<LobsterPetPaletteId, string>> = {
  blue: "Blueberry",
  gold: "Goldie",
  calico: "Patches",
  abyss: "Lantern",
  lumen: "Glimmer",
  ghost: "Boo",
  split: "Picasso",
  cottoncandy: "Taffy",
  retro: "OG",
};

export function lobsterPetName(look: LobsterPetLook, seed: number): string {
  return (
    RARE_NAMES[look.palette.id] ??
    expectDefined(PET_NAMES[(seed >>> 3) % PET_NAMES.length], "lobster pet name catalog entry")
  );
}

// A stranger wears a different palette than the resident pet.
function strangerLookFor(seed: number, own: LobsterPetPaletteId): LobsterPetLook {
  for (let offset = 1; offset <= 24; offset++) {
    const look = createLobsterPetLook((seed + offset * 7919) >>> 0);
    if (look.palette.id !== own) {
      return look;
    }
  }
  return createLobsterPetLook((seed + 1) >>> 0);
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
  const palette = pickWeighted(rng, PALETTES);
  const scale = pickWeighted(rng, SCALES);
  const accessory = pickWeighted(rng, [...ACCESSORIES, ...seasonalAccessories(now)]);
  const antennae: LobsterPetAntennae = rng() < 0.6 ? "perky" : "droopy";
  const side = rng() < 0.5 ? "left" : "right";
  const zone = SPOT_ZONES[side];
  const spotPct = Math.round(randomBetween(rng, zone[0], zone[1]));
  const facing = rng() < 0.5 ? 1 : -1;
  const personality = pickWeighted(rng, PERSONALITY_IDS);
  const blinkDelayS = Math.round(randomBetween(rng, 0, 4) * 10) / 10;
  // Trait generations append their rolls (shape, then sparkle) so earlier
  // seeds keep their palette/personality and only gain new details.
  const build = pickWeighted(rng, BUILDS);
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
    build,
    clawSize,
    tailFan,
    shiny,
    crusherSide,
    freckles,
    glint,
  };
  if (isLobsterAnniversary(now)) {
    // Birthday dress code: everyone is the classic logo, party hats on.
    const retro = PALETTES.find(([entry]) => entry.id === "retro")?.[0];
    return { ...look, palette: retro ?? palette, accessory: "party" };
  }
  return look;
}

const ACCESSORY_SPRITES: Record<Exclude<LobsterPetAccessory, "none">, TemplateResult> = {
  crown: svg`
    <path
      d="M46 12 L46 2 L53 8 L60 0 L67 8 L74 2 L74 12 Q60 8 46 12 Z"
      fill="#f6c945"
    />
  `,
  sprout: svg`
    <g>
      <path d="M60 12 Q58 4 63 1" stroke="#3f9d63" stroke-width="3" stroke-linecap="round" fill="none" />
      <ellipse cx="67" cy="3" rx="5" ry="3" fill="#57c785" transform="rotate(-24 67 3)" />
    </g>
  `,
  patch: svg`
    <g>
      <path d="M28 27 Q60 14 92 22" stroke="#101820" stroke-width="4" stroke-linecap="round" fill="none" />
      <circle cx="75" cy="32" r="9" fill="#101820" />
    </g>
  `,
  santa: svg`
    <g>
      <path d="M47 10 Q54 1 68 3 L72 9 Z" fill="#e0312f" />
      <circle cx="71" cy="3.5" r="3.5" fill="#f5f7fa" />
      <ellipse cx="59" cy="10.5" rx="15" ry="3.5" fill="#f5f7fa" />
    </g>
  `,
  pumpkin: svg`
    <g>
      <ellipse cx="60" cy="6.5" rx="8.5" ry="5.5" fill="#e8871e" />
      <path d="M56 2.5 Q56 6.5 56 10.5 M64 2.5 Q64 6.5 64 10.5" stroke="#c96a10" stroke-width="1.5" fill="none" />
      <path d="M60 1.5 Q60.5 0 63 0.5" stroke="#4c9a4c" stroke-width="2.5" stroke-linecap="round" fill="none" />
    </g>
  `,
  party: svg`
    <g>
      <path d="M52 11 L60 0.5 L68 11 Z" fill="#7c5cff" />
      <path d="M55.5 6.5 L64.5 6.5" stroke="#ffd166" stroke-width="2" />
      <circle cx="60" cy="1" r="2.4" fill="#ff5c8a" />
    </g>
  `,
  // Elder wear: a patient little colony riding the shell's shoulder.
  barnacle: svg`
    <g class="lob-barnacles">
      <path d="M32 22 L36.5 13 L41 22 Z" fill="#cfd8de" />
      <path d="M42 18 L45.5 11 L49 18 Z" fill="#b8c4cc" />
      <path d="M27 26 L30 20.5 L33 26 Z" fill="#b8c4cc" />
      <circle cx="36.5" cy="18.5" r="1.1" fill="#8a949d" />
      <circle cx="45.5" cy="15" r="0.9" fill="#8a949d" />
    </g>
  `,
  // National Lobster Day formal wear: gold rim, chain, no further questions.
  monocle: svg`
    <g class="lob-monocle" fill="none" stroke="#f4b840">
      <circle cx="75" cy="32" r="8.5" stroke-width="2.5" />
      <path d="M81 39 Q85 48 80 56" stroke-width="1.5" />
    </g>
  `,
};

// Light speckle trait, distinct from calico's bold mottling; skipped on
// palettes whose identity is already pattern-driven (see renderLobsterSvg).
const FRECKLE_SPOTS = svg`
  <g class="lob-freckles" fill="#ffffff" opacity="0.3">
    <circle cx="42" cy="45" r="1.6" />
    <circle cx="50" cy="41" r="1.2" />
    <circle cx="70" cy="45" r="1.6" />
    <circle cx="78" cy="41" r="1.2" />
    <circle cx="55" cy="62" r="1.4" />
    <circle cx="67" cy="66" r="1.2" />
  </g>
`;

// Lumen photophores: dotted running lights along the shell. The glow (and
// its dark-theme-only intensity) lives in lobster-pet.css.
const LUMEN_SPOTS = svg`
  <g class="lob-lumen" fill="#7ef5dd">
    <circle cx="36" cy="54" r="2.4" />
    <circle cx="50" cy="66" r="2" />
    <circle cx="66" cy="70" r="2.2" />
    <circle cx="80" cy="60" r="2" />
    <circle cx="88" cy="46" r="1.7" />
    <circle cx="60" cy="86" r="1.7" />
  </g>
`;

// Palettes whose identity is already pattern-driven skip the freckle trait;
// stacking speckle sets reads as noise, not a variant.
const PATTERNED_PALETTES: ReadonlySet<LobsterPetPaletteId> = new Set([
  "calico",
  "split",
  "retro",
  "lumen",
]);

// Calico mottling: dark blotches scattered clear of the eye line.
const CALICO_SPOTS = svg`
  <g class="lob-spots" fill="#2a1f16" opacity="0.8">
    <ellipse cx="40" cy="50" rx="6" ry="4" transform="rotate(-15 40 50)" />
    <ellipse cx="72" cy="62" rx="7" ry="4.5" transform="rotate(18 72 62)" />
    <ellipse cx="55" cy="76" rx="5" ry="3.5" transform="rotate(-8 55 76)" />
    <ellipse cx="84" cy="42" rx="4" ry="3" transform="rotate(25 84 42)" />
    <ellipse cx="47" cy="18" rx="4.5" ry="3" transform="rotate(-20 47 18)" />
    <ellipse cx="30" cy="64" rx="4" ry="3" transform="rotate(12 30 64)" />
  </g>
`;

// Split two-tone: the right half of the body (down to the belly midline)
// repainted in the second shell color; the right claw and antenna follow via
// CSS. Mirrors the famous bilateral half-and-half lobsters.
const SPLIT_HALF = svg`
  <path
    class="lob-split-half"
    d="M60 8 C88 8 104 32 104 52 C104 72 90 90 76 95 L76 104 L66 104 L66 96 C64 96.8 62 97.1 60 97.1 L60 8 Z"
    fill="var(--lob-shell2, #46536b)"
  />
`;

// Retro homage parts (classic OpenClaw logo): one oversized raised claw with
// a pincer notch, tall V antennae, angry brows, and a smirk. The mega claw
// lives inside the .lob-claw--r group so wave/snip acts swing it.
const RETRO_MEGA_CLAW = svg`
  <path
    d="M95 55 C112 53 119 39 116 25 C113 11 99 5 91 12 C88 15 87 19 88 23 C83 27 83 36 88 43 C91 49 93 52 95 55 Z"
    fill="var(--lob-claw)"
  />
  <path
    d="M92 14 C97 22 99 31 95 41"
    stroke="#b8151b"
    stroke-width="3"
    stroke-linecap="round"
    fill="none"
  />
`;

const RETRO_ANTENNAE = svg`
  <g class="lob-antennae" stroke="var(--lob-shell)" stroke-width="4" stroke-linecap="round" fill="none">
    <path d="M50 16 Q45 4 37 1" />
    <path d="M70 16 Q75 4 83 1" />
  </g>
`;

const RETRO_FACE = svg`
  <g stroke="#0a1014" stroke-linecap="round" fill="none">
    <path d="M37 24 L51 28" stroke-width="3.5" />
    <path d="M69 28 L83 24" stroke-width="3.5" />
    <path d="M49 45 Q59 51 69 45 L72 42" stroke-width="3" />
  </g>
`;

// Tail-fan lobes peek out diagonally behind the lower body (drawn before the
// body path so they read as "behind"). Fill color lives in lobster-pet.css.
const TAIL_FAN = svg`
  <g class="lob-tail">
    <ellipse cx="16" cy="84" rx="11" ry="7" transform="rotate(-32 16 84)" />
    <ellipse cx="104" cy="84" rx="11" ry="7" transform="rotate(32 104 84)" />
  </g>
`;

// Moving-day bindle: a stick over the shoulder with a polka-dot bundle,
// carried for the whole first load after a gateway upgrade.
const BINDLE = svg`
  <g class="lob-bindle">
    <path d="M70 62 L99 30" stroke="#8a5a2b" stroke-width="3.5" stroke-linecap="round" />
    <circle cx="101" cy="27" r="9.5" fill="#e8b04b" />
    <circle cx="98" cy="24" r="1.6" fill="#b6791f" />
    <circle cx="104" cy="29" r="1.6" fill="#b6791f" />
    <circle cx="100" cy="32" r="1.3" fill="#b6791f" />
  </g>
`;

// On lobster days (see src/shared/lobster-day.ts, shared with the CLI
// banner cousin) the pet wears a little sailor cap - unless the seed already
// rolled headwear, which keeps its place.
const HEADWEAR: ReadonlySet<LobsterPetAccessory> = new Set([
  "crown",
  "sprout",
  "santa",
  "pumpkin",
  "party",
]);

const SAILOR_CAP = svg`
  <g class="lob-cap">
    <path d="M46 10 Q60 -3 74 10 L74 13 Q60 7 46 13 Z" fill="#f5f7fa" />
    <path d="M45 12 Q60 6 75 12 L75 16 Q60 10.5 45 16 Z" fill="#dfe7ee" />
    <circle cx="60" cy="2.5" r="1.8" fill="#3b6ea5" />
  </g>
`;

// Shown while grumpy (poked too much): angry brows and a frown.
const GRUMPY_FACE = svg`
  <g stroke="#0a1014" stroke-linecap="round" fill="none">
    <path d="M37 24 L51 28" stroke-width="3.5" />
    <path d="M69 28 L83 24" stroke-width="3.5" />
    <path d="M50 48 Q60 42 70 48" stroke-width="3" />
  </g>
`;

const ANTENNAE_SPRITES: Record<LobsterPetAntennae, TemplateResult> = {
  perky: svg`
    <g class="lob-antennae" stroke="var(--lob-shell)" stroke-width="4" stroke-linecap="round" fill="none">
      <path d="M46 14 Q38 4 31 7" />
      <path d="M74 14 Q82 4 89 7" />
    </g>
  `,
  droopy: svg`
    <g class="lob-antennae" stroke="var(--lob-shell)" stroke-width="4" stroke-linecap="round" fill="none">
      <path d="M46 14 Q36 8 34 18" />
      <path d="M74 14 Q84 8 86 18" />
    </g>
  `,
};

// Not a lobster. Wide shell, eye stalks, walks sideways across the ledge,
// and the Lobsterdex refuses to acknowledge it.
function renderCrabSvg() {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g stroke="#a63a2e" stroke-width="4" stroke-linecap="round" fill="none">
        <path d="M22 78 L8 88" />
        <path d="M28 88 L16 99" />
        <path d="M98 78 L112 88" />
        <path d="M92 88 L104 99" />
      </g>
      <g stroke="#c44536" stroke-width="3.5" stroke-linecap="round" fill="none">
        <path d="M44 38 L40 24" />
        <path d="M76 38 L80 24" />
      </g>
      <circle cx="40" cy="22" r="4.5" fill="#0a1014" />
      <circle cx="80" cy="22" r="4.5" fill="#0a1014" />
      <circle cx="41.5" cy="20.5" r="1.8" fill="#ffd166" />
      <circle cx="81.5" cy="20.5" r="1.8" fill="#ffd166" />
      <ellipse cx="60" cy="70" rx="46" ry="30" fill="#c44536" />
      <ellipse cx="48" cy="60" rx="16" ry="9" fill="#ffffff" opacity="0.1" />
      <path
        d="M16 58 C2 52 -2 62 4 72 C10 82 20 76 24 66 C26 60 22 58 16 58 Z"
        fill="#d95f4b"
      />
      <path
        d="M104 58 C118 52 122 62 116 72 C110 82 100 76 96 66 C94 60 98 58 104 58 Z"
        fill="#d95f4b"
      />
      <path d="M48 82 Q60 90 72 82" stroke="#7e2a20" stroke-width="3" stroke-linecap="round" fill="none" />
    </svg>
  `;
}

// Also not a lobster. Crosses the ledge on its own schedule, which is to
// say: eventually.
function renderSnailSvg() {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d="M14 96 Q32 84 58 88 L96 88 Q110 90 112 97 Q112 103 102 103 L24 103 Q14 103 14 96 Z"
        fill="#c9a06a"
      />
      <g stroke="#c9a06a" stroke-width="3.5" stroke-linecap="round" fill="none">
        <path d="M94 88 Q96 76 91 68" />
        <path d="M103 88 Q107 76 103 66" />
      </g>
      <circle cx="90" cy="65" r="3.6" fill="#0a1014" />
      <circle cx="103" cy="63" r="3.6" fill="#0a1014" />
      <circle cx="91" cy="64" r="1.3" fill="#ffd166" />
      <circle cx="104" cy="62" r="1.3" fill="#ffd166" />
      <circle cx="50" cy="62" r="27" fill="#8a5a2b" />
      <path
        d="M50 41 a21 21 0 1 1 -15 36 a14 14 0 1 0 11 -25 a8 8 0 1 0 4 14"
        stroke="#5f3d1c"
        stroke-width="4"
        stroke-linecap="round"
        fill="none"
      />
    </svg>
  `;
}

// The rubber duck: patron saint of debugging. It floats through, listens,
// and leaves without judging anyone's architecture.
function renderDuckSvg() {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d="M30 82 Q20 74 27 65 Q30 76 40 79 Z" fill="#f0b52e" />
      <ellipse cx="58" cy="85" rx="34" ry="17" fill="#ffd23e" />
      <circle cx="82" cy="50" r="18" fill="#ffd23e" />
      <path d="M98 49 Q112 52 99 59 Q95 56 95 51 Z" fill="#ff8c2e" />
      <circle cx="86" cy="44" r="3.6" fill="#0a1014" />
      <circle cx="87" cy="43" r="1.3" fill="#ffffff" />
      <path d="M44 82 Q58 72 72 82 Q58 93 44 82 Z" fill="#f0b52e" opacity="0.75" />
    </svg>
  `;
}

// A jellyfish drifting past above the ledge, pulsing gently, thinking about
// nothing at all.
function renderJellyfishSvg() {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g class="lob-jelly-tentacles" stroke="#9f7dfa" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.8">
        <path d="M40 58 Q35 74 42 90" />
        <path d="M54 61 Q52 78 57 96" />
        <path d="M68 61 Q71 78 64 94" />
        <path d="M80 58 Q85 72 78 88" />
      </g>
      <path
        d="M30 52 C30 22 90 22 90 52 L90 58 Q82 52 75 58 Q67 52 60 58 Q52 52 45 58 Q38 52 30 58 Z"
        fill="#b79bff"
        opacity="0.78"
      />
      <ellipse cx="47" cy="37" rx="12" ry="6" fill="#ffffff" opacity="0.25" />
      <circle cx="52" cy="45" r="2.6" fill="#0a1014" />
      <circle cx="66" cy="45" r="2.6" fill="#0a1014" />
    </svg>
  `;
}

const PASSER_SPRITES: Record<Exclude<LobsterPasserKind, "stranger">, () => TemplateResult> = {
  crab: renderCrabSvg,
  snail: renderSnailSvg,
  duck: renderDuckSvg,
  jellyfish: renderJellyfishSvg,
};

// While hovering, a closed bottle keeps its secret; opening swaps the title
// to the fortune — the pet-name tooltip channel, so no i18n surface.
function renderBottleSvg(opened: boolean) {
  return svg`
    <svg class="lobster-bottle__svg" viewBox="0 0 48 44" aria-hidden="true">
      <g transform="rotate(-16 24 30)">
        <rect x="5" y="18" width="30" height="16" rx="7" fill="#7fc8b8" opacity="0.72" />
        <rect x="33" y="22" width="9" height="8" rx="2.5" fill="#7fc8b8" opacity="0.72" />
        ${
          opened
            ? svg`
              <rect x="36" y="20" width="11" height="7" rx="1.5" fill="#f2e5c9" transform="rotate(-24 41 23)" />
              <rect x="43" y="30" width="4.5" height="8" rx="1.6" fill="#8a5a2b" transform="rotate(38 45 34)" />
            `
            : svg`<rect x="41" y="21.5" width="5" height="9" rx="1.8" fill="#8a5a2b" />`
        }
        <rect x="11" y="22" width="12" height="8" rx="1.5" fill="#f2e5c9" />
        <path d="M13 24.5 L21 24.5 M13 27 L19 27" stroke="#b6a071" stroke-width="1" />
        <ellipse cx="13" cy="20.5" rx="5" ry="2" fill="#ffffff" opacity="0.35" />
      </g>
    </svg>
  `;
}

// Balloon entrance rig: rendered inside the body while the descent plays,
// then unmounts with the entering flag.
const BALLOON = svg`
  <svg class="lobster-pet__balloon" viewBox="0 0 40 62" aria-hidden="true">
    <path d="M20 34 Q23 46 18 60" stroke="#8a949d" stroke-width="1.5" fill="none" />
    <ellipse cx="20" cy="16" rx="13" ry="15" fill="#ff5c8a" />
    <path d="M17 30 L20 34.5 L23 30 Z" fill="#e0446f" />
    <ellipse cx="15" cy="10" rx="4" ry="6" fill="#ffffff" opacity="0.3" />
  </svg>
`;

// Same species as icons.lobster / the dreams-scene sleeper: smooth dome body
// with stubby legs, side claws, antennae, and teal-glint eyes.
export function renderLobsterSvg(
  look: LobsterPetLook,
  options: {
    grumpy?: boolean;
    shell?: boolean;
    sleeping?: boolean;
    standalone?: boolean;
    bindle?: boolean;
    sailorCap?: boolean;
  } = {},
) {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      ${look.palette.id === "retro" ? RETRO_ANTENNAE : ANTENNAE_SPRITES[look.antennae]}
      ${look.tailFan ? TAIL_FAN : nothing}
      <g class="lob-claw lob-claw--l">
        <path
          d="M20 42 C5 37 0 47 5 57 C10 67 20 62 25 52 C28 45 25 42 20 42 Z"
          fill="var(--lob-claw)"
        />
      </g>
      ${
        look.palette.id === "retro"
          ? nothing
          : svg`
            <g class="lob-claw lob-claw--r">
              <path
                d="M100 42 C115 37 120 47 115 57 C110 67 100 62 95 52 C92 45 95 42 100 42 Z"
                fill="var(--lob-claw)"
              />
            </g>
          `
      }
      <path
        d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z"
        fill="var(--lob-shell)"
      />
      ${look.palette.id === "split" ? SPLIT_HALF : nothing}
      ${look.palette.id === "calico" ? CALICO_SPOTS : nothing}
      ${look.palette.id === "lumen" ? LUMEN_SPOTS : nothing}
      ${look.freckles && !PATTERNED_PALETTES.has(look.palette.id) ? FRECKLE_SPOTS : nothing}
      <ellipse cx="48" cy="28" rx="20" ry="11" fill="#ffffff" opacity="0.1" />
      <g class="lob-eye-open" style=${options.shell || options.sleeping ? "display:none" : ""}>
        <circle cx="45" cy="32" r="5.5" fill="#0a1014" />
        <circle cx="75" cy="32" r="5.5" fill="#0a1014" />
        <circle cx="46.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
        <circle cx="76.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
      </g>
      ${
        options.sleeping
          ? svg`
            <g class="lob-eye-peek">
              <circle cx="45" cy="32" r="4" fill="#0a1014" />
              <circle cx="46" cy="30.8" r="1.6" fill="var(--lob-glint, #00e5cc)" />
            </g>
          `
          : nothing
      }
      <g
        class="lob-eye-closed"
        stroke="#0a1014"
        stroke-width="3"
        stroke-linecap="round"
        fill="none"
        style=${
          options.shell || options.sleeping ? "opacity:1" : options.standalone ? "display:none" : ""
        }
      >
        <path d="M39 33 Q45 28 51 33" />
        <path d="M69 33 Q75 28 81 33" />
      </g>
      ${
        look.palette.id === "retro"
          ? svg`
            ${RETRO_FACE}
            <g class="lob-claw lob-claw--r">${RETRO_MEGA_CLAW}</g>
          `
          : nothing
      }
      ${options.grumpy && look.palette.id !== "retro" ? GRUMPY_FACE : nothing}
      ${look.accessory === "none" || options.shell ? nothing : ACCESSORY_SPRITES[look.accessory]}
      ${
        // The retro grail's mega claw owns the same shoulder; it moves light.
        options.bindle && look.palette.id !== "retro" ? BINDLE : nothing
      }
      ${options.sailorCap && !options.shell && !HEADWEAR.has(look.accessory) ? SAILOR_CAP : nothing}
    </svg>
  `;
}

export const SPOT_ZONES = { left: [12, 38], right: [60, 84] } as const;

// Shared inline vars for every surface that renders a look (ledge sprite,
// twin, stranger passer, logo stand-in). The seeded glint rides
// --lob-glint-seed instead of --lob-glint so the class-driven palette and
// offline overrides in lobster-pet.css still out-cascade it.
export function lobsterLookStyleVars(look: LobsterPetLook): string[] {
  const crusher = look.crusherSide;
  const clawMul = (side: "left" | "right") =>
    crusher === null
      ? LOBSTER_PET_CLAW_MULS[look.clawSize]
      : crusher === side
        ? LOBSTER_PET_CLAW_MULS.mighty
        : LOBSTER_PET_CLAW_MULS.dainty;
  return [
    `--lob-shell:${look.palette.shell}`,
    `--lob-claw:${look.palette.claw}`,
    `--lob-blink-delay:${look.blinkDelayS}s`,
    `--lob-w:${LOBSTER_PET_BUILD_MULS[look.build].w}`,
    `--lob-h:${LOBSTER_PET_BUILD_MULS[look.build].h}`,
    `--lob-claw-l:${clawMul("left")}`,
    `--lob-claw-r:${clawMul("right")}`,
    ...(look.glint ? [`--lob-glint-seed:${look.glint}`] : []),
  ];
}

function lobsterPetSpriteStyle(
  look: LobsterPetLook,
  scale: number,
  spotPct: number,
  facing: 1 | -1,
) {
  return [
    ...lobsterLookStyleVars(look),
    `--lob-scale:${scale}`,
    `--lob-x:${spotPct}%`,
    `--lob-face:${facing}`,
  ].join(";");
}

export function renderLobsterPetScene(args: {
  look: LobsterPetLook;
  mode: LobsterPetMode;
  presence: "out" | "in" | "leaving";
  logoPerched: boolean;
  shellVisible: boolean;
  visitsEnabled: boolean;
  dismissed: boolean;
  passer: { kind: LobsterPasserKind; direction: 1 | -1; crossMs: number } | null;
  twinPlanned: boolean;
  anniversary: boolean;
  entering: boolean;
  entrance: LobsterPetEntrance;
  grumpy: boolean;
  vigil: boolean;
  elder: boolean;
  act: string | null;
  zone: readonly [number, number];
  spotPct: number;
  facing: 1 | -1;
  anchor: "ledge" | "bar";
  barMaxScale: number;
  shellScale: number;
  shellSpotPct: number;
  familiarityVisits: number;
  seed: number;
  movingDay: boolean;
  sailorDay: boolean;
  nameOverride: string | null;
  // Extra "· <flavor>" tooltip suffix (elder lore, old-friend returns).
  flavor: string | null;
  bottle: { spotPct: number; opened: boolean; fortune: string } | null;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: Event) => void;
  onBottleOpen: () => void;
}) {
  const anchoredScale = (scale: number) =>
    args.anchor === "bar" ? Math.min(scale, args.barMaxScale) : scale;
  const renderSprite = (twin: boolean) => {
    // On the month/day anniversary of this palette's first Lobsterdex visit,
    // the party hat overrides whatever accessory the seed rolled.
    const dressed =
      args.anniversary && args.look.accessory !== "party"
        ? { ...args.look, accessory: "party" as const }
        : args.look;
    const classes = [
      "lobster-pet",
      `lobster-pet--${args.mode}`,
      `lobster-pet--palette-${args.look.palette.id}`,
      twin ? "lobster-pet--twin" : "",
      dressed.accessory === "party" ? "lobster-pet--party" : "",
      args.look.shiny ? "lobster-pet--shiny" : "",
      args.elder ? "lobster-pet--elder" : "",
      args.presence === "leaving" ? "lobster-pet--away" : "",
      args.entering ? "lobster-pet--entering" : "",
      args.entering && args.entrance !== "walk" ? `lobster-pet--enter-${args.entrance}` : "",
      args.grumpy ? "lobster-pet--grumpy" : "",
      args.vigil ? "lobster-pet--vigil" : "",
      args.act ? `lobster-pet--act-${args.act}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    // The twin tags along on the parent's trailing side and copies every act
    // a beat later (--lob-act-delay feeds each act's animation-delay).
    const spotPct = twin
      ? Math.min(
          args.zone[1],
          Math.max(args.zone[0], args.spotPct + (args.facing === 1 ? -12 : 12)),
        )
      : args.spotPct;
    const scale = anchoredScale(twin ? args.look.scale * 0.55 : args.look.scale);
    const style = twin
      ? `${lobsterPetSpriteStyle(args.look, scale, spotPct, args.facing === 1 ? -1 : 1)};--lob-act-delay:0.18s`
      : lobsterPetSpriteStyle(args.look, scale, spotPct, args.facing);
    // Milestone honorifics come from the load-start familiarity snapshot, so
    // a title never pops mid-visit; it is simply there next time.
    const honorific = lobsterHonorific(args.familiarityVisits);
    const baseName = args.nameOverride ?? lobsterPetName(args.look, args.seed);
    const titled = honorific ? `${honorific} ${baseName}` : baseName;
    const name = args.look.shiny ? `✦ ${titled}` : titled;
    // The twin travels light; only the resident pet hauls the moving bindle.
    const bindle = args.movingDay && !twin;
    const title = twin
      ? `${name} Jr.`
      : bindle
        ? `${name} · just moved in`
        : args.flavor
          ? `${name} · ${args.flavor}`
          : name;
    return html`
      <div
        class=${classes}
        style=${style}
        aria-hidden="true"
        title=${title}
        @pointerdown=${args.onPointerDown}
        @pointerup=${args.onPointerUp}
        @pointercancel=${args.onPointerCancel}
        @pointerleave=${args.onPointerCancel}
        @contextmenu=${args.onContextMenu}
      >
        <div class="lobster-pet__body">
          ${renderLobsterSvg(dressed, {
            grumpy: args.grumpy,
            bindle,
            sailorCap: args.sailorDay,
          })}
          ${args.entering && args.entrance === "balloon" ? BALLOON : nothing}
          ${
            args.entering && args.entrance === "bubble"
              ? html`<span class="lobster-pet__entry-bubble"></span>`
              : nothing
          }
          ${
            args.look.shiny
              ? html`
                  <span class="lobster-pet__sparkle" style="--i:0;left:12%;bottom:64%">✦</span>
                  <span class="lobster-pet__sparkle" style="--i:1;left:76%;bottom:82%">✦</span>
                `
              : nothing
          }
          <span class="lobster-pet__z" style="--i:0">z</span>
          <span class="lobster-pet__z" style="--i:1">z</span>
          <span class="lobster-pet__z" style="--i:2">Z</span>
          <span class="lobster-pet__bubble" style="--i:0"></span>
          <span class="lobster-pet__bubble" style="--i:1"></span>
          <span class="lobster-pet__bubble" style="--i:2"></span>
          <span class="lobster-pet__heart">♥</span>
          <svg class="lobster-pet__broom" viewBox="0 0 24 40" aria-hidden="true">
            <path d="M12 2 L12 24" stroke="#8a5a2b" stroke-width="3" stroke-linecap="round" />
            <path d="M6 24 L18 24 L21 38 L3 38 Z" fill="#e8b04b" />
            <path
              d="M7.5 28 L6.5 36 M12 28 L12 36 M16.5 28 L17.5 36"
              stroke="#b6791f"
              stroke-width="1.5"
            />
          </svg>
        </div>
      </div>
    `;
  };
  // While the pet is upstairs playing logo, the ledge stays empty - one
  // crab, two homes, never both at once.
  const showSprites = args.presence !== "out" && !args.logoPerched;
  // The shell may outlive the visit while it fades, but dismissal and the
  // visits setting silence it like everything else.
  const showShell = args.shellVisible && args.visitsEnabled && !args.dismissed;
  const showPasser = args.passer !== null && args.visitsEnabled;
  // The bottle washes ashore whether or not the pet is around; it belongs to
  // the ledge, not the visit.
  const showBottle = args.bottle !== null && args.visitsEnabled && !args.dismissed;
  if (!showSprites && !showShell && !showPasser && !showBottle) {
    return nothing;
  }
  // The abandoned shell: the pre-molt silhouette, frozen and slowly fading.
  const shellStyle = lobsterPetSpriteStyle(
    args.look,
    anchoredScale(args.shellScale),
    args.shellSpotPct,
    args.facing,
  );
  // A pass-through visitor: crosses the ledge once and is gone. Strangers
  // are other lobsters (never your palette); everyone else is at most
  // lobster-adjacent. None perch, none count for the Lobsterdex.
  const passerLook =
    args.passer?.kind === "stranger" ? strangerLookFor(args.seed, args.look.palette.id) : args.look;
  const passerClasses = args.passer
    ? [
        "lobster-pet",
        "lobster-pet--passer",
        args.passer.kind === "stranger"
          ? `lobster-pet--palette-${passerLook.palette.id}`
          : `lobster-pet--${args.passer.kind}`,
        args.passer.kind === "stranger" && passerLook.shiny ? "lobster-pet--shiny" : "",
        args.passer.direction === 1 ? "lobster-pet--passer-ltr" : "lobster-pet--passer-rtl",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const passerStyle = args.passer
    ? `${passerBaseStyle(args.passer.kind, args.passer.direction, passerLook)};--lob-cross:${args.passer.crossMs}ms`
    : "";
  return html`
    ${showShell
      ? html`
          <div class="lobster-pet lobster-pet--shell" style=${shellStyle} aria-hidden="true">
            <div class="lobster-pet__body">${renderLobsterSvg(args.look, { shell: true })}</div>
          </div>
        `
      : nothing}
    ${showBottle && args.bottle
      ? html`
          <div
            class="lobster-bottle ${args.bottle.opened ? "lobster-bottle--open" : ""}"
            style="--lob-x:${args.bottle.spotPct}%"
            title=${args.bottle.opened ? args.bottle.fortune : "a message in a bottle"}
            @pointerdown=${args.onBottleOpen}
          >
            ${renderBottleSvg(args.bottle.opened)}
          </div>
        `
      : nothing}
    ${showSprites ? renderSprite(false) : nothing}
    ${showSprites && args.twinPlanned ? renderSprite(true) : nothing}
    ${showPasser && args.passer
      ? html`
          <div
            class=${passerClasses}
            style=${passerStyle}
            aria-hidden="true"
            title=${PASSER_TITLES[args.passer.kind]}
          >
            <div class="lobster-pet__body">
              ${args.passer.kind === "stranger"
                ? renderLobsterSvg(passerLook, { standalone: true })
                : PASSER_SPRITES[args.passer.kind]()}
            </div>
          </div>
        `
      : nothing}
  `;
}

const PASSER_TITLES: Record<LobsterPasserKind, string> = {
  stranger: "a stranger",
  crab: "definitely a lobster",
  snail: "in no particular hurry",
  duck: "a duck. obviously",
  jellyfish: "just drifting",
};

// Non-lobster passers ignore the perch variables and carry fixed sprite
// proportions; strangers reuse the full look pipeline (capped size so a
// visiting grail does not upstage the resident).
function passerBaseStyle(
  kind: LobsterPasserKind,
  direction: 1 | -1,
  passerLook: LobsterPetLook,
): string {
  switch (kind) {
    case "crab":
      return "--lob-scale:2;--lob-w:1;--lob-h:0.82;--lob-face:1";
    case "snail":
      return `--lob-scale:1.7;--lob-w:1;--lob-h:0.9;--lob-face:${direction}`;
    case "duck":
      return `--lob-scale:1.9;--lob-w:1;--lob-h:1;--lob-face:${direction}`;
    case "jellyfish":
      return "--lob-scale:1.7;--lob-w:0.9;--lob-h:1.1;--lob-face:1";
    case "stranger":
      return lobsterPetSpriteStyle(passerLook, Math.min(passerLook.scale, 2), 0, direction);
  }
}
