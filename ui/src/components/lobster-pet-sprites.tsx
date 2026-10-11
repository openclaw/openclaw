import type { JSX } from "@solidjs/web";
import { LOBSTER_HAT_SPRITES } from "./lobster-hat-sprites.tsx";
import type { LobsterPetAccessory, LobsterPetAntennae } from "./lobster-pet-contract.ts";
import { PasserSprite, type LobsterEyeProps } from "./lobster-pet-sprite.tsx";
export const ACCESSORY_SPRITES: Record<Exclude<LobsterPetAccessory, "none">, () => JSX.Element> = {
  crown: LOBSTER_HAT_SPRITES.crown,
  sprout: () => (
    <>
      <g>
        <path
          d="M60 12 Q58 4 63 1"
          stroke="#3f9d63"
          stroke-width="3"
          stroke-linecap="round"
          fill="none"
        />
        <ellipse cx="67" cy="3" rx="5" ry="3" fill="#57c785" transform="rotate(-24 67 3)" />
      </g>
    </>
  ),
  patch: () => (
    <>
      <g>
        <path
          d="M28 27 Q60 14 92 22"
          stroke="#101820"
          stroke-width="4"
          stroke-linecap="round"
          fill="none"
        />
        <circle cx="75" cy="32" r="9" fill="#101820" />
      </g>
    </>
  ),
  santa: LOBSTER_HAT_SPRITES.santa,
  pumpkin: LOBSTER_HAT_SPRITES.pumpkin,
  party: LOBSTER_HAT_SPRITES.party,
  barnacle: () => (
    <>
      <g class="lob-barnacles">
        <path d="M32 22 L36.5 13 L41 22 Z" fill="#cfd8de" />
        <path d="M42 18 L45.5 11 L49 18 Z" fill="#b8c4cc" />
        <path d="M27 26 L30 20.5 L33 26 Z" fill="#b8c4cc" />
        <circle cx="36.5" cy="18.5" r="1.1" fill="#8a949d" />
        <circle cx="45.5" cy="15" r="0.9" fill="#8a949d" />
      </g>
    </>
  ),
  monocle: () => (
    <>
      <g class="lob-monocle" fill="none" stroke="#f4b840">
        <circle cx="75" cy="32" r="8.5" stroke-width="2.5" />
        <path d="M81 39 Q85 48 80 56" stroke-width="1.5" />
      </g>
    </>
  ),
};

export const FRECKLE_SPOTS = () => (
  <>
    <g class="lob-freckles" fill="#ffffff" opacity="0.3">
      <circle cx="42" cy="45" r="1.6" />
      <circle cx="50" cy="41" r="1.2" />
      <circle cx="70" cy="45" r="1.6" />
      <circle cx="78" cy="41" r="1.2" />
      <circle cx="55" cy="62" r="1.4" />
      <circle cx="67" cy="66" r="1.2" />
    </g>
  </>
);

export function seleneMoon(phaseIndex: number): JSX.Element {
  const phase = ((Math.round(phaseIndex) % 8) + 8) % 8;
  if (phase === 0) {
    return (
      <>
        <g class="lob-selene-moon">
          <circle cx="60" cy="64" r="12" fill="#26304a" />
          <circle cx="60" cy="64" r="11" fill="none" stroke="#f4f7fc" stroke-width="1" />
        </g>
      </>
    );
  }
  if (phase === 4) {
    return (
      <>
        <g class="lob-selene-moon">
          <circle cx="60" cy="64" r="12" fill="#26304a" />
          <circle cx="60" cy="64" r="11" fill="#f4f7fc" />
        </g>
      </>
    );
  }
  const darkOffset = phase < 4 ? [-5, -9, -14][phase - 1] : [14, 9, 5][phase - 5];
  return (
    <>
      <g class="lob-selene-moon">
        <circle cx="60" cy="64" r="12" fill="#26304a" />
        <circle cx="60" cy="64" r="11" fill="#f4f7fc" />
        <circle cx={60 + (darkOffset ?? 0)} cy="64" r="11" fill="#26304a" />
      </g>
    </>
  );
}

