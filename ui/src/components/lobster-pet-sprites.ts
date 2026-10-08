import { svg, type SVGTemplateResult, type TemplateResult } from "lit";
import { LOBSTER_HAT_SPRITES } from "./lobster-hat-sprites.ts";
import type {
  LobsterPetAccessory,
  LobsterPetAntennae,
  LobsterPetPaletteId,
} from "./lobster-pet-contract.ts";
import {
  CHIMERA_STITCHES,
  ECLIPSE_CORONA,
  NOTEXTURE_CHECKER,
  WATERMELON_RIND,
} from "./lobster-pet-sprites-wild.ts";

export const ACCESSORY_SPRITES: Record<Exclude<LobsterPetAccessory, "none">, TemplateResult> = {
  crown: LOBSTER_HAT_SPRITES.crown,
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
  santa: LOBSTER_HAT_SPRITES.santa,
  pumpkin: LOBSTER_HAT_SPRITES.pumpkin,
  party: LOBSTER_HAT_SPRITES.party,
  barnacle: svg`
    <g class="lob-barnacles">
      <path d="M32 22 L36.5 13 L41 22 Z" fill="#cfd8de" />
      <path d="M42 18 L45.5 11 L49 18 Z" fill="#b8c4cc" />
      <path d="M27 26 L30 20.5 L33 26 Z" fill="#b8c4cc" />
      <circle cx="36.5" cy="18.5" r="1.1" fill="#8a949d" />
      <circle cx="45.5" cy="15" r="0.9" fill="#8a949d" />
    </g>
  `,
  monocle: svg`
    <g class="lob-monocle" fill="none" stroke="#f4b840">
      <circle cx="75" cy="32" r="8.5" stroke-width="2.5" />
      <path d="M81 39 Q85 48 80 56" stroke-width="1.5" />
    </g>
  `,
};

export const FRECKLE_SPOTS = svg`
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

const MAGMA_SEAMS = svg`
  <g class="lob-magma" fill="none" stroke="#ff6a3d" stroke-width="2" stroke-linecap="round">
    <path d="M40 44 L48 54 L42 66 L50 78" />
    <path d="M74 40 L68 52 L78 64" />
    <path d="M56 82 L62 90" />
  </g>
`;

const OILSLICK_SHEEN = svg`
  <g class="lob-oilsheen">
    <ellipse cx="46" cy="60" rx="22" ry="11" fill="#7f77dd" opacity="0.3" transform="rotate(-14 46 60)" />
    <ellipse cx="76" cy="74" rx="17" ry="8" fill="#1d9e75" opacity="0.28" transform="rotate(10 76 74)" />
  </g>
`;

const AURORA_BANDS = svg`
  <g class="lob-aurora" fill="none" stroke-linecap="round">
    <path class="lob-aurora__band1" d="M24 62 Q48 48 70 58 T102 54" stroke="#4ecfa6" stroke-width="6" opacity="0.5" />
    <path class="lob-aurora__band2" d="M28 76 Q54 62 78 72 T100 68" stroke="#a184ec" stroke-width="5" opacity="0.45" />
  </g>
`;

const NEBULA_STARS = svg`
  <g class="lob-nebula-stars">
    <circle cx="38" cy="52" r="1" fill="#fff" />
    <circle cx="52" cy="70" r="1.2" fill="#fff" />
    <circle cx="84" cy="48" r="1.4" fill="#fff" />
    <circle cx="66" cy="86" r="1" fill="#fff" />
    <circle cx="72" cy="60" r="1.6" fill="#8be9fd" />
    <circle cx="46" cy="40" r="1.4" fill="#ff9de2" />
    <path class="lob-twinkle" d="M60 52 L61.5 55.5 L65 57 L61.5 58.5 L60 62 L58.5 58.5 L55 57 L58.5 55.5 Z" fill="#fff" />
  </g>
`;

const GLASS_GLINTS = svg`
  <g class="lob-glass-glints" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" opacity="0.7">
    <path d="M34 22 L28 32" />
    <path d="M40 16 L37 22" />
  </g>
