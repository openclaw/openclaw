/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSER_LOBSTER_ACT_DURATION_MS,
  composerLobsterSeed,
  createComposerLobsterLook,
  type ComposerLobster,
} from "./components/chat-composer-lobster.ts";

const SPOT_ZONES = { left: [10, 34], right: [64, 86] } as const;

type LobsterElement = ComposerLobster & HTMLElement;

function createLobster(seed: number, active: boolean): LobsterElement {
  const element = document.createElement("openclaw-composer-lobster") as LobsterElement;
  element.seed = seed;
  element.active = active;
  document.body.append(element);
  return element;
}

function spriteClasses(element: LobsterElement): string {
  return element.querySelector(".composer-lobster")?.className ?? "";
}

async function advanceUntilAct(element: LobsterElement, maxMs: number): Promise<string | null> {
  let elapsed = 0;
  while (elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(200);
    elapsed += 200;
    await element.updateComplete;
    const match = /composer-lobster--act-([a-z]+)/.exec(spriteClasses(element));
    if (match) {
      return match[1];
    }
  }
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("composer lobster look", () => {
  it("is deterministic per seed", () => {
    expect(createComposerLobsterLook(1234)).toEqual(createComposerLobsterLook(1234));
  });

  it("stays within the variant catalog for many seeds", () => {
    const palettes = new Set<string>();
    const personalities = new Set<string>();
    for (let seed = 0; seed < 300; seed++) {
      const look = createComposerLobsterLook(seed);
      palettes.add(look.palette.id);
      personalities.add(look.personality);
      expect(["crimson", "coral", "teal", "violet", "ink", "gold"]).toContain(look.palette.id);
      expect([1.7, 2, 2.5]).toContain(look.scale);
      expect(["none", "crown", "sprout", "patch"]).toContain(look.accessory);
      expect(["perky", "droopy"]).toContain(look.antennae);
      const zone = SPOT_ZONES[look.side];
      expect(look.spotPct).toBeGreaterThanOrEqual(zone[0]);
      expect(look.spotPct).toBeLessThanOrEqual(zone[1]);
    }
    // Sessions should feel different: many seeds must not collapse onto one look.
    expect(palettes.size).toBeGreaterThan(2);
    expect(personalities.size).toBeGreaterThan(2);
  });

  it("derives distinct salted seeds per session key, stable within a load", () => {
    expect(composerLobsterSeed("agent:a:main")).toBe(composerLobsterSeed("agent:a:main"));
    expect(composerLobsterSeed("agent:a:main")).not.toBe(composerLobsterSeed("agent:b:other"));
  });
});

describe("composer lobster element", () => {
  it("renders the sprite and schedules acts while active", async () => {
    vi.useFakeTimers();
    const element = createLobster(42, true);
    await element.updateComplete;

    expect(element.querySelector(".composer-lobster__svg")).not.toBeNull();
    expect(spriteClasses(element)).not.toContain("composer-lobster--away");

    const act = await advanceUntilAct(element, 20_000);
    expect(act).not.toBeNull();
    expect(Object.keys(COMPOSER_LOBSTER_ACT_DURATION_MS)).toContain(act);

    // The act window closes and the lobster returns to idle.
    await vi.advanceTimersByTimeAsync(
      COMPOSER_LOBSTER_ACT_DURATION_MS[act as keyof typeof COMPOSER_LOBSTER_ACT_DURATION_MS],
    );
    await element.updateComplete;
    expect(spriteClasses(element)).not.toContain("composer-lobster--act-");
  });

  it("ducks away and stops acting when inactive", async () => {
    vi.useFakeTimers();
    const element = createLobster(42, true);
    await element.updateComplete;

    element.active = false;
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("composer-lobster--away");

    const act = await advanceUntilAct(element, 30_000);
    expect(act).toBeNull();
  });

  it("startles when poked", async () => {
    vi.useFakeTimers();
    const element = createLobster(7, true);
    await element.updateComplete;

    element.querySelector(".composer-lobster")?.dispatchEvent(new Event("pointerdown"));
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("composer-lobster--act-startle");
  });

  it("stops timers on disconnect", async () => {
    vi.useFakeTimers();
    const element = createLobster(42, true);
    await element.updateComplete;

    element.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays static when reduced motion is preferred, including visibility resumes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    const element = createLobster(42, true);
    await element.updateComplete;

    expect(element.querySelector(".composer-lobster__svg")).not.toBeNull();
    // Tab switches re-enter through the visibilitychange resume path, which
    // must stay inert under reduced motion too.
    document.dispatchEvent(new Event("visibilitychange"));
    const act = await advanceUntilAct(element, 30_000);
    expect(act).toBeNull();
  });
});
