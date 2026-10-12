import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLobsterdex, recordLobsterVisit, subscribeLobsterdex } from "./lobster-dex.ts";
import { loadUnlockedLobsterFavicon } from "./lobster-favicon.ts";

const dexKey = "openclaw.control.lobsterdex.v1";
const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function artwork(id: string) {
  recordLobsterVisit(id);
  const image = expectDefined(await loadUnlockedLobsterFavicon(id), id + " artwork");
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = expectDefined(canvas.getContext("2d"), "artwork pixels");
  context.drawImage(image, 0, 0);
  return {
    image,
    // The source-space samples are inside the artwork's four-unit safety margin.
    pixel: (x: number, y: number) => [...context.getImageData(x + 4, y + 4, 1, 1).data],
    pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

describe("unlocked Lobsterdex favicon artwork", () => {
  it("rejects locked or unknown picks and rereads unlocks after decoding", async () => {
    const children = [...document.body.children];
    expect(await loadUnlockedLobsterFavicon("crimson")).toBeNull();
    recordLobsterVisit("not-a-palette");
    expect(await loadUnlockedLobsterFavicon("not-a-palette")).toBeNull();
    recordLobsterVisit("crimson");
    const pending = loadUnlockedLobsterFavicon("crimson");
    localStorage.clear();
    expect(await pending).toBeNull();
    expect([...document.body.children]).toEqual(children);
  });

  it("bakes palette variables, CSS overrides and checker pattern into readable pixels", async () => {
    const crimson = await artwork("crimson");
    const split = await artwork("split");
    const chimera = await artwork("chimera");
    const checker = await artwork("notexture");
    expect(crimson.pixel(60, 60)).toEqual([255, 79, 64, 255]);
    expect(split.pixel(80, 60)).toEqual([70, 83, 107, 255]);
    expect(chimera.pixel(10, 50)).toEqual([74, 125, 252, 255]);
    expect(chimera.pixel(110, 50)).toEqual([244, 184, 64, 255]);
    expect(checker.pixel(52, 56)).toEqual([17, 17, 17, 255]);
    expect(checker.pixel(60, 56)).toEqual([255, 0, 220, 255]);
  });

  it("preserves replacement geometry and overflowing balloon string instead of recoloring a dome", async () => {
    const pixel = await artwork("pixel");
    const flatpack = await artwork("flatpack");
    const balloon = await artwork("balloon");
    const retro = await artwork("retro");
    expect(pixel.pixel(20, 70)[3]).toBe(0);
    expect(pixel.pixel(25, 70)).toEqual([216, 76, 62, 255]);
    expect(flatpack.pixel(60, 78)[3]).toBe(0);
    expect(flatpack.pixel(60, 90)[3]).toBe(255);
    expect(balloon.pixel(85, 70)[3]).toBe(0);
    expect(balloon.image.naturalHeight).toBeGreaterThan(113);
    const stringPixels = [58, 59, 60, 61, 62, 63, 64, 65].map((x) => balloon.pixel(x, 107)[3]);
    expect(stringPixels.some((alpha) => alpha !== undefined && alpha > 0)).toBe(true);
    expect(retro.pixel(108, 25)[3]).toBe(255);
  });

  it("keeps CSS currentColor, translucency, and text without a live SVG tree", async () => {
    const children = [...document.body.children];
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
    expect([...document.body.children]).toEqual(children);
    // Decoding the self-contained result again must not need the removed host.
    const copy = new Image();
    copy.src = portal.image.src;
    await copy.decode();
    expect(copy.naturalWidth).toBe(portal.image.naturalWidth);
  });

  it("bakes current theme colors instead of retaining external CSS variables", async () => {
    const root = document.documentElement;
    const previous = root.style.cssText;
    cleanups.push(() => {
      root.style.cssText = previous;
    });
    root.style.setProperty("--accent", "rgb(12, 34, 56)");
    const first = await artwork("mood");
    expect(first.pixel(60, 60)).toEqual([12, 34, 56, 255]);
    root.style.setProperty("--accent", "rgb(98, 76, 54)");
    const second = await artwork("mood");
    expect(second.pixel(60, 60)).toEqual([98, 76, 54, 255]);
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
    const children = [...document.body.children];
    vi.spyOn(XMLSerializer.prototype, "serializeToString").mockImplementationOnce(() => {
      throw new Error("serialization failed");
    });
    expect(await loadUnlockedLobsterFavicon("crimson")).toBeNull();
    expect([...document.body.children]).toEqual(children);
    vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValueOnce(
      new Error("decode failed"),
    );
    expect(await loadUnlockedLobsterFavicon("crimson")).toBeNull();
    expect([...document.body.children]).toEqual(children);
  });
});

describe("Lobsterdex invalidation", () => {
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
    const changed = Promise.withResolvers<void>();
    const cleared = Promise.withResolvers<void>();
    const unsubscribe = subscribeLobsterdex(() => {
      if (getLobsterdex().has("blue")) {
        changed.resolve();
      } else if (getLobsterdex().size === 0) {
        cleared.resolve();
      }
    });
    cleanups.push(unsubscribe);
    otherStorage.setItem(dexKey, JSON.stringify(["blue"]));
    await changed.promise;
    expect(getLobsterdex().has("blue")).toBe(true);
    otherStorage.clear();
    await cleared.promise;
    expect(getLobsterdex().size).toBe(0);
  });
});