`;

const GEODE_FACETS = svg`
  <g class="lob-geode-facets">
    <polygon points="70,34 80,30 78,44" fill="#9b6ff0" />
    <polygon points="82,46 94,42 88,58" fill="#b48ef0" />
    <polygon points="72,58 84,62 74,74" fill="#7a4fd0" />
    <polygon points="86,68 96,64 90,80" fill="#9b6ff0" />
    <circle class="lob-twinkle" cx="90" cy="50" r="1.8" fill="#fff" />
  </g>
`;

const PHOSPHOR_SCANLINES = svg`
  <g class="lob-scanlines" stroke="#3fff7d" stroke-width="1" opacity="0.16">
    <path d="M40 20 H80 M30 27 H90 M26 34 H94 M21 41 H99 M18 48 H102 M17 55 H103 M17 62 H103 M18 69 H102 M22 76 H98 M31 83 H89 M45 90 H75" />
  </g>
`;

export const GLITCH_GHOSTS = svg`
  <g class="lob-glitch-ghosts">
    <path d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z" transform="translate(-3 0)" fill="#ff3355" opacity="0.4" />
    <path d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z" transform="translate(3 1)" fill="#22d3ee" opacity="0.4" />
  </g>
`;

const BLUEPRINT_MARKS = svg`
  <g class="lob-blueprint" fill="none" stroke="#cfe3ff">
    <path class="lob-bp-outline" d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z" stroke-width="1.5" stroke-dasharray="5 3" />
    <path d="M54 58 H66 M60 52 V64" stroke-width="1" opacity="0.7" />
    <path d="M16 100 H104" stroke-width="1" stroke-dasharray="2 3" opacity="0.7" />
  </g>
`;

// Laurel and imperial sash belong to the shell, not the random wardrobe.
const CLAWNSTANTINE_REGALIA = svg`
  <g class="lob-clawnstantine">
    <path d="M18 48 Q60 62 102 48 L104 52 C104 72 90 90 76 95 Q60 98 44 95 C30 90 16 72 16 52 Z" fill="#4e296e" />
    <path d="M28 61 Q30 72 39 78 M70 88 Q82 82 91 65" fill="none" stroke="#a576c4" stroke-width="1.6" stroke-linecap="round" />
    <!-- The lower edge follows the shell contour so the sash wraps around it. -->
    <path d="M81.5 45.5 C70 64 50 78 29.9 85.444 C32.971 88.632 36.349 91.249 39.814 93.121 C62 85 81 68 90.5 50.5 Z" fill="#e5bc62" />
    <path d="M84 51 C73 68 57 80 39 87" fill="none" stroke="#fff0bc" stroke-width="1.6" stroke-linecap="round" />
    <circle cx="85" cy="49" r="6" fill="#e5bc62" />
    <circle cx="85" cy="49" r="3" fill="#58c8b5" />
    <g class="lob-clawnstantine__laurel" fill="#e5bc62" stroke="#bd8a38" stroke-width="0.6">
      <path d="M31 27 Q31 15 50 11 M89 27 Q89 15 70 11" fill="none" stroke="#e5bc62" stroke-width="2" />
      <path d="M33 25 Q23 21 28 15 Q35 17 33 25 Z M37 19 Q28 13 34 9 Q41 12 37 19 Z M43 14 Q38 7 44 6 Q49 9 43 14 Z" />
      <path d="M87 25 Q97 21 92 15 Q85 17 87 25 Z M83 19 Q92 13 86 9 Q79 12 83 19 Z M77 14 Q82 7 76 6 Q71 9 77 14 Z" />
    </g>
  </g>
`;

// Face paint rides the shell; the shared renderer draws the eyes above it.
const CLAWIE_STARDUST_BOLT = svg`
  <g class="lob-clawiestardust">
    <path d="M72 14 L57 49 L70 43 L51 89 L85 38 L72 44 L83 18 Z" fill="#4dc8eb" transform="translate(2.5 0)" />
    <path d="M72 14 L57 49 L70 43 L51 89 L85 38 L72 44 L83 18 Z" fill="#e6393d" />
  </g>
`;

// Direct claw paths inherit the existing size transform as well as wave/snip.
const MICROPHONE = svg`
  <path class="lob-microphone" d="M106 32 L112 34 L106 56 Q105 58 103 57 Q101 56 102 54 Z" fill="#343747" />
  <path class="lob-microphone" d="M103 27 A7 7 0 1 1 117 27 A7 7 0 1 1 103 27 Z" fill="#666a80" />
  <path class="lob-microphone" d="M106 23 L114 25 M105 27 L113 29" fill="none" stroke="#e7e7f0" stroke-width="1.5" stroke-linecap="round" />