export function PIXEL_LOBSTER(props: LobsterEyeProps): JSX.Element {
  return (
    <>
      <g class="lob-pixel-frame" shape-rendering="crispEdges">
        <g class="lob-pixel-antennae" fill="#d84c3e">
          <rect x="30" y="0" width="6" height="6" />
          <rect x="36" y="6" width="6" height="6" />
          <rect x="42" y="12" width="6" height="6" />
          <rect x="84" y="0" width="6" height="6" />
          <rect x="78" y="6" width="6" height="6" />
          <rect x="72" y="12" width="6" height="6" />
        </g>
        <g class="lob-pixel-claws">
          <path
            d="M18 42 H6 V48 H0 V60 H6 V66 H18 V60 H24 V48 H18 Z M6 48 H12 V60 H6 Z"
            fill="#d84c3e"
          />
          <rect x="6" y="60" width="12" height="6" fill="#a83428" />
          <path
            d="M102 42 H114 V48 H120 V60 H114 V66 H102 V60 H96 V48 H102 Z M108 48 H114 V60 H108 Z"
            fill="#d84c3e"
          />
          <rect x="102" y="60" width="12" height="6" fill="#a83428" />
        </g>
        {/* Main cells keep the palette variable so offline and mood-style tinting still read. */}
        <g class="lob-pixel-body" fill="var(--lob-shell, #d84c3e)">
          <rect x="42" y="12" width="36" height="6" />
          <rect x="36" y="18" width="48" height="6" />
          <rect x="30" y="24" width="60" height="6" />
          <rect x="24" y="30" width="72" height="48" />
          <rect x="30" y="78" width="60" height="12" />
          <rect x="36" y="90" width="48" height="6" />
          <rect x="36" y="96" width="12" height="9" />
          <rect x="72" y="96" width="12" height="9" />
        </g>
        <g fill="#ef8f6a">
          <rect x="36" y="24" width="24" height="6" />
          <rect x="30" y="30" width="18" height="12" />
          <rect x="24" y="42" width="12" height="12" />
        </g>
        <g fill="#a83428">
          <rect x="30" y="78" width="60" height="12" />
          <rect x="36" y="90" width="48" height="6" />
          <rect x="36" y="96" width="12" height="9" />
          <rect x="72" y="96" width="12" height="9" />
        </g>
        <g class="lob-eye-open" style={props.openEyeStyle}>
          <rect x="42" y="30" width="6" height="6" fill="#0a1014" />
          <rect x="72" y="30" width="6" height="6" fill="#0a1014" />
          <rect x="42" y="30" width="2.5" height="2.5" fill="#fff" />
          <rect x="72" y="30" width="2.5" height="2.5" fill="#fff" />
        </g>
        <g class="lob-eye-closed" style={props.closedEyeStyle} fill="#0a1014">
          <rect x="42" y="33" width="6" height="3" />
          <rect x="72" y="33" width="6" height="3" />
        </g>
      </g>
    </>
  );
}

// Split two-tone: the right half of the body (down to the belly midline)
// repainted in the second shell color; the right claw and antenna follow via
// CSS. Mirrors the famous bilateral half-and-half lobsters.
export const SPLIT_HALF = () => (
  <>
    <path
      class="lob-split-half"
      d="M60 8 C88 8 104 32 104 52 C104 72 90 90 76 95 L76 104 L66 104 L66 96 C64 96.8 62 97.1 60 97.1 L60 8 Z"
      fill="var(--lob-shell2, #46536b)"
    />
  </>
);

// Retro homage parts (classic OpenClaw logo): one oversized raised claw with
// a pincer notch, tall V antennae, angry brows, and a smirk. The mega claw
// lives inside the .lob-claw--r group so wave/snip acts swing it.
export const RETRO_MEGA_CLAW = () => (
  <>
    <path
      d="M95 55 C112 53 119 39 116 25 C113 11 99 5 91 12 C88 15 87 19 88 23 C83 27 83 36 88 43 C91 49 93 52 95 55 Z"
      fill="var(--lob-claw)"
    />
    <path
      d="M92 14 C97 22 99 31 95 41"
      class="lob-retro-claw-line"
      stroke="#b8151b"
      stroke-width="3"
      stroke-linecap="round"
      fill="none"
    />
  </>
);

