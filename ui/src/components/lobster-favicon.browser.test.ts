import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getLobsterdex, recordLobsterVisit, subscribeLobsterdex } from "./lobster-dex.ts";
import { loadUnlockedLobsterFavicon } from "./lobster-favicon.ts";
import { loadLobsterImage } from "./lobster-image.ts";

const dexKey = "openclaw.control.lobsterdex.v1";
const cleanups: Array<() => void> = [];
let bodyBefore: Element[];
let themeBefore: string;

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
  bodyBefore = [...document.body.children];
  themeBefore = document.documentElement.style.cssText;
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.documentElement.style.cssText = themeBefore;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect([...document.body.children]).toEqual(bodyBefore);
});

type PixelSample = [number, number, number] | [number, number, number, number, number, number];
async function artwork(id: string, ...samples: PixelSample[]) {
  recordLobsterVisit(id);
  const image = expectDefined(await loadUnlockedLobsterFavicon(id), id + " artwork");
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = expectDefined(canvas.getContext("2d"), "artwork pixels");
  context.drawImage(image, 0, 0);
  // Source coordinates exclude the artwork's four-unit safety margin.
  const pixel = (x: number, y: number) => [...context.getImageData(x + 4, y + 4, 1, 1).data];
  for (const [x, y, ...rgba] of samples) {
    const actual = pixel(x, y);
    expect(rgba.length === 1 ? [actual[3]] : actual).toEqual(rgba);
  }
  return { image, pixel, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

it("exports identity presets independently of favicon unlocks", async () => {
  expect(getLobsterdex().has("crimson")).toBe(false);
  const image = expectDefined(await loadLobsterImage("crimson"), "identity artwork");
  expect(image.naturalWidth).toBeGreaterThan(0);
  expect(await loadUnlockedLobsterFavicon("crimson")).toBeNull();
  expect(getLobsterdex().has("crimson")).toBe(false);
});

it("rejects locked or unknown picks and rereads unlocks after decoding", async () => {
  expect(await loadUnlockedLobsterFavicon("crimson")).toBeNull();
  recordLobsterVisit("not-a-palette");
  expect(await loadUnlockedLobsterFavicon("not-a-palette")).toBeNull();
  recordLobsterVisit("crimson");
  const pending = loadUnlockedLobsterFavicon("crimson");
  localStorage.clear();
  expect(await pending).toBeNull();
});

it("bakes palette variables, CSS overrides and checker pattern into readable pixels", async () => {
  await artwork("crimson", [60, 60, 255, 79, 64, 255]);
  await artwork("split", [80, 60, 70, 83, 107, 255]);
  await artwork("chimera", [10, 50, 74, 125, 252, 255], [110, 50, 244, 184, 64, 255]);
  await artwork("notexture", [52, 56, 17, 17, 17, 255], [60, 56, 255, 0, 220, 255]);
});

it("preserves replacement geometry and overflowing balloon string instead of recoloring a dome", async () => {
  await artwork("pixel", [20, 70, 0], [25, 70, 216, 76, 62, 255]);
  await artwork("flatpack", [60, 78, 0], [60, 90, 255]);
  const balloon = await artwork("balloon", [85, 70, 0]);
  await artwork("retro", [108, 25, 255]);
  expect(balloon.image.naturalHeight).toBeGreaterThan(113);
  const stringPixels = [58, 59, 60, 61, 62, 63, 64, 65].map((x) => balloon.pixel(x, 107)[3]);
  expect(stringPixels.some((alpha) => alpha !== undefined && alpha > 0)).toBe(true);
});

it("keeps CSS currentColor, translucency, and text without a live SVG tree", async () => {
  const portal = await artwork("portal");
  const ghost = await artwork("ghost");
  const ascii = await artwork("ascii");
  // The blue portal edge is authored with currentColor, not the shell fill.
  const ring = portal.pixel(16, 47);
  expect(ring[2]).toBeGreaterThan(expectDefined(ring[0], "red") + 60);
  expect(ghost.pixel(60, 60)[3]).toBeGreaterThan(150);
  expect(ghost.pixel(60, 60)[3]).toBeLessThan(165);
  const textPixels = ascii.pixels.filter((value, index) => index % 4 === 3 && value > 0);
  expect(textPixels.length).toBeGreaterThan(300);
  expect(textPixels.length).toBeLessThan(3000);
  expect([...document.body.children]).toEqual(bodyBefore);
  // Decoding the self-contained result again must not need the removed host.
  const copy = new Image();
  copy.src = portal.image.src;
  await copy.decode();
  expect(copy.naturalWidth).toBe(portal.image.naturalWidth);
});

it("bakes current theme colors instead of retaining external CSS variables", async () => {
  const root = document.documentElement;
  root.style.setProperty("--accent", "rgb(12, 34, 56)");
  const first = await artwork("mood", [60, 60, 12, 34, 56, 255]);
  root.style.setProperty("--accent", "rgb(98, 76, 54)");
  await artwork("mood", [60, 60, 98, 76, 54, 255]);
  expect(first.pixel(60, 60)).toEqual([12, 34, 56, 255]);
});

it("is static and independent of the next render's palette", async () => {
  const first = await artwork("crimson");
  await artwork("blue");
  const second = await artwork("crimson");
  expect(second.pixels).toEqual(first.pixels);
  expect(second.image.src).toBe(first.image.src);
});

it("removes its temporary DOM after serialization and decode failures", async () => {
  recordLobsterVisit("crimson");
  vi.spyOn(XMLSerializer.prototype, "serializeToString").mockImplementationOnce(() => {
    throw new Error("serialization failed");
  });
  expect(await loadUnlockedLobsterFavicon("crimson")).toBeNull();
  expect([...document.body.children]).toEqual(bodyBefore);
  vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValueOnce(new Error("decode failed"));
  expect(await loadUnlockedLobsterFavicon("crimson")).toBeNull();
});
it("notifies after local persistence and stops notifying after unsubscribe", () => {
  const observed: string[][] = [];
  const unsubscribe = subscribeLobsterdex(() => observed.push([...getLobsterdex()]));
  cleanups.push(unsubscribe);
  recordLobsterVisit("crimson", { name: "Pinchy" });
  recordLobsterVisit("crimson", { name: "Other" });
  expect(observed).toEqual([["crimson"]]);
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new DOMException("Full", "QuotaExceededError");
  });
  recordLobsterVisit("gold");
  expect(observed).toEqual([["crimson"]]);
  unsubscribe();
  recordLobsterVisit("blue");
  expect(observed).toEqual([["crimson"]]);
});

it("observes native other-document storage writes and clearing", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  cleanups.push(() => frame.remove());
  const otherStorage = expectDefined(frame.contentWindow, "same-origin frame").localStorage;
  let changed = Promise.withResolvers<void>();
  cleanups.push(subscribeLobsterdex(() => changed.resolve()));
  otherStorage.setItem(dexKey, JSON.stringify(["blue"]));
  await changed.promise;
  expect(getLobsterdex().has("blue")).toBe(true);
  changed = Promise.withResolvers<void>();
  otherStorage.clear();
  await changed.promise;
  expect(getLobsterdex().size).toBe(0);
});