`;

const LEONARDO_PAINTBRUSH = svg`
  <path class="lob-leonardodepinchy__brush" d="M107 32 L112 33 L106 57 Q104 59 102 56 Z" fill="#855233" />
  <path class="lob-leonardodepinchy__brush" d="M106 27 L114 29 L112 36 L104 34 Z" fill="#b4b7b5" />
  <path class="lob-leonardodepinchy__brush" d="M106 27 C105 21 110 18 111 11 C119 21 118 26 114 29 Z" fill="#e6c88e" />
  <path class="lob-leonardodepinchy__brush" d="M111 11 Q114 16 115 18 Q111 21 108 22 Q110 16 111 11 Z" fill="#4a89b8" />
`;

const TELEPHONE_RECEIVER = svg`
  <path class="lob-telephone-receiver" d="M105 33 L112 34 L108 56 Q105 59 102 55 Z" fill="#4b3c30" />
  <path class="lob-telephone-receiver" d="M102 29 C104 21 113 21 117 29 L117 34 Q109 39 101 34 Z" fill="#35312f" />
  <path class="lob-telephone-receiver" d="M103 30 Q110 34 116 30" fill="none" stroke="#bc955c" stroke-width="2" stroke-linecap="round" />
  <path class="lob-telephone-receiver" d="M105 56 Q101 63 108 65 Q115 67 110 71 Q106 74 112 77" fill="none" stroke="#574631" stroke-width="1.8" stroke-linecap="round" />
`;

export const PALETTE_RIGHT_CLAW_PROPS: Partial<Record<LobsterPetPaletteId, TemplateResult>> = {
  taylorpinch: MICROPHONE,
  shellvis: MICROPHONE,
  leonardodepinchy: LEONARDO_PAINTBRUSH,
  alexandergrahamshell: TELEPHONE_RECEIVER,
};

const TAYLOR_PINCH_SPARKLES = svg`
  <g class="lob-taylorpinch">
    <path d="M51 44 Q56 40 60 43 Q64 40 69 44 Q60 54 51 44 Z" fill="#c92e48" />
    <path d="M16 52 Q37 50 60 62 Q83 50 104 52 C104 72 90 90 76 95 Q60 98 44 95 C30 90 16 72 16 52 Z" fill="#9c82cf" />
    <path d="M22 57 Q40 56 60 68 Q80 56 98 57" fill="none" stroke="#d5c4f2" stroke-width="2" stroke-linecap="round" />
    <g fill="#fff4fb">
      <path d="M36 65 L37.5 69.5 L42 71 L37.5 72.5 L36 77 L34.5 72.5 L30 71 L34.5 69.5 Z" />
      <path d="M79 72 L80.5 76.5 L85 78 L80.5 79.5 L79 84 L77.5 79.5 L73 78 L77.5 76.5 Z" />
      <circle cx="57" cy="79" r="1.5" /><circle cx="67" cy="88" r="1.5" /><circle cx="87" cy="64" r="1.5" />
    </g>
  </g>
`;

const CLAWTOO_DEETOO_PANELS = svg`
  <g class="lob-clawtoodeetoo">
    <path d="M27 26 C35 14 45 8 60 8 C75 8 85 14 93 26 Q60 19 27 26 Z" fill="#b8c3cf" />
    <g fill="#2d5cbd">
      <path d="M37 17 L46 12 L46 22 L34 24 Z M54 9 H66 L67 21 H53 Z M74 12 L84 17 L86 24 L74 22 Z" />
      <path d="M20 46 Q60 42 100 46 L101 53 Q60 49 19 53 Z" />
      <rect x="53" y="58" width="14" height="9" rx="1.5" />
      <rect x="53" y="71" width="14" height="9" rx="1.5" />
    </g>
    <g fill="none" stroke="#9ba8b7" stroke-width="1.5">
      <rect x="32" y="59" width="13" height="25" rx="2" /><rect x="75" y="59" width="13" height="25" rx="2" />
      <path d="M54 86 H66 M54 90 H66" stroke-linecap="round" />
    </g>
    <circle cx="87" cy="49" r="2.5" fill="#ef5261" />
  </g>
