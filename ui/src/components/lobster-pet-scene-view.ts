import { html, nothing } from "lit";
import { lobsterHonorific } from "./lobster-dex.ts";
import type {
  LobsterPasserKind,
  LobsterPetEntrance,
  LobsterPetLook,
  LobsterPetMode,
  LobsterPetPaletteId,
} from "./lobster-pet-contract.ts";
import {
  createLobsterPetLook,
  lobsterLookStyle,
  lobsterPetName,
  renderLobsterSvg,
} from "./lobster-pet-look.ts";
import {
  lobsterLanePoint,
  lobsterTravelDuration,
  type LobsterComposerScene,
  type LobsterSceneTravel,
} from "./lobster-pet-scene.ts";
import { BALLOON, PASSER_SPRITES, PASSER_TITLES, renderBottleSvg } from "./lobster-pet-sprites.ts";

function strangerLookFor(seed: number, own: LobsterPetPaletteId): LobsterPetLook {
  for (let offset = 1; offset <= 24; offset++) {
    const look = createLobsterPetLook((seed + offset * 7919) >>> 0);
    if (look.palette.id !== own) {
      return look;
    }
  }
  return createLobsterPetLook((seed + 1) >>> 0);
}

function lobsterPetSpriteStyle(
  look: LobsterPetLook,
  scale: number,
  spotPct: number,
  facing: 1 | -1,
) {
  return [
    lobsterLookStyle(look),
    `--lob-scale:${scale}`,
    `--lob-x:${spotPct}%`,
    `--lob-face:${facing}`,
  ].join(";");
}

