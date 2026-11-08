import type { LobsterPetPaletteId } from "../../components/lobster-pet-contract.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Lobsterdex cards show `flavor` once a palette has visited and `hint` before.
// Palette and pet names stay proper names in components/lobster-pet-lore.ts.
const enLobsterdex = {
  lobsterdex: {
    lore: {
      crimson: {
        flavor: "The classic red, first in every tide pool.",
        hint: "Where every story starts.",
      },
      blue: { flavor: "1 in 2 million, and knows it.", hint: "One in two million." },
      gold: { flavor: "1 in 30 million karats.", hint: "Worth its weight." },
      lumen: { flavor: "Brings its own night lights.", hint: "Glows where it’s darkest." },
      magma: { flavor: "Fresh from the vent, still cooling.", hint: "Runs hot." },
      oilslick: { flavor: "Black shell, rainbow finish.", hint: "Spilled, not stirred." },
      aurora: { flavor: "Northern lights, southern claws.", hint: "Best seen on clear nights." },
      nebula: { flavor: "Not from any ocean on this planet.", hint: "Came from very far away." },
      banana: { flavor: "Banana. For scale.", hint: "For scale." },
      mood: { flavor: "Wears whatever color you’re feeling.", hint: "Matches your vibe." },
      bee: { flavor: "Technically not a bee.", hint: "Don’t tell the bees." },
      rubberduck: { flavor: "Listens to your bugs. Judges silently.", hint: "Quack." },
      watermelon: { flavor: "Contains 6% lobster.", hint: "Ripe when thumped." },
      clawnstantine: {
        flavor: "Built an empire. Still rules from the ledge.",
        hint: "All tides lead here.",
      },
      clawiestardust: {
        flavor: "Changes shells. Never changes style.",
        hint: "Something electric washed ashore.",
      },
      taylorpinch: {
        flavor: "Turns every tide into an era.",
        hint: "Someone is shaking off the sand.",
      },
      clawtoodeetoo: {
        flavor: "Speaks fluent beep. Fixes things anyway.",
        hint: "A resourceful little droid.",
      },
      leonardodepinchy: {
        flavor: "Every shell is a canvas.",
        hint: "A little Renaissance is washing ashore.",
      },
      shellvis: { flavor: "The king of rock and claw.", hint: "Someone brought blue suede claws." },
      alexandergrahamshell: {
        flavor: "Good ideas ring a bell.",
        hint: "A familiar ringing from the shore.",
      },
      clawtron: { flavor: "60% rivets, 40% love.", hint: "Beep boop snip." },
      selene: { flavor: "Carries the current moon on its belly.", hint: "Waxes and wanes." },
      geode: { flavor: "Rock outside, amethyst inside.", hint: "Crack the surface." },
      ghost: { flavor: "1 in 100 million, barely there.", hint: "You’d walk right past it." },
      glass: {
        flavor: "Fully transparent. Nothing to hide.",
        hint: "Easy to miss, hard to forget.",
      },
      split: { flavor: "Two lobsters, one shell.", hint: "Can’t pick a side." },
      sourdough: { flavor: "Started from a starter. 24-hour proof.", hint: "Still proofing." },
      zombie: { flavor: "Slightly used. Still friendly.", hint: "It’s been better." },
      plush: { flavor: "Machine washable. Air dry only.", hint: "Soft to the touch." },
      balloon: { flavor: "Don’t pop.", hint: "Handle with care." },
      cottoncandy: {
        flavor: "Pastel, like the famous Maine catch.",
        hint: "Sweeter than it looks.",
      },
      cryptid: { flavor: "Every photo comes out blurry.", hint: "Sightings unconfirmed." },
      flatpack: { flavor: "Some assembly required.", hint: "Missing one screw." },
      tinfoil: { flavor: "The tide is a psyop.", hint: "They know." },
      actual: { flavor: "An actual lobster. Unsettling, honestly.", hint: "Anatomically correct." },
      disco: { flavor: "Born under a mirror ball.", hint: "The night is still young." },
      chimera: { flavor: "Borrowed parts. No refunds.", hint: "Something’s off." },
      blueprint: {
        flavor: "Final hardware pending approval.",
        hint: "Still on the drawing board.",
      },
      phosphor: { flavor: "80 columns, 24 rows, one lobster.", hint: "Hums at sixty hertz." },
      ascii: { flavor: "Renders anywhere. Even over SSH.", hint: "chmod +x" },
      portal: { flavor: "Arrives before it leaves.", hint: "Mind the gap." },
      notexture: { flavor: "Texture not found.", hint: "404." },
      loading: { flavor: "Still loading. Any second now.", hint: "…" },
      eclipse: { flavor: "Don’t look directly at it.", hint: "Once in a blue moon." },
      heisenbug: {
        flavor: "Only renders right when nobody’s watching.",
        hint: "Can’t be reproduced.",
      },
      invisible: { flavor: "It’s right there. Look closer.", hint: "Trust me, it exists." },
      pixel: { flavor: "Rendered in 1987. Still runs.", hint: "Insert coin." },
      retro: {
        flavor: "The original: big claw, no apologies.",
        hint: "The one that started it all.",
      },
      goldenretro: { flavor: "One in a generation.", hint: "Worth the wait." },
    } satisfies Record<LobsterPetPaletteId, { flavor: string; hint: string }>,
  },
} satisfies TranslationMap;

export const registerLobsterdexEnglish = Object.assign(
  () => {
    en.lobsterdex = enLobsterdex.lobsterdex;
  },
  { catalog: enLobsterdex },
);