`;

const LEONARDO_SMOCK = svg`
  <g class="lob-leonardodepinchy">
    <path d="M18 48 Q60 61 102 48 L104 52 C104 72 90 90 76 95 Q60 98 44 95 C30 90 16 72 16 52 Z" fill="#5f6950" />
    <path d="M60 63 V93 M27 64 Q31 77 40 84 M93 64 Q89 77 80 84" fill="none" stroke="#87906e" stroke-width="1.6" stroke-linecap="round" />
    <path d="M40 42 Q60 52 80 42 Q78 58 60 66 Q42 58 40 42 Z" fill="#eee3ce" />
    <path d="M52 49 Q60 54 68 49" fill="none" stroke="#c7b99e" stroke-width="1.5" stroke-linecap="round" />
    <path d="M25 24 C29 9 51 5 67 8 C83 4 96 10 95 20 Q71 29 25 24 Z" fill="#49352c" />
    <path d="M28 23 Q61 27 91 21" fill="none" stroke="#765545" stroke-width="2" stroke-linecap="round" />
    <circle cx="38" cy="72" r="3" fill="#bd644f" /><circle cx="77" cy="81" r="3" fill="#4a89b8" /><circle cx="83" cy="65" r="2.5" fill="#dfb34f" />
  </g>
`;

const SHELLVIS_JUMPSUIT = svg`
  <g class="lob-shellvis">
    <path d="M18 48 L43 47 L60 62 L77 47 L102 48 L104 52 C104 72 90 90 76 95 Q60 98 44 95 C30 90 16 72 16 52 Z" fill="#fff7e9" />
    <path d="M43 49 L48 66 L60 61 L72 66 L77 49 M26 80 Q60 87 94 80" fill="none" stroke="#d7ab4c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M53 46 L60 50 L67 46 L64 54 L72 74 L65 71 L59 56 L51 68 L48 63 L56 53 Z" fill="#c84248" />
    <rect x="56" y="80" width="8" height="6" rx="1.5" fill="#d7ab4c" />
    <path d="M24 26 Q21 10 41 9 Q42 1 62 5 C76 1 96 7 96 19 L91 29 Q82 21 77 20 Q59 31 43 21 Q34 21 24 26 Z" fill="#29272d" />
    <path d="M35 17 Q50 10 61 13 Q75 8 85 15" fill="none" stroke="#4d4750" stroke-width="2" stroke-linecap="round" />
    <path d="M25 27 L32 25 L32 42 L26 38 Z M88 25 L95 27 L94 38 L88 42 Z" fill="#29272d" />
  </g>
`;

const GRAHAM_SHELL_WAISTCOAT = svg`
  <g class="lob-alexandergrahamshell">
    <path d="M18 48 Q60 58 102 48 L104 52 C104 72 90 90 76 95 Q60 98 44 95 C30 90 16 72 16 52 Z" fill="#3d4b53" />
    <path d="M37 47 L49 73 L60 63 L71 73 L83 47" fill="#f1ebdf" />
    <path d="M35 61 L45 86 M85 61 L75 86" fill="none" stroke="#65747a" stroke-width="1.6" stroke-linecap="round" />
    <path d="M28 29 Q25 18 35 15 L38 32 L32 42 Z M92 29 Q95 18 85 15 L82 32 L88 42 Z" fill="#c9ceca" />
    <path d="M31 38 Q40 47 47 43 Q60 52 73 43 Q80 47 89 38 Q88 59 76 66 Q71 76 60 77 Q49 76 44 66 Q32 59 31 38 Z" fill="#dfe0dc" />
    <path d="M51 52 Q60 57 69 52 M49 65 Q60 72 71 65" fill="none" stroke="#b8beba" stroke-width="1.5" stroke-linecap="round" />
    <path d="M50 78 L60 81 L70 78 V86 L60 83 L50 86 Z" fill="#8f3347" />
    <circle cx="60" cy="91" r="1.8" fill="#bc955c" />
  </g>
