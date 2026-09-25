import type { ReactiveController, ReactiveControllerHost } from "lit";

export type LobsterSceneLane = { start: number; end: number; y: number };
export type LobsterSceneTravel = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  hop: boolean;
};

export function lobsterTravelDuration(travel: LobsterSceneTravel): number {
  return travel.hop
    ? 1100
    : Math.max(850, Math.min(2600, Math.abs(travel.to.x - travel.from.x) * 8));
}
export type LobsterSceneMove = {
  anchor: "top" | "floor";
  spotPct: number;
  facing: 1 | -1;
  travel: LobsterSceneTravel;
};

export type LobsterComposerScene = {
  top: LobsterSceneLane | null;
  floor: LobsterSceneLane | null;
  // A clear column through the empty editor, to the right of its placeholder.
  passage: readonly [number, number] | null;
};
type Box = Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom" | "width" | "height">;
const CLEARANCE = 38; // Elder/mighty claws, body sway, and a small safety margin.
const HEADROOM = 88; // Includes top-lane hops and balloon entrances.

function widestGap(start: number, end: number, obstacles: readonly Box[], padding: number) {
  let cursor = start;
  let best: [number, number] | null = null;
  for (const box of obstacles.toSorted((a, b) => a.left - b.left)) {
    const stop = Math.min(end, box.left - padding);
    if (stop > cursor && (!best || stop - cursor > best[1] - best[0])) {
      best = [cursor, stop];
    }
    cursor = Math.max(cursor, box.right + padding);
  }
  if (end > cursor && (!best || end - cursor > best[1] - best[0])) {
    best = [cursor, end];
  }
  return best;
}

// Coordinates are relative to the input's padding edge. A narrow/mobile footer
// gets no floor rather than a guessed strip across its controls.
function resolveLobsterComposerScene(args: {
  composer: Box;
  footer: Box | null;
  controls: readonly Box[];
  topObstacles: readonly Box[];
  editor: Box | null;
  placeholderRight: number;
  twins: boolean;
}): LobsterComposerScene {
  const { composer, footer, editor } = args;
  const empty: LobsterComposerScene = { top: null, floor: null, passage: null };
  if (composer.width <= 0 || composer.height <= 0) {
    return empty;
  }
  const clearance = CLEARANCE + (args.twins ? 28 : 0);
  const topGap = widestGap(
    composer.left + clearance,
    composer.right - clearance,
    args.topObstacles.filter(
      (box) => box.height > 0 && box.bottom > composer.top - HEADROOM && box.top < composer.top,
    ),
    clearance,
  );
  const top = topGap
    ? { start: topGap[0] - composer.left, end: topGap[1] - composer.left, y: 0 }
    : null;
  if (!footer || footer.height <= 0) {
    return { ...empty, top };
  }
  const floorY = Math.min(composer.bottom - 8, footer.bottom - 5);
  // Protect actual input text, including multiline placeholder/editor layouts.
  if (floorY - 48 < (editor?.bottom ?? composer.top)) {
    return { ...empty, top };
  }
  const floorGap = widestGap(
    Math.max(composer.left, footer.left) + clearance,
    Math.min(composer.right, footer.right) - clearance,
    args.controls.filter(
      (box) => box.width > 0 && box.height > 0 && box.top < floorY && box.bottom > floorY - 48,
    ),
    clearance,
  );
  const floor =
    floorGap && floorGap[1] - floorGap[0] >= 24
      ? {
          start: floorGap[0] - composer.left,
          end: floorGap[1] - composer.left,
          y: floorY - composer.top,
        }
      : null;
  const passageStart = Math.max(
    top?.start ?? Infinity,
    floor?.start ?? Infinity,
    args.placeholderRight - composer.left + clearance,
  );
  const passageEnd = Math.min(top?.end ?? -Infinity, floor?.end ?? -Infinity);
  return {
    top,
    floor,
    passage: passageEnd - passageStart >= 28 ? [passageStart, passageEnd] : null,
  };
}

export function lobsterLanePoint(lane: LobsterSceneLane | null, pct: number) {
  return { x: lane ? lane.start + ((lane.end - lane.start) * pct) / 100 : 0, y: lane?.y ?? 0 };
}

