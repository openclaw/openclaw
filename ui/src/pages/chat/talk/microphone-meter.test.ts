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
function mount(
  status: "listening" | "connecting" | "thinking" = "listening",
  level = 0,
  unavailableContext?: 0 | 1,
) {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const clock = createFrameClock();
  vi.stubGlobal("requestAnimationFrame", clock.request);
  vi.stubGlobal("cancelAnimationFrame", clock.cancel);
  const drawImage = vi.fn();
  const opacities: number[] = [];
  const context = {
    fillStyle: "",
    shadowColor: "",
    shadowBlur: 0,
    globalAlpha: 1,
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage,
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
  };
  drawImage.mockImplementation(() => {
    opacities.push(context.globalAlpha);
  });
  let contextCalls = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    if (contextCalls++ === unavailableContext) {
      return null;
    }
    // SAFETY: The fixture implements every 2D operation exercised by the renderer.
    return context as unknown as CanvasRenderingContext2D;
  });
  const host = document.createElement("openclaw-microphone-activity");
  const bars = Array.from({ length: 7 }, (_, index) => {
    const bar = document.createElement("span");
    bar.style.backgroundColor = "rgb(200, 40, 30)";
    bar.style.boxShadow = "rgba(200, 40, 30, 0.3) 0px 0px 5px 0px";
    for (const [key, value] of Object.entries({
      offsetWidth: 3,
      offsetHeight: 18,
      offsetLeft: index * 6,
      offsetTop: 1,
    })) {
      Object.defineProperty(bar, key, { value });
    }
    host.append(bar);
    return bar;
  });
  const canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
  let motionReduced = false;
  let notifyMotion = (_value: boolean) => {};
  const meter = createMicrophoneMeter(host, canvas, bars, status, {
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
    drawImage,
    opacities,
    visibility,
    meter,
    host,
    bars,
    context,
    canvas,
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

it.each([0, 1] as const)(
  "leaves fallback spans untouched when canvas context %i is unavailable",
  (unavailableContext) => {
    const view = mount("thinking", 0.8, unavailableContext);
    try {
      view.meter.setLevel(0.2);
      view.advance(100);
      expect(view.canvas.hasAttribute("data-ready")).toBe(false);
      expect(Array.from(view.host.children)).toEqual([...view.bars, view.canvas]);
      expect(view.drawImage).not.toHaveBeenCalled();
      expect(view.clock.frames.size).toBe(0);
      view.meter.dispose();
      view.meter.setLevel(0.9);
      expect(view.clock.frames.size).toBe(0);
    } finally {
      view.meter.dispose();
    }
  },
);

it("starts at the current level and stops after the 90 ms listening transition", () => {
  const view = mount("listening", 0.2);
  try {
    expect(view.canvas.hasAttribute("data-ready")).toBe(false);
    view.advance(0);
    expect(view.canvas.hasAttribute("data-ready")).toBe(true);
    expect(view.drawImage).toHaveBeenCalledTimes(7);
    expect(view.clock.frames.size).toBe(0);
    view.meter.setLevel(0.8);
    view.advance(45);
    expect(view.drawImage.mock.calls.at(-4)?.[8]).toBeCloseTo((18 + 16) * (0.18 + 0.5 * 0.82));
    view.advance(90);
    expect(view.drawImage.mock.calls.at(-4)?.[8]).toBeCloseTo((18 + 16) * (0.18 + 0.8 * 0.82));
    expect(view.clock.frames.size).toBe(0);
    view.meter.setLevel(0.8);
    expect(view.clock.frames.size).toBe(0);

    view.meter.setLevel(0.2);
    view.advance(135);
    expect(view.drawImage.mock.calls.at(-4)?.[8]).toBeCloseTo(34 * (0.18 + 0.5 * 0.82));
    view.meter.setLevel(0.9);
    view.advance(180);
    expect(view.drawImage.mock.calls.at(-4)?.[8]).toBeCloseTo(34 * (0.18 + 0.7 * 0.82));
    view.advance(225);
    expect(view.drawImage.mock.calls.at(-4)?.[8]).toBeCloseTo(34 * (0.18 + 0.9 * 0.82));
    expect(view.clock.frames.size).toBe(0);
  } finally {
    view.meter.dispose();
  }
});

it("caps active paints at 30Hz and cancels frames while hidden, motion-reduced, or disposed", () => {
  const view = mount("thinking");
  view.advance(0);
  expect(view.drawImage).toHaveBeenCalledTimes(7);
  view.advance(16);
  expect(view.drawImage).toHaveBeenCalledTimes(7);
  view.advance(34);
  expect(view.drawImage).toHaveBeenCalledTimes(14);
  view.advance(50);
  expect(view.drawImage).toHaveBeenCalledTimes(14);
  view.advance(68);
  expect(view.drawImage).toHaveBeenCalledTimes(21);
  view.advance(405);
  expect(view.drawImage.mock.calls.at(-7)?.[8]).toBeCloseTo(34 * 0.92);
  expect(view.opacities.at(-7)).toBeCloseTo(1);
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
    expectDefined(view.bars[0], "first meter bar").style.backgroundColor = "rgb(20, 30, 200)";
    document.documentElement.setAttribute("data-theme", "canvas-meter-test");
    await Promise.resolve();
    expect(view.context.fillStyle).toBe("rgb(20, 30, 200)");
    expect(view.canvas.hasAttribute("data-ready")).toBe(false);
    view.advance(40);
    expect(view.canvas.hasAttribute("data-ready")).toBe(true);
    expect(view.clock.frames.size).toBe(0);

    vi.stubGlobal("devicePixelRatio", 1.25);
    expectDefined(queries[0], "density query").dispatchEvent(new Event("change"));
    expect(matchMedia).toHaveBeenLastCalledWith("(resolution: 1.25dppx)");
    expect(view.context.setTransform).toHaveBeenLastCalledWith(1.25, 0, 0, 1.25, 0, 0);
    expect(view.context.shadowBlur).toBe(6.25);
    view.advance(80);
    expect(view.drawImage.mock.calls.at(-1)?.slice(1, 5)).toEqual([0, 0, 23.75, 42.5]);
    expect(view.clock.frames.size).toBe(0);
    const refreshesBeforeDisposal = view.context.setTransform.mock.calls.length;
    const queriesBeforeDisposal = matchMedia.mock.calls.length;
    view.meter.dispose();
    queries.at(-1)?.dispatchEvent(new Event("change"));
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