`;

const MECHA_PLATES = svg`
  <g class="lob-mecha">
    <g fill="none" stroke="#5f6a75" stroke-width="1.5">
      <path d="M28 56 Q60 66 92 56" />
      <path d="M34 74 Q60 82 86 74" />
    </g>
    <g fill="#5f6a75">
      <circle cx="36" cy="61" r="1.4" />
      <circle cx="60" cy="64" r="1.4" />
      <circle cx="84" cy="61" r="1.4" />
    </g>
    <circle class="lob-led" cx="89" cy="7" r="3" fill="#ff4444" />
  </g>
`;

export function SELENE_MOON(phaseIndex: number): TemplateResult {
  const phase = ((Math.round(phaseIndex) % 8) + 8) % 8;
  if (phase === 0) {
    return svg`<g class="lob-selene-moon"><circle cx="60" cy="64" r="12" fill="#26304a" /><circle cx="60" cy="64" r="11" fill="none" stroke="#f4f7fc" stroke-width="1" /></g>`;
  }
  if (phase === 4) {
    return svg`<g class="lob-selene-moon"><circle cx="60" cy="64" r="12" fill="#26304a" /><circle cx="60" cy="64" r="11" fill="#f4f7fc" /></g>`;
  }
  const darkOffset = phase < 4 ? [-5, -9, -14][phase - 1] : [14, 9, 5][phase - 5];
  return svg`
    <g class="lob-selene-moon">
      <circle cx="60" cy="64" r="12" fill="#26304a" />
      <circle cx="60" cy="64" r="11" fill="#f4f7fc" />
      <circle cx=${60 + (darkOffset ?? 0)} cy="64" r="11" fill="#26304a" />
    </g>
  `;
}

export function PIXEL_LOBSTER(openEyeStyle: string, closedEyeStyle: string): TemplateResult {
  return svg`
    <g class="lob-pixel-frame" shape-rendering="crispEdges">
      <g class="lob-pixel-antennae" fill="#d84c3e">
        <rect x="30" y="0" width="6" height="6" /><rect x="36" y="6" width="6" height="6" /><rect x="42" y="12" width="6" height="6" />
        <rect x="84" y="0" width="6" height="6" /><rect x="78" y="6" width="6" height="6" /><rect x="72" y="12" width="6" height="6" />
      </g>
      <g class="lob-pixel-claws">
        <path d="M18 42 H6 V48 H0 V60 H6 V66 H18 V60 H24 V48 H18 Z M6 48 H12 V60 H6 Z" fill="#d84c3e" />
        <rect x="6" y="60" width="12" height="6" fill="#a83428" />
        <path d="M102 42 H114 V48 H120 V60 H114 V66 H102 V60 H96 V48 H102 Z M108 48 H114 V60 H108 Z" fill="#d84c3e" />
        <rect x="102" y="60" width="12" height="6" fill="#a83428" />
      </g>
      <!-- Main cells keep the palette variable so offline and mood-style tinting still read. -->
      <g class="lob-pixel-body" fill="var(--lob-shell, #d84c3e)">
        <rect x="42" y="12" width="36" height="6" /><rect x="36" y="18" width="48" height="6" />
        <rect x="30" y="24" width="60" height="6" /><rect x="24" y="30" width="72" height="48" />
        <rect x="30" y="78" width="60" height="12" /><rect x="36" y="90" width="48" height="6" />
        <rect x="36" y="96" width="12" height="9" /><rect x="72" y="96" width="12" height="9" />
      </g>
      <g fill="#ef8f6a"><rect x="36" y="24" width="24" height="6" /><rect x="30" y="30" width="18" height="12" /><rect x="24" y="42" width="12" height="12" /></g>
      <g fill="#a83428"><rect x="30" y="78" width="60" height="12" /><rect x="36" y="90" width="48" height="6" /><rect x="36" y="96" width="12" height="9" /><rect x="72" y="96" width="12" height="9" /></g>
      <g class="lob-eye-open" style=${openEyeStyle}>
        <rect x="42" y="30" width="6" height="6" fill="#0a1014" /><rect x="72" y="30" width="6" height="6" fill="#0a1014" />
        <rect x="42" y="30" width="2.5" height="2.5" fill="#fff" /><rect x="72" y="30" width="2.5" height="2.5" fill="#fff" />
      </g>
      <g class="lob-eye-closed" style=${closedEyeStyle} fill="#0a1014"><rect x="42" y="33" width="6" height="3" /><rect x="72" y="33" width="6" height="3" /></g>
    </g>
  `;
}

// Palettes whose identity is already pattern-driven skip the freckle trait;
// stacking speckle sets reads as noise, not a variant.
export const PATTERNED_PALETTES: ReadonlySet<LobsterPetPaletteId> = new Set([
  "split",
  "retro",
  "lumen",
  "magma",
  "oilslick",
  "aurora",
  "nebula",
  "glass",
  "geode",
  "phosphor",
  "heisenbug",
  "blueprint",
  "clawnstantine",
  "clawiestardust",
  "taylorpinch",
  "clawtoodeetoo",
  "leonardodepinchy",
  "shellvis",
  "alexandergrahamshell",
  "clawtron",
  "selene",
  "pixel",
  "banana",
  "bee",
  "rubberduck",
  "watermelon",
  "sourdough",
  "zombie",
  "plush",
  "balloon",
  "disco",
  "cryptid",
  "flatpack",
  "tinfoil",
  "actual",
  "chimera",
  "notexture",
  "loading",
  "eclipse",
  "ascii",
  "portal",
  "invisible",
  "goldenretro",
]);

const BANANA_MARKS = svg`
  <g fill="#8a6430">
    <rect x="56" y="8" width="8" height="6" rx="2.5" />
    <ellipse cx="60" cy="91" rx="6" ry="3.5" />
    <circle cx="37" cy="48" r="2.5" />
    <circle cx="79" cy="55" r="2" />
    <circle cx="47" cy="70" r="1.8" />
    <circle cx="72" cy="79" r="2.3" />
  </g>