// Geometry has one lifecycle owner. Observers never watch pet mutations, and
// queued measurements cannot revive a detached host or reroll a visit.
export class LobsterComposerGeometry implements ReactiveController {
  scene: LobsterComposerScene = { top: null, floor: null, passage: null };
  private resize: ResizeObserver | null = null;
  private mutation: MutationObserver | null = null;
  private active = false;
  private queued = false;
  private observed: Element[] = [];

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly twins: () => boolean,
  ) {
    host.addController(this);
  }

  planWalk(anchor: "top" | "floor", spotPct: number, roll: number): LobsterSceneMove | null {
    const lane = this.scene[anchor];
    if (!lane) {
      return null;
    }
    let target = Math.round(roll * 100);
    // A same-spot walk reads as a glitch; use the farther edge instead.
    if (Math.abs(target - spotPct) < 4) {
      target = spotPct > 50 ? 0 : 100;
    }
    return {
      anchor,
      spotPct: target,
      facing: target < spotPct ? -1 : 1,
      travel: {
        from: lobsterLanePoint(lane, spotPct),
        to: lobsterLanePoint(lane, target),
        hop: false,
      },
    };
  }

  planHop(anchor: "top" | "floor", spotPct: number): LobsterSceneMove | null {
    const { passage, floor } = this.scene;
    const lane = this.scene[anchor];
    if (!passage || !floor || !lane) {
      return null;
    }
    const from = lobsterLanePoint(lane, spotPct);
    const middle = (passage[0] + passage[1]) / 2;
    // Walk to the clear column before hopping, rather than cutting through text.
    if (from.x < passage[0] || from.x > passage[1]) {
      return {
        anchor,
        spotPct: ((middle - lane.start) / (lane.end - lane.start)) * 100,
        facing: middle < from.x ? -1 : 1,
        travel: { from, to: { x: middle, y: lane.y }, hop: false },
      };
    }
    const next = anchor === "top" ? "floor" : "top";
    const destination = this.scene[next];
    if (!destination) {
      return null;
    }
    const x = from.x < middle ? passage[1] : passage[0];
    return {
      anchor: next,
      spotPct: ((x - destination.start) / (destination.end - destination.start)) * 100,
      facing: x < from.x ? -1 : 1,
      travel: { from, to: { x, y: destination.y }, hop: true },
    };
  }

  hostConnected() {
    this.active = true;
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(this.scheduleMeasure);
    } else {
      window.addEventListener("resize", this.scheduleMeasure);
    }
    const composer = this.host.parentElement;
    const root = composer?.closest(".new-session-page__draft") ?? composer;
    if (root) {
      this.mutation = new MutationObserver((records) => {
        if (
          records.some(
            (record) => record.target !== this.host && !this.host.contains(record.target),
          )
        ) {
          this.scheduleMeasure();
        }
      });
      this.mutation.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-label"],
      });
    }
    this.scheduleMeasure();
  }

  hostDisconnected() {
    this.active = false;
    this.resize?.disconnect();
    this.resize = null;
    this.mutation?.disconnect();
    this.mutation = null;
    this.observed = [];
    window.removeEventListener("resize", this.scheduleMeasure);
  }

  readonly scheduleMeasure = () => {
    if (!this.active || this.queued) {
      return;
    }
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.active && this.host.isConnected) {
        this.measure();
      }
    });
  };

  private measure() {
    const composer = this.host.parentElement;
    if (!composer?.matches(".agent-chat__input")) {
      return;
    }
    const footer = composer.querySelector(".agent-chat__composer-footer");
    const editor = composer.querySelector("textarea");
    const controls = Array.from(
      footer?.querySelectorAll(
        ".agent-chat__composer-lead, .chat-composer-model-control, .agent-chat__composer-actions, button, wa-button, [role=button]",
      ) ?? [],
    );
    const root = composer.closest(".new-session-page__draft");
    const obstacles = Array.from(
      root?.querySelectorAll(
        ".new-session-page__triggers > *, .new-session-page__incognito-notice--visible",
      ) ?? [],
    );
    const observed = [
      composer,
      ...controls,
      ...obstacles,
      ...(footer ? [footer] : []),
      ...(editor ? [editor] : []),
    ];
    if (
      observed.length !== this.observed.length ||
      observed.some((node, index) => node !== this.observed[index])
    ) {
      this.resize?.disconnect();
      for (const node of observed) {
        this.resize?.observe(node);
      }
      this.observed = observed;
    }
    const editorBox = editor?.getBoundingClientRect() ?? null;
    let placeholderRight = editorBox?.left ?? 0;
    if (editor && editorBox) {
      const style = getComputedStyle(editor);
      // The aria-label holds the complete placeholder while its visible text
      // types in. Measure that full string so a route cannot overtake it.
      const label = editor.getAttribute("aria-label") ?? editor.placeholder;
      const fontSize = Number.parseFloat(style.fontSize) || 16;
      let textWidth = label.length * fontSize * 0.65;
      if (typeof CanvasRenderingContext2D !== "undefined") {
        const context = document.createElement("canvas").getContext("2d");
        if (context) {
          context.font = style.font;
          textWidth = context.measureText(label).width;
        }
      }
      placeholderRight += Math.min(
        editorBox.width,
        textWidth + (Number.parseFloat(style.paddingLeft) || 0),
      );
    }
    const next = resolveLobsterComposerScene({
      composer: composer.getBoundingClientRect(),
      footer: footer?.getBoundingClientRect() ?? null,
      controls: controls.map((node) => node.getBoundingClientRect()),
      topObstacles: obstacles.map((node) => node.getBoundingClientRect()),
      editor: editorBox,
      placeholderRight,
      twins: this.twins(),
    });
    this.host.toggleAttribute("data-scene-ready", next.top !== null);
    if (JSON.stringify(next) !== JSON.stringify(this.scene)) {
      this.scene = next;
      this.host.requestUpdate();
    }
  }
}
