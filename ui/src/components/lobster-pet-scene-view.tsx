import { dynamic, type JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import {
  isThemeCritterId,
  type ThemeArtwork,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { lobsterHonorific } from "./lobster-dex.ts";
import { LobsterSvg } from "./lobster-pet-artwork.tsx";
import type {
  LobsterPasserKind,
  LobsterPetEntrance,
  LobsterPetLook,
  LobsterPetMode,
  LobsterPetPaletteId,
} from "./lobster-pet-contract.ts";
import { createLobsterPetLook, lobsterLookStyle, lobsterPetName } from "./lobster-pet-identity.ts";
import {
  lobsterLanePoint,
  lobsterTravelDuration,
  type LobsterComposerScene,
  type LobsterSceneTravel,
} from "./lobster-pet-scene.ts";
import { Balloon, BottleSvg, PASSER_SPRITES, PASSER_TITLES } from "./lobster-pet-sprites.tsx";
import {
  THEME_CRITTER_SPRITES,
  THEME_CRITTER_TITLES,
  themeCritterBaseStyle,
} from "./theme-flair-artwork.tsx";

const PASSER_SPRITES_BY_KIND: Partial<Record<string, () => JSX.Element>> = {
  ...PASSER_SPRITES,
  ...THEME_CRITTER_SPRITES,
};
const PASSER_LABELS: Partial<Record<string, string>> = {
  ...PASSER_TITLES,
  ...THEME_CRITTER_TITLES,
};

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

export type LobsterPetSceneProps = {
  look: LobsterPetLook;
  mode: LobsterPetMode;
  presence: "out" | "in" | "leaving";
  shellVisible: boolean;
  visitsEnabled: boolean;
  residentEnabled: boolean;
  critterArtwork?: ThemeArtwork["critters"];
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
};

function PluginArtwork(props: { url: string }) {
  const src = createMemo(
    async () => {
      const url = props.url;
      try {
        const { fetchPluginThemeArtworkBlobUrl } = await import("../pages/plugins/icon-loader.ts");
        return await fetchPluginThemeArtworkBlobUrl({ url });
      } catch {
        return null;
      }
    },
    { loadingValue: null },
  );
  return <Show when={src()}>{(url) => <img class="lobster-pet__svg" alt="" src={url()} />}</Show>;
}

export function LobsterPetScene(props: { scene: LobsterPetSceneProps | null }) {
  return <Show when={props.scene}>{(scene) => <Scene {...scene()} />}</Show>;
}

function Sprite(props: LobsterPetSceneProps & { twin: boolean }) {
  const visual = createMemo(() => {
    const args = props;
    const twin = props.twin;
    const lane = args.scene[args.anchor] ?? args.scene.top!;
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
    return { dressed, classes, style, travel, travelStyle, bindle, title };
  });
  return (
    <div
      class={`lobster-pet__motion ${visual().travel ? (visual().travel?.hop ? "lobster-pet__motion--hop" : "lobster-pet__motion--walk") : ""}`}
      style={visual().travelStyle}
    >
      <div
        class={visual().classes}
        style={visual().style}
        aria-hidden="true"
        title={visual().title}
        onPointerDown={(event) => props.onPointerDown(event)}
        onPointerUp={(event) => props.onPointerUp(event)}
        onPointerCancel={() => props.onPointerCancel()}
        onPointerLeave={() => props.onPointerCancel()}
        onContextMenu={(event) => props.onContextMenu(event)}
      >
        <div class="lobster-pet__body">
          <LobsterSvg
            look={visual().dressed}
            grumpy={props.grumpy}
            bindle={visual().bindle}
            sailorCap={props.sailorDay}
          />
          <Show when={props.entering && props.entrance === "balloon"}>
            <Balloon />
          </Show>
          <Show when={props.entering && props.entrance === "bubble"}>
            <span class="lobster-pet__entry-bubble" />
          </Show>
          <Show when={props.look.shiny}>
            <span class="lobster-pet__sparkle" style="--i:0;left:12%;bottom:64%">
              ✦
            </span>
            <span class="lobster-pet__sparkle" style="--i:1;left:76%;bottom:82%">
              ✦
            </span>
          </Show>
          <span class="lobster-pet__z" style="--i:0">
            z
          </span>
          <span class="lobster-pet__z" style="--i:1">
            z
          </span>
          <span class="lobster-pet__z" style="--i:2">
            Z
          </span>
          <span class="lobster-pet__bubble" style="--i:0" />
          <span class="lobster-pet__bubble" style="--i:1" />
          <span class="lobster-pet__bubble" style="--i:2" />
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
  );
}

function Scene(args: LobsterPetSceneProps) {
  const view = createMemo(() => {
    const showSprites = args.residentEnabled && args.presence !== "out";
    // The shell may outlive the visit while it fades, but dismissal and the
    // visits setting silence it like everything else.
    const showShell =
      args.residentEnabled &&
      args.shellVisible &&
      args.visitsEnabled &&
      !args.dismissed &&
      (args.shellAnchor === "top" || (args.floorEnabled && args.scene.floor !== null));
    const passerArtwork =
      args.passer && !isThemeCritterId(args.passer.kind)
        ? args.critterArtwork?.[args.passer.kind]
        : undefined;
    const stranger = args.passer?.kind === "stranger" && !passerArtwork;
    const showPasser =
      args.passer !== null &&
      args.visitsEnabled &&
      (args.residentEnabled || !stranger) &&
      !args.dismissed &&
      (args.passer.anchor === "top" || (args.floorEnabled && args.scene.floor !== null));
    // The bottle washes ashore whether or not the pet is around; it belongs to
    // the ledge, not the visit. Like every sprite here it is intentionally
    // aria-hidden and pointer-only, with fortunes on the native-tooltip channel
    // (no i18n surface); it must not join the tab order, where a surprise
    // easter-egg button would degrade keyboard flow.
    const showBottle = args.bottle !== null && args.visitsEnabled && !args.dismissed;
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
    const passerLook = stranger ? strangerLookFor(args.seed, args.look.palette.id) : args.look;
    const passerClasses = args.passer
      ? [
          "lobster-pet",
          "lobster-pet--passer",
          stranger
            ? `lobster-pet--palette-${passerLook.palette.id}`
            : `lobster-pet--${args.passer.kind}`,
          stranger && passerLook.shiny ? "lobster-pet--shiny" : "",
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
      ? `${passerBaseStyle(args.passer.kind, args.passer.direction, passerLook, Boolean(passerArtwork))};--lob-cross:${args.passer.crossMs}ms;--lob-cross-from:${fromX}px;--lob-cross-to:${toX}px;--lob-y:${passerLane?.y ?? 0}px`
      : "";
    const passerSprite =
      args.passer && Object.hasOwn(PASSER_SPRITES_BY_KIND, args.passer.kind)
        ? PASSER_SPRITES_BY_KIND[args.passer.kind]
        : undefined;
    const passerTitle =
      args.passer && Object.hasOwn(PASSER_LABELS, args.passer.kind)
        ? PASSER_LABELS[args.passer.kind]
        : undefined;
    const bottlePoint = lobsterLanePoint(args.scene.top, args.bottle?.spotPct ?? 50);
    return {
      showSprites,
      showShell,
      showPasser,
      showBottle,
      shellStyle,
      shellPoint,
      passerLook,
      passerArtwork,
      stranger,
      passerClasses,
      passerStyle,
      passerSprite,
      passerTitle,
      bottlePoint,
    };
  });
  // dynamic owns tracking of the selected factory and retains a crossing's nodes.
  const Passer = dynamic(() => view().passerSprite);
  return (
    <Show when={args.scene.top}>
      <Show when={view().showShell}>
        <div
          class="lobster-pet lobster-pet--shell"
          style={`${view().shellStyle};--lob-x:${view().shellPoint.x}px;--lob-y:${view().shellPoint.y}px`}
          aria-hidden="true"
        >
          <div class="lobster-pet__body">
            <LobsterSvg look={args.look} shell />
          </div>
        </div>
      </Show>
      <Show when={view().showBottle && args.bottle}>
        {(bottle) => (
          <div
            class={`lobster-bottle ${bottle().opened ? "lobster-bottle--open" : ""}`}
            style={`--lob-x:${view().bottlePoint.x}px`}
            title={bottle().opened ? bottle().fortune : "a message in a bottle"}
            aria-hidden="true"
            onPointerDown={() => args.onBottleOpen()}
          >
            <BottleSvg opened={bottle().opened} />
          </div>
        )}
      </Show>
      <Show when={view().showSprites}>
        <Sprite {...args} twin={false} />
      </Show>
      <Show when={view().showSprites && args.twinPlanned}>
        <Sprite {...args} twin />
      </Show>
      <Show when={view().showPasser}>
        <div
          class={view().passerClasses}
          style={view().passerStyle}
          aria-hidden="true"
          title={view().passerArtwork?.title ?? view().passerTitle ?? args.passer?.kind}
        >
          <div class="lobster-pet__body">
            <Show
              when={view().passerArtwork}
              fallback={
                <Show when={view().stranger} fallback={<Passer />}>
                  <LobsterSvg look={view().passerLook} standalone />
                </Show>
              }
            >
              {(artwork) => <PluginArtwork url={artwork().url} />}
            </Show>
          </div>
        </div>
      </Show>
    </Show>
  );
}

// Non-lobster passers ignore the perch variables and carry fixed sprite
// proportions; strangers reuse the full look pipeline (capped size so a
// visiting grail does not upstage the resident).
function passerBaseStyle(
  kind: LobsterPasserKind,
  direction: 1 | -1,
  passerLook: LobsterPetLook,
  pluginArtwork: boolean,
): string {
  if (pluginArtwork) {
    return `--lob-scale:1.8;--lob-w:1;--lob-h:1;--lob-face:${direction}`;
  }
  if (kind === "stranger") {
    return lobsterPetSpriteStyle(passerLook, Math.min(passerLook.scale, 2), 0, direction);
  }
  if (isThemeCritterId(kind)) {
    return themeCritterBaseStyle(kind, direction);
  }
  const fixed: Partial<Record<string, string>> = {
    crab: "--lob-scale:2;--lob-w:1;--lob-h:0.82;--lob-face:1",
    snail: `--lob-scale:1.7;--lob-w:1;--lob-h:0.9;--lob-face:${direction}`,
    duck: `--lob-scale:1.9;--lob-w:1;--lob-h:1;--lob-face:${direction}`,
    jellyfish: "--lob-scale:1.7;--lob-w:0.9;--lob-h:1.1;--lob-face:1",
  };
  return (
    (Object.hasOwn(fixed, kind) ? fixed[kind] : undefined) ??
    `--lob-scale:1.8;--lob-w:1;--lob-h:1;--lob-face:${direction}`
  );
}