`;

const BEE_PARTS = svg`
  <g class="lob-bee-wings" fill="#ffffff" opacity="0.45">
    <ellipse cx="38" cy="14" rx="8" ry="4.5" transform="rotate(-24 38 14)" />
    <ellipse cx="82" cy="14" rx="8" ry="4.5" transform="rotate(24 82 14)" />
  </g>
  <g fill="#2b2b23" opacity="0.9">
    <path d="M19 42 Q60 51 101 42 L103 50 Q60 60 17 50 Z" />
    <path d="M17 58 Q60 67 103 58 L101 67 Q60 76 19 67 Z" />
    <path d="M24 76 Q60 84 96 76 L90 85 Q60 92 30 85 Z" />
  </g>
`;

const DUCK_BILL = svg`
  <g>
    <ellipse cx="60" cy="71" rx="21" ry="14" fill="#ffffff" opacity="0.5" />
    <rect x="47" y="41" width="26" height="8" rx="4" fill="#ff9a2e" />
    <rect x="50" y="47" width="20" height="5" rx="2.5" fill="#e98322" />
  </g>
`;

const SOURDOUGH_SCORING = svg`
  <g fill="none" stroke="#a8763e" stroke-width="2.5" stroke-linecap="round">
    <path d="M38 23 Q45 29 52 30" />
    <path d="M52 17 Q59 24 66 25" />
    <path d="M67 18 Q74 24 81 25" />
  </g>
  <g fill="#ffffff" opacity="0.5">
    <circle cx="34" cy="39" r="1.2" /><circle cx="86" cy="38" r="1" />
    <circle cx="45" cy="57" r="1.4" /><circle cx="74" cy="62" r="1.1" />
    <circle cx="56" cy="78" r="1" /><circle cx="83" cy="75" r="1.3" />
  </g>
`;

const ZOMBIE_STITCHES = svg`
  <g fill="none" stroke="#5a6b52" stroke-width="2" stroke-linecap="round">
    <path d="M32 24 Q47 19 61 23" />
    <path d="M38 19 L40 26 M46 18 L47 25 M54 19 L53 26" />
    <path d="M57 72 Q72 78 87 72" />
    <path d="M65 72 L63 79 M73 73 L72 80 M81 71 L83 78" />
  </g>
  <ellipse cx="35" cy="61" rx="9" ry="6" fill="#86987a" opacity="0.8" transform="rotate(-18 35 61)" />
