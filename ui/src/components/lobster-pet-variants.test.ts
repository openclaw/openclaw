/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { lobsterPetSeed } from "./lobster-pet-contract.ts";
import { canonicalLobsterLook, createLobsterPetLook } from "./lobster-pet-look.ts";
import { moonPhaseFraction } from "./lobster-pet-moon.ts";
import { LOBSTER_PALETTE_WEIGHTS, LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";

type LobsterPetPaletteId = ReturnType<typeof createLobsterPetLook>["palette"]["id"];

function findLobsterLook(paletteId: LobsterPetPaletteId, now: Date) {
  for (let seed = 0; seed < 20_000; seed++) {
    const look = createLobsterPetLook(seed, now);
    if (look.palette.id === paletteId) {
      return look;
    }
  }
  return undefined;
}

describe("lobster pet variants", () => {
  it("is deterministic per seed", () => {
    expect(createLobsterPetLook(1234)).toEqual(createLobsterPetLook(1234));
  });

  it("hatches every rarity tier, with rares staying rare", () => {
    const counts = new Map<string, number>();
    let shinies = 0;
    const total = 20_000;
    const neutralDate = new Date("2026-07-15T12:00:00");
    expect(LOBSTER_PET_PALETTES).toHaveLength(42);
    for (let seed = 0; seed < total; seed++) {
      const look = createLobsterPetLook(seed, neutralDate);
      counts.set(look.palette.id, (counts.get(look.palette.id) ?? 0) + 1);
      if (look.shiny) {
        shinies++;
      }
    }
    for (const { id } of LOBSTER_PET_PALETTES) {
      expect(counts.get(id) ?? 0).toBeGreaterThan(0);
    }
    for (const grail of [
      "clawtron",
      "selene",
      "geode",
      "ghost",
      "glass",
      "split",
      "sourdough",
      "zombie",
      "plush",
      "balloon",
      "cryptid",
      "flatpack",
      "tinfoil",
      "actual",
      "cottoncandy",
      "disco",
      "chimera",
      "pixel",
      "blueprint",
      "phosphor",
      "ascii",
      "portal",
      "notexture",
      "loading",
      "eclipse",
      "heisenbug",
      "invisible",
      "retro",
      "goldenretro",
    ]) {
      expect(counts.get(grail) ?? 0).toBeLessThan(total * 0.018);
    }
    const weights = new Map(
      LOBSTER_PALETTE_WEIGHTS.map(([palette, weight]) => [palette.id, weight]),
    );
    const goldenRetroWeight = expectDefined(weights.get("goldenretro"), "golden retro weight");
    const retroWeight = expectDefined(weights.get("retro"), "retro weight");
    const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
    const crimsonWeight = expectDefined(weights.get("crimson"), "crimson weight");
    expect(totalWeight).toBeCloseTo(79.15, 10);
    expect(crimsonWeight / totalWeight).toBeGreaterThan(0.25);
    expect(goldenRetroWeight).toBeLessThan(retroWeight);
    for (const [paletteId, weight] of weights) {
      if (paletteId !== "retro" && paletteId !== "goldenretro") {
        expect(retroWeight).toBeLessThan(weight);
      }
    }
    expect(counts.get("crimson") ?? 0).toBeGreaterThan(total * 0.25);
    expect(shinies).toBeGreaterThan(0);
    expect(shinies).toBeLessThan(total * 0.006);
  });

  it("mixes four stable, distinct donor palettes only for chimera", () => {
    const neutralDate = new Date("2026-07-15T12:00:00");
    let chimeraSeed: number | null = null;
    for (let seed = 0; seed < 20_000; seed++) {
      const look = createLobsterPetLook(seed, neutralDate);
      expect(look.chimeraParts === null).toBe(look.palette.id !== "chimera");
      if (look.palette.id === "chimera" && chimeraSeed === null) {
        chimeraSeed = seed;
      }
    }
    const seed = expectDefined(chimeraSeed, "chimera seed");
    const chimera = createLobsterPetLook(seed, neutralDate);
    expect(new Set(Object.values(expectDefined(chimera.chimeraParts, "chimera parts"))).size).toBe(
      4,
    );
    expect(createLobsterPetLook(seed, neutralDate).chimeraParts).toEqual(chimera.chimeraParts);

    const palette = expectDefined(
      LOBSTER_PET_PALETTES.find((candidate) => candidate.id === "chimera"),
      "chimera palette",
    );
    expect(canonicalLobsterLook(palette).chimeraParts).toEqual({
      body: "#ff4f40",
      clawLeft: "#4a7dfc",
      clawRight: "#f4b840",
      antennae: "#3f9d63",
    });
  });

  it("stably offsets canonical blink timing by palette", () => {
    const crimson = expectDefined(
      LOBSTER_PET_PALETTES.find((palette) => palette.id === "crimson"),
      "crimson palette",
    );
    const blue = expectDefined(
      LOBSTER_PET_PALETTES.find((palette) => palette.id === "blue"),
      "blue palette",
    );
    expect(canonicalLobsterLook(crimson).blinkDelayS).not.toBe(
      canonicalLobsterLook(blue).blinkDelayS,
    );
    expect(canonicalLobsterLook(crimson).blinkDelayS).toBe(
      canonicalLobsterLook(crimson).blinkDelayS,
    );
  });

  it("tracks known new and full moons", () => {
    const newMoon = moonPhaseFraction(new Date("2024-01-11T11:57:00.000Z"));
    const fullMoon = moonPhaseFraction(new Date("2024-01-25T17:54:00.000Z"));
    expect(newMoon < 0.03 || newMoon >= 0.97).toBe(true);
    expect(fullMoon).toBeGreaterThan(0.46);
    expect(fullMoon).toBeLessThan(0.54);
  });

  it("keeps Clawtron's LED on the perky antenna", () => {
    const neutralDate = new Date("2026-07-15T12:00:00");
    const clawtron = findLobsterLook("clawtron", neutralDate);
    expect(clawtron?.antennae).toBe("perky");
  });

  it("keeps zombies' antennae droopy", () => {
    const neutralDate = new Date("2026-07-15T12:00:00");
    const zombie = findLobsterLook("zombie", neutralDate);
    expect(zombie?.antennae).toBe("droopy");
  });

  it("derives distinct salted seeds per session key, stable within a load", () => {
    expect(lobsterPetSeed("agent:a:main")).toBe(lobsterPetSeed("agent:a:main"));
    expect(lobsterPetSeed("agent:a:main")).not.toBe(lobsterPetSeed("agent:b:other"));
  });
});
