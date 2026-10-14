/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { lobsterPetSeed } from "./lobster-pet-contract.ts";
import { canonicalLobsterLook, createLobsterPetLook } from "./lobster-pet-look.ts";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";

describe("lobster pet variants", () => {
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

  it("derives distinct salted seeds per session key, stable within a load", () => {
    expect(lobsterPetSeed("agent:a:main")).toBe(lobsterPetSeed("agent:a:main"));
    expect(lobsterPetSeed("agent:a:main")).not.toBe(lobsterPetSeed("agent:b:other"));
  });
});