export const RETRO_ANTENNAE = () => (
  <>
    <g
      class="lob-antennae"
      stroke="var(--lob-shell)"
      stroke-width="4"
      stroke-linecap="round"
      fill="none"
    >
      <path d="M50 16 Q45 4 37 1" />
      <path d="M70 16 Q75 4 83 1" />
    </g>
  </>
);

function browedFace(mouth: string): JSX.Element {
  return (
    <>
      <g stroke="#0a1014" stroke-linecap="round" fill="none">
        <path d="M37 24 L51 28" stroke-width="3.5" />
        <path d="M69 28 L83 24" stroke-width="3.5" />
        <path d={mouth} stroke-width="3" />
      </g>
    </>
  );
}

export const RETRO_FACE = () => browedFace("M49 45 Q59 51 69 45 L72 42");

// Tail-fan lobes peek out diagonally behind the lower body (drawn before the
// body path so they read as "behind"). Fill color lives in lobster-pet.css.
export const TAIL_FAN = () => (
  <>
    <g class="lob-tail">
      <ellipse cx="16" cy="84" rx="11" ry="7" transform="rotate(-32 16 84)" />
      <ellipse cx="104" cy="84" rx="11" ry="7" transform="rotate(32 104 84)" />
    </g>
  </>
);

export const BINDLE = () => (
  <>
    <g class="lob-bindle">
      <path d="M70 62 L99 30" stroke="#8a5a2b" stroke-width="3.5" stroke-linecap="round" />
      <circle cx="101" cy="27" r="9.5" fill="#e8b04b" />
      <circle cx="98" cy="24" r="1.6" fill="#b6791f" />
      <circle cx="104" cy="29" r="1.6" fill="#b6791f" />
      <circle cx="100" cy="32" r="1.3" fill="#b6791f" />
    </g>
  </>
);

// On lobster days (see src/shared/lobster-day.ts, shared with the CLI
// banner cousin) the pet wears a little sailor cap - unless the seed already
// rolled headwear, which keeps its place.
export const HEADWEAR: ReadonlySet<LobsterPetAccessory> = new Set([
  "crown",
  "sprout",
  "santa",
  "pumpkin",
  "party",
]);

export const SAILOR_CAP = () => (
  <>
    <g class="lob-cap">
      <path d="M46 10 Q60 -3 74 10 L74 13 Q60 7 46 13 Z" fill="#f5f7fa" />
      <path d="M45 12 Q60 6 75 12 L75 16 Q60 10.5 45 16 Z" fill="#dfe7ee" />
      <circle cx="60" cy="2.5" r="1.8" fill="#3b6ea5" />
    </g>
  </>
);

export const GRUMPY_FACE = () => browedFace("M50 48 Q60 42 70 48");

export const ANTENNAE_SPRITES: Record<LobsterPetAntennae, () => JSX.Element> = {
  perky: () => (
    <>
      <g
        class="lob-antennae"
        stroke="var(--lob-shell)"
        stroke-width="4"
        stroke-linecap="round"
        fill="none"
      >
        <path d="M46 14 Q38 4 31 7" />
        <path d="M74 14 Q82 4 89 7" />
      </g>
    </>
  ),
  droopy: () => (
    <>
      <g
        class="lob-antennae"
        stroke="var(--lob-shell)"
        stroke-width="4"
        stroke-linecap="round"
        fill="none"
      >
        <path d="M46 14 Q36 8 34 18" />
        <path d="M74 14 Q84 8 86 18" />
      </g>
    </>
  ),
};

const CRAB_SPRITE = () => (
  <PasserSprite>
    <>
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
      <path d="M16 58 C2 52 -2 62 4 72 C10 82 20 76 24 66 C26 60 22 58 16 58 Z" fill="#d95f4b" />
      <path
        d="M104 58 C118 52 122 62 116 72 C110 82 100 76 96 66 C94 60 98 58 104 58 Z"
        fill="#d95f4b"
      />
      <path
        d="M48 82 Q60 90 72 82"
        stroke="#7e2a20"
        stroke-width="3"
        stroke-linecap="round"
        fill="none"
      />
    </>
  </PasserSprite>
);

