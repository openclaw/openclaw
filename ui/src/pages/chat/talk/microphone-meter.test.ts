/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createFrameClock } from "../../../test-helpers/animation-frame-clock.ts";
import { createMicrophoneMeter } from "./microphone-meter.ts";

const observation = vi.hoisted(() => ({
  intersect: undefined as IntersectionObserverCallback | undefined,
  resize: undefined as (() => void) | undefined,
}));
vi.mock("../../../lib/reactive/observers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/reactive/observers.ts")>()),
  observeResize: (_elements: readonly Element[], callback: () => void) => {
    observation.resize = callback;
    return () => {
      observation.resize = undefined;
    };
  },
  observeIntersection: (_elements: readonly Element[], callback: IntersectionObserverCallback) => {
    observation.intersect = callback;
    return () => {
      observation.intersect = undefined;
    };
  },
}));
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
// A 58x20 host fits fifteen 2px bars on a 4px pitch.
const BARS = 15;
function mount(status: "listening" | "thinking" = "listening", level = 0, noContext = false) {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const clock = createFrameClock();
  vi.stubGlobal("requestAnimationFrame", clock.request);
  vi.stubGlobal("cancelAnimationFrame", clock.cancel);
  // Bars painted by the latest frame, keyed by their left edge.
  let painted = new Map<number, number>();
  const roundRect = vi.fn((x: number, _y: number, _width: number, height: number) => {
    painted.set(x, height);
  });
  const context = {
    fillStyle: "",
    setTransform: vi.fn(),
    clearRect: vi.fn(() => {
      painted = new Map();
    }),
    beginPath: vi.fn(),
    roundRect,
    fill: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
    // SAFETY: The fixture implements every 2D operation exercised by the renderer.
    noContext ? null : (context as unknown as CanvasRenderingContext2D),
  );
  const host = document.createElement("openclaw-microphone-activity");
  let hostWidth = 58;
  Object.defineProperties(host, {
    offsetWidth: { get: () => hostWidth },
    offsetHeight: { value: 20 },
  });
  host.style.color = "rgb(200, 40, 30)";
  const canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
  let motionReduced = false;
  let notifyMotion = (_value: boolean) => {};
  const meter = createMicrophoneMeter(host, canvas, status, {
    read: () => motionReduced,
    subscribe: (notify) => {
      notifyMotion = notify;
      return () => {
        notifyMotion = () => {};
      };
    },
  });
  meter.setLevel(level);
  observation.resize?.();
  return {
    clock,
    roundRect,
    visibility,
    meter,
    host,
    context,
    canvas,
    painted: () => painted,
    resize(width: number) {
      hostWidth = width;
      observation.resize?.();
    },
    advance(time: number) {
      now = time;
      clock.flush(time);
    },
    intersect(value: boolean) {
      const bounds = host.getBoundingClientRect();
      const entry: IntersectionObserverEntry = {
        target: host,
        isIntersecting: value,
        boundingClientRect: bounds,
        intersectionRatio: value ? 1 : 0,
        intersectionRect: bounds,
        rootBounds: null,
        time: now,
      };
      observation.intersect?.([entry], {} as IntersectionObserver);
    },
    reduce(value: boolean) {
      motionReduced = value;
      notifyMotion(value);
    },
  };
}
// Dots are as tall as the bars are wide; speech fills the 20px host minus 2px.
const barHeight = (level: number) => 2 + 16 * level ** 1.8;

it("leaves the CSS dots untouched when the canvas context is unavailable", () => {
  const view = mount("thinking", 0.8, true);
  try {
    view.meter.setLevel(0.2);
    view.advance(100);
    expect(view.canvas.hasAttribute("data-ready")).toBe(false);
    expect(Array.from(view.host.children)).toEqual([view.canvas]);
    expect(view.roundRect).not.toHaveBeenCalled();
    expect(view.clock.frames.size).toBe(0);
  } finally {
    view.meter.dispose();
  }
});

it("slides speech in from the right and settles back to still dots", () => {
  const view = mount("listening", 0.6);
  try {
    view.advance(0);
    expect(view.canvas.hasAttribute("data-ready")).toBe(true);
    // A new recording starts as dots; the voice enters from the right edge.
    expect([...view.painted().values()]).toEqual(Array.from({ length: BARS }, () => 2));
    view.advance(60);
    view.advance(120);
    expect(view.painted().get(56)).toBeCloseTo(barHeight(0.6));
    expect(view.painted().get(52)).toBe(2);

    view.meter.setLevel(0);
    for (let time = 150; time <= 3_000 && view.clock.frames.size; time += 34) {
      view.advance(time);
    }
    expect([...view.painted().values()].every((height) => height === 2)).toBe(true);
    expect(view.clock.frames.size).toBe(0);
  } finally {
    view.meter.dispose();
  }
});

it("fills the width it is given and keeps the newest speech when that width changes", () => {
  const view = mount("listening", 0.6);
  try {
    view.advance(0);
    view.advance(60);
    view.advance(120);
    expect(view.painted().get(56)).toBeCloseTo(barHeight(0.6));
    // Twice the width: thirty bars, still flush with the edges, newest speech still rightmost.
    view.resize(118);
    view.advance(180);
    expect([...view.painted().keys()]).toEqual(Array.from({ length: 30 }, (_, index) => index * 4));
    expect(view.painted().get(112)).toBeCloseTo(barHeight(0.6));
    expect(view.painted().get(108)).toBe(2);
  } finally {
    view.meter.dispose();
  }
});