`;

const PLUSH_SEAMS = svg`
  <g fill="none" stroke="#c97a5e" stroke-width="1.5" stroke-dasharray="3 3">
    <path d="M30 32 Q60 4 90 32" />
    <path d="M60 50 Q58 72 60 96" />
  </g>
  <g class="lob-plush-button">
    <circle cx="78" cy="44" r="3.5" fill="#7a4a3a" />
    <circle cx="76.8" cy="44" r="0.7" fill="#e8967a" />
    <circle cx="79.2" cy="44" r="0.7" fill="#e8967a" />
  </g>
`;

const DISCO_FACETS = svg`
  <g class="lob-disco" fill="#ffffff">
    <rect x="42" y="18" width="4" height="4" opacity="0.3" /><rect x="52" y="16" width="4" height="4" opacity="0.5" />
    <rect x="63" y="17" width="4" height="4" opacity="0.25" /><rect x="74" y="20" width="4" height="4" opacity="0.4" />
    <rect x="31" y="40" width="4" height="4" opacity="0.4" /><rect x="53" y="39" width="4" height="4" opacity="0.25" />
    <rect x="65" y="42" width="4" height="4" opacity="0.5" /><rect x="86" y="40" width="4" height="4" opacity="0.3" />
    <rect x="39" y="59" width="4" height="4" opacity="0.25" /><rect x="51" y="62" width="4" height="4" opacity="0.45" />
    <rect x="68" y="60" width="4" height="4" opacity="0.3" /><rect x="80" y="58" width="4" height="4" opacity="0.5" />
    <rect x="49" y="79" width="4" height="4" opacity="0.35" /><rect x="70" y="80" width="4" height="4" opacity="0.25" />
  </g>
`;

export const PALETTE_OVERLAYS: Partial<Record<LobsterPetPaletteId, TemplateResult>> = {
  lumen: LUMEN_SPOTS,
  magma: MAGMA_SEAMS,
  oilslick: OILSLICK_SHEEN,
  aurora: AURORA_BANDS,
  nebula: NEBULA_STARS,
  glass: GLASS_GLINTS,
  geode: GEODE_FACETS,
  phosphor: PHOSPHOR_SCANLINES,
  blueprint: BLUEPRINT_MARKS,
  clawnstantine: CLAWNSTANTINE_REGALIA,
  clawiestardust: CLAWIE_STARDUST_BOLT,
  taylorpinch: TAYLOR_PINCH_SPARKLES,
  clawtoodeetoo: CLAWTOO_DEETOO_PANELS,
  leonardodepinchy: LEONARDO_SMOCK,
  shellvis: SHELLVIS_JUMPSUIT,
  alexandergrahamshell: GRAHAM_SHELL_WAISTCOAT,
  clawtron: MECHA_PLATES,
  banana: BANANA_MARKS,
  bee: BEE_PARTS,
  rubberduck: DUCK_BILL,
  sourdough: SOURDOUGH_SCORING,
  zombie: ZOMBIE_STITCHES,
  plush: PLUSH_SEAMS,
  disco: DISCO_FACETS,
  watermelon: WATERMELON_RIND,
  eclipse: ECLIPSE_CORONA,
  notexture: NOTEXTURE_CHECKER,
  chimera: CHIMERA_STITCHES,
};

// Split two-tone: the right half of the body (down to the belly midline)
// repainted in the second shell color; the right claw and antenna follow via
// CSS. Mirrors the famous bilateral half-and-half lobsters.
export const SPLIT_HALF = svg`
  <path
    class="lob-split-half"
    d="M60 8 C88 8 104 32 104 52 C104 72 90 90 76 95 L76 104 L66 104 L66 96 C64 96.8 62 97.1 60 97.1 L60 8 Z"
    fill="var(--lob-shell2, #46536b)"
  />
`;

// Retro homage parts (classic OpenClaw logo): one oversized raised claw with
// a pincer notch, tall V antennae, angry brows, and a smirk. The mega claw
// lives inside the .lob-claw--r group so wave/snip acts swing it.
export const RETRO_MEGA_CLAW = svg`
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
`;

export const RETRO_ANTENNAE = svg`
  <g class="lob-antennae" stroke="var(--lob-shell)" stroke-width="4" stroke-linecap="round" fill="none">
    <path d="M50 16 Q45 4 37 1" />
    <path d="M70 16 Q75 4 83 1" />
  </g>
