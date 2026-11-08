import type { ThemeCritterId } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Hover titles for the lobster pet, its passers-by and the beached bottle.
// Pet names are proper names and arrive untranslated as {name}.
const enLobsterPet = {
  lobsterPet: {
    honorific: {
      elder: "Elder {name}",
      captain: "Captain {name}",
      sir: "Sir {name}",
    },
    twin: "{name} Jr.",
    movedIn: "{name} · just moved in",
    flavor: {
      elder: "{name} · old as the tides",
      oldFriend: "{name} · an old friend",
    },
    bottle: "A message in a bottle",
    fortunes: {
      tide: "The tide returns every branch to shore.",
      molt: "Molt before you feel ready.",
      shell: "A shell is just armor you outgrew.",
      greenTest: "Somewhere, a test is green because of you.",
      sideways: "Swim sideways when forward fails.",
      reef: "The reef remembers kind commits.",
      nightLight: "Even the deep keeps a night light.",
      barnacles: "Barnacles are only patient passengers.",
      current: "No current lasts forever.",
      treasure: "Bury your treasure in version control.",
      crab: "The crab was a lobster all along.",
      grip: "Small claws, firm grip",
      rest: "Rest is also progress.",
      pinned: "What washes away was never pinned.",
    },
    passers: {
      stranger: "A stranger",
      crab: "Definitely a lobster",
      snail: "In no particular hurry",
      duck: "A duck. Obviously",
      jellyfish: "Just drifting",
      penguin: "On loan from the kernel",
      fedora: "A hat. Nobody underneath",
    } satisfies Record<
      "stranger" | "crab" | "snail" | "duck" | "jellyfish" | ThemeCritterId,
      string
    >,
  },
} satisfies TranslationMap;

export type LobsterBottleFortune = keyof typeof enLobsterPet.lobsterPet.fortunes;

export const registerLobsterPetEnglish = Object.assign(
  () => {
    en.lobsterPet = enLobsterPet.lobsterPet;
  },
  { catalog: enLobsterPet },
);