const SNAIL_SPRITE = () => (
  <PasserSprite>
    <>
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
    </>
  </PasserSprite>
);

const DUCK_SPRITE = () => (
  <PasserSprite>
    <>
      <path d="M30 82 Q20 74 27 65 Q30 76 40 79 Z" fill="#f0b52e" />
      <ellipse cx="58" cy="85" rx="34" ry="17" fill="#ffd23e" />
      <circle cx="82" cy="50" r="18" fill="#ffd23e" />
      <path d="M98 49 Q112 52 99 59 Q95 56 95 51 Z" fill="#ff8c2e" />
      <circle cx="86" cy="44" r="3.6" fill="#0a1014" />
      <circle cx="87" cy="43" r="1.3" fill="#ffffff" />
      <path d="M44 82 Q58 72 72 82 Q58 93 44 82 Z" fill="#f0b52e" opacity="0.75" />
    </>
  </PasserSprite>
);

const JELLYFISH_SPRITE = () => (
  <PasserSprite>
    <>
      <g
        class="lob-jelly-tentacles"
        stroke="#9f7dfa"
        stroke-width="2.5"
        stroke-linecap="round"
        fill="none"
        opacity="0.8"
      >
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
    </>
  </PasserSprite>
);

export const PASSER_SPRITES: Record<"crab" | "snail" | "duck" | "jellyfish", () => JSX.Element> = {
  crab: CRAB_SPRITE,
  snail: SNAIL_SPRITE,
  duck: DUCK_SPRITE,
  jellyfish: JELLYFISH_SPRITE,
};

// While hovering, a closed bottle keeps its secret; opening swaps the title
// to the fortune — the pet-name tooltip channel, so no i18n surface.
export function BottleSvg(props: { opened: boolean }) {
  return (
    <>
      <svg class="lobster-bottle__svg" viewBox="0 0 48 44" aria-hidden="true">
        <g transform="rotate(-16 24 30)">
          <rect x="5" y="18" width="30" height="16" rx="7" fill="#7fc8b8" opacity="0.72" />
          <rect x="33" y="22" width="9" height="8" rx="2.5" fill="#7fc8b8" opacity="0.72" />
          {props.opened ? (
            <>
              <rect
                x="36"
                y="20"
                width="11"
                height="7"
                rx="1.5"
                fill="#f2e5c9"
                transform="rotate(-24 41 23)"
              />
              <rect
                x="43"
                y="30"
                width="4.5"
                height="8"
                rx="1.6"
                fill="#8a5a2b"
                transform="rotate(38 45 34)"
              />
            </>
          ) : (
            <>
              <rect x="41" y="21.5" width="5" height="9" rx="1.8" fill="#8a5a2b" />
            </>
          )}
          <rect x="11" y="22" width="12" height="8" rx="1.5" fill="#f2e5c9" />
          <path d="M13 24.5 L21 24.5 M13 27 L19 27" stroke="#b6a071" stroke-width="1" />
          <ellipse cx="13" cy="20.5" rx="5" ry="2" fill="#ffffff" opacity="0.35" />
        </g>
      </svg>
    </>
  );
}

// Balloon entrance rig: rendered inside the body while the descent plays,
// then unmounts with the entering flag.
export const Balloon = () => (
  <>
    <svg class="lobster-pet__balloon" viewBox="0 0 40 62" aria-hidden="true">
      <path d="M20 34 Q23 46 18 60" stroke="#8a949d" stroke-width="1.5" fill="none" />
      <ellipse cx="20" cy="16" rx="13" ry="15" fill="#ff5c8a" />
      <path d="M17 30 L20 34.5 L23 30 Z" fill="#e0446f" />
      <ellipse cx="15" cy="10" rx="4" ry="6" fill="#ffffff" opacity="0.3" />
    </svg>
  </>
);

export const PASSER_TITLES: Record<"stranger" | keyof typeof PASSER_SPRITES, string> = {
  stranger: "a stranger",
  crab: "definitely a lobster",
  snail: "in no particular hurry",
  duck: "a duck. obviously",
  jellyfish: "just drifting",
};