export function renderLobsterPetScene(args: {
  look: LobsterPetLook;
  mode: LobsterPetMode;
  presence: "out" | "in" | "leaving";
  shellVisible: boolean;
  visitsEnabled: boolean;
  dismissed: boolean;
  passer: {
    kind: LobsterPasserKind;
    direction: 1 | -1;
    crossMs: number;
    anchor: "top" | "floor";
    hops: boolean;
  } | null;
  twinPlanned: boolean;
  anniversary: boolean;
  entering: boolean;
  entrance: LobsterPetEntrance;
  grumpy: boolean;
  vigil: boolean;
  elder: boolean;
  act: string | null;
  spotPct: number;
  facing: 1 | -1;
  anchor: "top" | "floor";
  shellAnchor: "top" | "floor";
  scene: LobsterComposerScene;
  travel: LobsterSceneTravel | null;
  floorEnabled: boolean;
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
  onPointerDown: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: () => void;
  onContextMenu: (event: MouseEvent) => void;
  onBottleOpen: () => void;
}) {
  if (!args.scene.top) {
    return nothing;
  }
  const lane = args.scene[args.anchor] ?? args.scene.top;
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
    const point = lobsterLanePoint(lane, args.spotPct);
    if (twin) {
      point.x = Math.max(lane.start, Math.min(lane.end, point.x - args.facing * 28));
    }
    const scale = twin ? args.look.scale * 0.55 : args.look.scale;
    const style = `${lobsterPetSpriteStyle(args.look, scale, args.spotPct, args.facing)};--lob-x:${point.x}px;--lob-y:${point.y}px${twin ? ";--lob-act-delay:0.18s" : ""}`;
    const travel = args.travel;
    const travelStyle = travel
      ? `--lob-from-x:${travel.from.x - travel.to.x}px;--lob-from-y:${travel.from.y - travel.to.y}px;--lob-travel-ms:${lobsterTravelDuration(travel)}ms${twin ? ";animation-delay:0.18s" : ""}`
      : "";
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
        class="lobster-pet__motion ${travel ? (travel.hop ? "lobster-pet__motion--hop" : "lobster-pet__motion--walk") : ""}"
        style=${travelStyle}
      >
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
      </div>
    `;
  };
  const showSprites = args.presence !== "out";
  // The shell may outlive the visit while it fades, but dismissal and the
  // visits setting silence it like everything else.
  const showShell = args.shellVisible && args.visitsEnabled && !args.dismissed;
  const showPasser =
    args.passer !== null &&
    args.visitsEnabled &&
    !args.dismissed &&
    (args.passer.anchor === "top" || (args.floorEnabled && args.scene.floor !== null));
  // The bottle washes ashore whether or not the pet is around; it belongs to
  // the ledge, not the visit. Like every sprite here it is intentionally
  // aria-hidden and pointer-only, with fortunes on the native-tooltip channel
  // (no i18n surface); it must not join the tab order, where a surprise
  // easter-egg button would degrade keyboard flow.
  const showBottle = args.bottle !== null && args.visitsEnabled && !args.dismissed;
  if (!showSprites && !showShell && !showPasser && !showBottle) {
    return nothing;
  }
  // The abandoned shell: the pre-molt silhouette, frozen and slowly fading.
  const shellStyle = lobsterPetSpriteStyle(
    args.look,
    args.shellScale,
    args.shellSpotPct,
    args.facing,
  );
  const shellPoint = lobsterLanePoint(args.scene[args.shellAnchor], args.shellSpotPct);
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
        args.passer.hops && args.scene.passage ? "lobster-pet--passer-hop" : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const passerLane = args.passer ? args.scene[args.passer.anchor] : null;
  const passingGap =
    args.passer?.hops && args.scene.passage
      ? args.scene.passage
      : [passerLane?.start ?? 0, passerLane?.end ?? 0];
  const fromX = args.passer?.direction === 1 ? passingGap[0] : passingGap[1];
  const toX = args.passer?.direction === 1 ? passingGap[1] : passingGap[0];
  const passerStyle = args.passer
    ? `${passerBaseStyle(args.passer.kind, args.passer.direction, passerLook)};--lob-cross:${args.passer.crossMs}ms;--lob-cross-from:${fromX}px;--lob-cross-to:${toX}px;--lob-y:${passerLane?.y ?? 0}px`
    : "";
  const bottlePoint = lobsterLanePoint(args.scene.top, args.bottle?.spotPct ?? 50);
  return html`
    ${
      showShell
        ? html`
            <div
              class="lobster-pet lobster-pet--shell"
              style=${`${shellStyle};--lob-x:${shellPoint.x}px;--lob-y:${shellPoint.y}px`}
              aria-hidden="true"
            >
              <div class="lobster-pet__body">${renderLobsterSvg(args.look, { shell: true })}</div>
            </div>
          `
        : nothing
    }
    ${
      showBottle && args.bottle
        ? html`
            <div
              class="lobster-bottle ${args.bottle.opened ? "lobster-bottle--open" : ""}"
              style="--lob-x:${bottlePoint.x}px"
              title=${args.bottle.opened ? args.bottle.fortune : "a message in a bottle"}
              aria-hidden="true"
              @pointerdown=${args.onBottleOpen}
            >
              ${renderBottleSvg(args.bottle.opened)}
            </div>
          `
        : nothing
    }
    ${showSprites ? renderSprite(false) : nothing}
    ${showSprites && args.twinPlanned ? renderSprite(true) : nothing}
    ${
      showPasser && args.passer
        ? html`
            <div
              class=${passerClasses}
              style=${passerStyle}
              aria-hidden="true"
              title=${PASSER_TITLES[args.passer.kind]}
            >
              <div class="lobster-pet__body">
                ${
                  args.passer.kind === "stranger"
                    ? renderLobsterSvg(passerLook, { standalone: true })
                    : PASSER_SPRITES[args.passer.kind]()
                }
              </div>
            </div>
          `
        : nothing
    }
  `;
}

// Non-lobster passers ignore the perch variables and carry fixed sprite
// proportions; strangers reuse the full look pipeline (capped size so a
// visiting grail does not upstage the resident).
function passerBaseStyle(
  kind: LobsterPasserKind,
  direction: 1 | -1,
  passerLook: LobsterPetLook,
): string {
  if (kind === "stranger") {
    return lobsterPetSpriteStyle(passerLook, Math.min(passerLook.scale, 2), 0, direction);
  }
  const fixed: Record<Exclude<LobsterPasserKind, "stranger">, string> = {
    crab: "--lob-scale:2;--lob-w:1;--lob-h:0.82;--lob-face:1",
    snail: `--lob-scale:1.7;--lob-w:1;--lob-h:0.9;--lob-face:${direction}`,
    duck: `--lob-scale:1.9;--lob-w:1;--lob-h:1;--lob-face:${direction}`,
    jellyfish: "--lob-scale:1.7;--lob-w:0.9;--lob-h:1.1;--lob-face:1",
  };
  return fixed[kind];
}
