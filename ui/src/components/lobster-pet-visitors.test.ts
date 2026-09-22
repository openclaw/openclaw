/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as artworkLoader from "../pages/plugins/icon-loader.ts";
import { getLobsterdex } from "./lobster-dex.ts";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";
import { planLobsterPasser, resolveLobsterPasserCrossMs } from "./lobster-pet-plans.ts";
import { arrive, createPet, spritePresent } from "./lobster-pet.test-support.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("theme visitors and resident presence", () => {
  it.each([true, false])(
    "carries a bindle after an upgrade when the resident is enabled (initially %s)",
    async (residentEnabled) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-09T12:00:00"));
      vi.stubGlobal("localStorage", window.localStorage);
      localStorage.setItem("openclaw.control.lobsterpet.gatewayVersion.v1", "2026.6.1");
      const element = createPet(42);
      element.residentEnabled = residentEnabled;
      element.gatewayVersion = "2026.7.1";
      if (!residentEnabled) {
        await element.updateComplete;
        expect(localStorage.getItem("openclaw.control.lobsterpet.gatewayVersion.v1")).toBe(
          "2026.6.1",
        );
        expect(element.querySelector(".lob-bindle")).toBeNull();
        element.residentEnabled = true;
      }
      await arrive(element);

      expect(element.querySelector(".lob-bindle")).not.toBeNull();
      expect(element.querySelector(".lobster-pet")?.getAttribute("title")).toContain(
        "just moved in",
      );
      expect(localStorage.getItem("openclaw.control.lobsterpet.gatewayVersion.v1")).toBe(
        "2026.7.1",
      );
    },
  );

  it.each([
    [9, { kind: "duck", atMs: 2795, direction: -1, floor: false, hops: false }],
    [21, { kind: "stranger", atMs: 8403, direction: 1, floor: true, hops: true }],
    [37, { kind: "snail", atMs: 5185, direction: 1, floor: false, hops: false }],
    [52, { kind: "jellyfish", atMs: 5207, direction: 1, floor: true, hops: true }],
    [119, { kind: "crab", atMs: 8322, direction: 1, floor: true, hops: false }],
    [0, null],
  ] as const)("preserves the original passer plan for seed %i", (seed, expected) => {
    expect(planLobsterPasser(seed)).toEqual(expected);
    expect(planLobsterPasser(seed, { critters: [], strangers: false })).toEqual(
      expected?.kind === "stranger" ? null : expected,
    );
  });

  it.each([
    [21, "penguin"],
    [55, "fedora"],
  ] as const)("admits configured theme visitor %s as %s without a stranger", (seed, kind) => {
    expect(
      planLobsterPasser(seed, { critters: ["penguin", "fedora"], strangers: false })?.kind,
    ).toBe(kind);
    expect(planLobsterPasser(seed, { critters: [], strangers: false })).toBeNull();
  });

  it("keeps the passer gate near 9.5% while widening the traffic", () => {
    const counts = new Map<string, number>();
    const themeCounts = new Map<string, number>();
    const total = 20_000;
    for (let seed = 0; seed < total; seed++) {
      const themed = planLobsterPasser(seed, { critters: ["penguin", "fedora"] });
      if (themed) {
        themeCounts.set(themed.kind, (themeCounts.get(themed.kind) ?? 0) + 1);
      }
      const plan = planLobsterPasser(seed);
      if (!plan) {
        continue;
      }
      counts.set(plan.kind, (counts.get(plan.kind) ?? 0) + 1);
      expect(plan.atMs).toBeGreaterThanOrEqual(2500);
      expect(plan.atMs).toBeLessThanOrEqual(9000);
    }
    for (const kind of ["stranger", "crab", "snail", "duck", "jellyfish"]) {
      expect(counts.get(kind) ?? 0).toBeGreaterThan(0);
    }
    const passers = [...counts.values()].reduce((sum, count) => sum + count, 0);
    expect(passers).toBeGreaterThan(total * 0.07);
    expect(passers).toBeLessThan(total * 0.12);
    // Strangers stay the most common traffic.
    for (const kind of ["crab", "snail", "duck", "jellyfish"]) {
      expect(counts.get("stranger") ?? 0).toBeGreaterThan(counts.get(kind) ?? 0);
    }
    for (const kind of ["stranger", "crab", "snail", "duck", "jellyfish"]) {
      expect(themeCounts.get(kind)).toBe(counts.get(kind));
    }
    for (const kind of ["penguin", "fedora"]) {
      expect(themeCounts.get(kind) ?? 0).toBeGreaterThan(total * 0.015);
      expect(themeCounts.get(kind) ?? 0).toBeLessThan(total * 0.025);
    }
  });

  it.each([
    [119, ".lobster-pet--crab"],
    [37, ".lobster-pet--snail"],
    [9, ".lobster-pet--duck"],
    [52, ".lobster-pet--jellyfish"],
    [104, ".lobster-bottle"],
    [21, ".lobster-pet--penguin"],
    [55, ".lobster-pet--fedora"],
  ] as const)(
    "keeps independent visitor %s while the resident stays home",
    async (seed, selector) => {
      vi.useFakeTimers();
      const element = createPet(seed, "offline");
      element.residentEnabled = false;
      element.critters = ["penguin", "fedora"];
      await element.updateComplete;
      await vi.advanceTimersByTimeAsync(9000);
      await element.updateComplete;
      expect(element.querySelector(selector)).not.toBeNull();
      expect(element.querySelector(".lobster-pet:not(.lobster-pet--passer)")).toBeNull();
      expect(getLobsterdex().size).toBe(0);
      element.visitsEnabled = false;
      await element.updateComplete;
      expect(element.querySelector(".lobster-pet, .lobster-bottle")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retires an active resident immediately and never summons it for offline or long runs", async () => {
    vi.useFakeTimers();
    const element = createPet(42, "offline");
    await element.updateComplete;
    await element.updateComplete;
    expect(spritePresent(element)).toBe(true);
    element.residentEnabled = false;
    await element.updateComplete;
    expect(spritePresent(element)).toBe(false);
    element.mode = "busy";
    await element.updateComplete;
    await vi.advanceTimersByTimeAsync(600_500);
    await element.updateComplete;
    expect(spritePresent(element)).toBe(false);
    element.mode = "offline";
    await element.updateComplete;
    expect(spritePresent(element)).toBe(false);
    element.residentEnabled = true;
    await element.updateComplete;
    expect(spritePresent(element)).toBe(true);
  });

  it.each(["penguin", "fedora"] as const)(
    "preserves a crossing's lifecycle when the refreshed visitor pool becomes %s",
    async (kind) => {
      vi.useFakeTimers();
      const element = createPet(21);
      element.residentEnabled = false;
      element.critters = ["penguin", "fedora"];
      await element.updateComplete;
      await vi.advanceTimersByTimeAsync(9000);
      await element.updateComplete;
      const crossing = element.querySelector(".lobster-pet--penguin");
      expect(crossing).not.toBeNull();

      element.critters = ["penguin", "fedora"];
      await element.updateComplete;
      expect(element.querySelector(".lobster-pet--penguin")).toBe(crossing);

      element.critters = [kind];
      await element.updateComplete;
      expect(element.querySelector(".lobster-pet--passer")).toBe(
        kind === "penguin" ? crossing : null,
      );
      await vi.advanceTimersByTimeAsync(13_000);
      await element.updateComplete;
      expect(element.querySelector(".lobster-pet--passer")).toBeNull();

      element.critters = ["penguin", "fedora"];
      await element.updateComplete;
      await vi.advanceTimersByTimeAsync(10_000);
      await element.updateComplete;
      expect(element.querySelector(".lobster-pet--passer")).toBeNull();
      element.critters = ["penguin", "fedora"];
      await element.updateComplete;
      await vi.advanceTimersByTimeAsync(10_000);
      await element.updateComplete;
      expect(element.querySelector(".lobster-pet--passer")).toBeNull();

      element.seed = 55;
      await element.updateComplete;
      await vi.advanceTimersByTimeAsync(9000);
      await element.updateComplete;
      expect(element.querySelector(".lobster-pet--fedora")).not.toBeNull();
    },
  );

  it("earns the golden ledge trim once the Lobsterdex is complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.lobsterdex.v1",
      JSON.stringify(
        Object.fromEntries(
          LOBSTER_PET_PALETTES.map((palette) => [palette.id, { firstSeenAt: 1, name: "First" }]),
        ),
      ),
    );
    const element = createPet(42);
    await element.updateComplete;
    expect(element.hasAttribute("data-dex-complete")).toBe(true);

    element.residentEnabled = false;
    await element.updateComplete;
    expect(element.hasAttribute("data-dex-complete")).toBe(false);
    element.residentEnabled = true;
    await element.updateComplete;
    expect(element.hasAttribute("data-dex-complete")).toBe(true);

    // The visits setting silences the trim like everything else.
    element.visitsEnabled = false;
    await element.updateComplete;
    expect(element.hasAttribute("data-dex-complete")).toBe(false);
  });
  it("plans plugin ids and resolves catalog, artwork, and default crossing durations", () => {
    expect(planLobsterPasser(21, { critters: ["ferris"], strangers: false })?.kind).toBe("ferris");
    const artwork = {
      ferris: { url: "/ferris", crossMs: 5000 },
      snail: { url: "/snail", crossMs: 5000 },
    };
    expect(resolveLobsterPasserCrossMs("snail", artwork)).toBe(90000);
    expect(resolveLobsterPasserCrossMs("ferris", artwork)).toBe(5000);
    expect(resolveLobsterPasserCrossMs("constructor")).toBe(12000);
  });

  it.each(["crab", "stranger"])(
    "renders declared %s artwork without the resident",
    async (kind) => {
      const fetchArtwork = vi
        .spyOn(artworkLoader, "fetchPluginThemeArtworkBlobUrl")
        .mockResolvedValue("blob:plugin-visitor");
      onTestFinished(() => fetchArtwork.mockRestore());
      vi.useFakeTimers();
      const element = createPet(21);
      element.residentEnabled = false;
      element.critters = [kind];
      element.critterArtwork = {
        [kind]: { url: `/plugin/${kind}`, title: "a plugin visitor", crossMs: 5000 },
      };
      await element.updateComplete;
      await vi.advanceTimersByTimeAsync(9000);
      await element.updateComplete;
      await vi.dynamicImportSettled();
      const passer = element.querySelector<HTMLElement>(".lobster-pet--passer")!;
      expect(passer.title).toBe("a plugin visitor");
      expect(passer.style.getPropertyValue("--lob-scale")).toBe("1.8");
      expect(passer.style.getPropertyValue("--lob-cross")).toBe("11000ms");
      expect(passer.querySelector(".lobster-pet__body img")?.getAttribute("src")).toBe(
        "blob:plugin-visitor",
      );
      expect(passer.querySelector("svg")).toBeNull();
      element.critters = [...element.critters];
      await element.updateComplete;
      expect(element.querySelector(".lobster-pet--passer")).toBe(passer);
    },
  );

  it("renders plugin visitors, refreshes their artwork, and retires a removed visitor", async () => {
    const fetchArtwork = vi
      .spyOn(artworkLoader, "fetchPluginThemeArtworkBlobUrl")
      .mockImplementation(async ({ url }) => `blob:${url}`);
    onTestFinished(() => fetchArtwork.mockRestore());
    vi.useFakeTimers();
    const element = createPet(21);
    element.residentEnabled = false;
    element.critters = ["ferris"];
    element.critterArtwork = {
      ferris: { url: "/ferris?v=1", title: "a crab, allegedly", crossMs: 5000 },
    };
    await element.updateComplete;
    await vi.advanceTimersByTimeAsync(9000);
    await element.updateComplete;
    await vi.dynamicImportSettled();
    const passer = element.querySelector<HTMLElement>(".lobster-pet--ferris")!;
    expect(passer.title).toBe("a crab, allegedly");
    expect(passer.style.getPropertyValue("--lob-cross")).toBe("5000ms");
    expect(passer.querySelector(".lobster-pet__body img")?.getAttribute("src")).toBe(
      "blob:/ferris?v=1",
    );
    element.critterArtwork = { ferris: { url: "/ferris?v=2", crossMs: 90000 } };
    await element.updateComplete;
    await vi.dynamicImportSettled();
    expect(passer.title).toBe("ferris");
    expect(passer.querySelector("img")?.getAttribute("src")).toBe("blob:/ferris?v=2");
    expect(passer.style.getPropertyValue("--lob-cross")).toBe("5000ms");
    element.critters = [];
    await element.updateComplete;
    expect(element.querySelector(".lobster-pet--passer")).toBeNull();
  });
});