it("slides speech in from the right after a pause instead of filling the strip", () => {
  const view = mount("listening", 0);
  try {
    view.advance(0);
    expect(view.clock.frames.size).toBe(0);
    // Seconds of silence pass with no frames; then the voice comes back.
    view.meter.setLevel(0.6);
    view.advance(5_000);
    expect([...view.painted().values()]).toEqual(Array.from({ length: BARS }, () => 2));
    view.advance(5_060);
    view.advance(5_120);
    expect(view.painted().get(56)).toBeCloseTo(barHeight(0.6));
    expect(view.painted().get(52)).toBe(2);
  } finally {
    view.meter.dispose();
  }
});

it("keeps a short syllable that falls between timeline steps", () => {
  const view = mount("listening", 0);
  try {
    view.advance(0);
    view.meter.setLevel(0.9);
    view.meter.setLevel(0);
    // The first frame restarts the step clock; the syllable then slides in from the right.
    view.advance(60);
    view.advance(120);
    view.advance(180);
    expect(view.painted().get(56)).toBeCloseTo(barHeight(0.9));
  } finally {
    view.meter.dispose();
  }
});

it("caps active paints at 30Hz and cancels frames while hidden, motion-reduced, or disposed", () => {
  const view = mount("thinking");
  view.advance(0);
  expect(view.roundRect).toHaveBeenCalledTimes(BARS);
  view.advance(16);
  expect(view.roundRect).toHaveBeenCalledTimes(BARS);
  view.advance(34);
  expect(view.roundRect).toHaveBeenCalledTimes(BARS * 2);
  view.advance(50);
  expect(view.roundRect).toHaveBeenCalledTimes(BARS * 2);
  view.advance(68);
  expect(view.roundRect).toHaveBeenCalledTimes(BARS * 3);
  view.advance(405);
  const heights = [...view.painted().values()];
  expect(Math.max(...heights)).toBeGreaterThan(2);
  expect(Math.max(...heights)).toBeLessThanOrEqual(18);
  expect(view.clock.frames.size).toBe(1);
  view.intersect(false);
  expect(view.clock.frames.size).toBe(0);
  view.intersect(true);
  expect(view.clock.frames.size).toBe(1);
  view.visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(view.clock.frames.size).toBe(0);
  view.meter.setLevel(0.6);
  expect(view.clock.frames.size).toBe(0);
  view.visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(view.clock.frames.size).toBe(1);
  view.reduce(true);
  expect(view.clock.frames.size).toBe(0);
  view.reduce(false);
  expect(view.clock.frames.size).toBe(1);
  view.meter.dispose();
  expect(view.clock.frames.size).toBe(0);
  expect(view.canvas.hasAttribute("data-ready")).toBe(false);
  document.dispatchEvent(new Event("visibilitychange"));
  view.reduce(true);
  expect(view.clock.frames.size).toBe(0);
});

it("refreshes a settled meter for palette and display-density changes without a resize", async () => {
  const queries: EventTarget[] = [];
  const matchMedia = vi.fn(() => {
    const query = new EventTarget();
    queries.push(query);
    return query;
  });
  vi.stubGlobal("matchMedia", matchMedia);
  vi.stubGlobal("devicePixelRatio", 1);
  const previousTheme = document.documentElement.getAttribute("data-theme");
  const view = mount();
  try {
    view.advance(0);
    expect(view.clock.frames.size).toBe(0);
    view.host.style.color = "rgb(20, 30, 200)";
    document.documentElement.setAttribute("data-theme", "canvas-meter-test");
    await Promise.resolve();
    expect(view.canvas.hasAttribute("data-ready")).toBe(false);
    view.advance(40);
    expect(view.context.fillStyle).toBe("rgb(20, 30, 200)");
    expect(view.canvas.hasAttribute("data-ready")).toBe(true);
    expect(view.clock.frames.size).toBe(0);

    vi.stubGlobal("devicePixelRatio", 1.25);
    expectDefined(queries[0], "density query").dispatchEvent(new Event("change"));
    expect(matchMedia).toHaveBeenLastCalledWith("(resolution: 1.25dppx)");
    expect(view.canvas.width).toBe(73);
    view.advance(80);
    expect(view.context.setTransform).toHaveBeenLastCalledWith(1.25, 0, 0, 1.25, 0, 0);
    expect(view.roundRect.mock.calls.at(-1)).toEqual([56, 9, 2, 2, 1]);
    expect(view.clock.frames.size).toBe(0);
    const refreshesBeforeDisposal = view.context.setTransform.mock.calls.length;
    const queriesBeforeDisposal = matchMedia.mock.calls.length;
    view.meter.dispose();
    queries.at(-1)?.dispatchEvent(new Event("change"));
    view.advance(120);
    expect(view.context.setTransform).toHaveBeenCalledTimes(refreshesBeforeDisposal);
    expect(matchMedia).toHaveBeenCalledTimes(queriesBeforeDisposal);
    expect(view.clock.frames.size).toBe(0);
  } finally {
    view.meter.dispose();
    if (previousTheme === null) {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", previousTheme);
    }
  }
});