`;

export const RETRO_FACE = svg`
  <g stroke="#0a1014" stroke-linecap="round" fill="none">
    <path d="M37 24 L51 28" stroke-width="3.5" />
    <path d="M69 28 L83 24" stroke-width="3.5" />
    <path d="M49 45 Q59 51 69 45 L72 42" stroke-width="3" />
  </g>
`;

// Tail-fan lobes peek out diagonally behind the lower body (drawn before the
// body path so they read as "behind"). Fill color lives in lobster-pet.css.
export const TAIL_FAN = svg`
  <g class="lob-tail">
    <ellipse cx="16" cy="84" rx="11" ry="7" transform="rotate(-32 16 84)" />
    <ellipse cx="104" cy="84" rx="11" ry="7" transform="rotate(32 104 84)" />
  </g>
`;

export const BINDLE = svg`
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
export const HEADWEAR: ReadonlySet<LobsterPetAccessory> = new Set([
  "crown",
  "sprout",
  "santa",
  "pumpkin",
  "party",
]);

export const SAILOR_CAP = svg`
  <g class="lob-cap">
    <path d="M46 10 Q60 -3 74 10 L74 13 Q60 7 46 13 Z" fill="#f5f7fa" />
    <path d="M45 12 Q60 6 75 12 L75 16 Q60 10.5 45 16 Z" fill="#dfe7ee" />
    <circle cx="60" cy="2.5" r="1.8" fill="#3b6ea5" />
  </g>
`;

export const GRUMPY_FACE = svg`
  <g stroke="#0a1014" stroke-linecap="round" fill="none">
    <path d="M37 24 L51 28" stroke-width="3.5" />
    <path d="M69 28 L83 24" stroke-width="3.5" />
    <path d="M50 48 Q60 42 70 48" stroke-width="3" />
  </g>
`;

export const ANTENNAE_SPRITES: Record<LobsterPetAntennae, TemplateResult> = {
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

function passerSprite(content: SVGTemplateResult): SVGTemplateResult {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      ${content}
    </svg>
  `;
}

const CRAB_SPRITE = passerSprite(svg`
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
`);

const SNAIL_SPRITE = passerSprite(svg`
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
`);

const DUCK_SPRITE = passerSprite(svg`
    <path d="M30 82 Q20 74 27 65 Q30 76 40 79 Z" fill="#f0b52e" />
    <ellipse cx="58" cy="85" rx="34" ry="17" fill="#ffd23e" />
    <circle cx="82" cy="50" r="18" fill="#ffd23e" />
    <path d="M98 49 Q112 52 99 59 Q95 56 95 51 Z" fill="#ff8c2e" />
    <circle cx="86" cy="44" r="3.6" fill="#0a1014" />
    <circle cx="87" cy="43" r="1.3" fill="#ffffff" />
    <path d="M44 82 Q58 72 72 82 Q58 93 44 82 Z" fill="#f0b52e" opacity="0.75" />
`);

const JELLYFISH_SPRITE = passerSprite(svg`
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
`);

export const PASSER_SPRITES: Record<"crab" | "snail" | "duck" | "jellyfish", TemplateResult> = {
  crab: CRAB_SPRITE,
  snail: SNAIL_SPRITE,
  duck: DUCK_SPRITE,
  jellyfish: JELLYFISH_SPRITE,
};

// While hovering, a closed bottle keeps its secret; opening swaps the title
// to the fortune — the pet-name tooltip channel, so no i18n surface.
export function renderBottleSvg(opened: boolean) {
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
export const BALLOON = svg`
  <svg class="lobster-pet__balloon" viewBox="0 0 40 62" aria-hidden="true">
    <path d="M20 34 Q23 46 18 60" stroke="#8a949d" stroke-width="1.5" fill="none" />
    <ellipse cx="20" cy="16" rx="13" ry="15" fill="#ff5c8a" />
    <path d="M17 30 L20 34.5 L23 30 Z" fill="#e0446f" />
    <ellipse cx="15" cy="10" rx="4" ry="6" fill="#ffffff" opacity="0.3" />
  </svg>
`;

export const PASSER_TITLES: Record<"stranger" | keyof typeof PASSER_SPRITES, string> = {
  stranger: "a stranger",
  crab: "definitely a lobster",
  snail: "in no particular hurry",
  duck: "a duck. obviously",
  jellyfish: "just drifting",
};
