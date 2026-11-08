import { expectDefined } from "@openclaw/normalization-core";
import type { LobsterPetPaletteId } from "./lobster-pet-contract.ts";

// Signature and pet names are proper names, so every locale keeps them as is;
// Lobsterdex card lore lives in i18n/locales/en-lobsterdex.ts.
const RARE_NAMES: Partial<Record<LobsterPetPaletteId, string>> = {
  blue: "Blueberry",
  gold: "Goldie",
  lumen: "Glimmer",
  magma: "Ember",
  oilslick: "Slick",
  aurora: "Borealis",
  nebula: "Cosmo",
  banana: "Peel",
  mood: "Ringo",
  bee: "Buzz",
  rubberduck: "Debuggy",
  watermelon: "Pips",
  clawnstantine: "Clawnstantine",
  clawiestardust: "Clawie Stardust",
  taylorpinch: "Taylor Pinch",
  clawtoodeetoo: "Clawtoo Deetoo",
  leonardodepinchy: "Leonardo DaPinchy",
  shellvis: "Shellvis",
  alexandergrahamshell: "Alexander Graham Shell",
  clawtron: "Clawtron",
  selene: "Selene",
  geode: "Amethyst",
  ghost: "Boo",
  glass: "Prism",
  split: "Picasso",
  sourdough: "Boule",
  zombie: "Shambles",
  plush: "Buttons",
  balloon: "Squeaky",
  cottoncandy: "Taffy",
  cryptid: "Nessie",
  flatpack: "Skaldjur",
  tinfoil: "Mulder",
  actual: "Homarus",
  disco: "Boogie",
  chimera: "Frankie",
  blueprint: "Prototype",
  phosphor: "TTY",
  ascii: "Figlet",
  portal: "Warp",
  notexture: "Magenta",
  loading: "Spinner",
  eclipse: "Umbra",
  heisenbug: "Segfault",
  invisible: "Nobody",
  pixel: "Sprite",
  retro: "OG",
  goldenretro: "24K",
};

// Keep legacy random-name slots stable. Dedicated character discoveries are
// keyed by palette id, not these older visitor names.
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

export function lobsterPaletteName(paletteId: LobsterPetPaletteId): string {
  return RARE_NAMES[paletteId] ?? paletteId;
}

export function lobsterRandomName(seed: number): string {
  return expectDefined(
    PET_NAMES[(seed >>> 3) % PET_NAMES.length],
    "lobster pet name catalog entry",
  );
}
