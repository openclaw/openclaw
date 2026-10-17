/* @vitest-environment jsdom */

import { beforeEach, afterEach, expect, it, onTestFinished, vi } from "vitest";
import * as artworkLoader from "../pages/plugins/icon-loader.ts";
import { getLobsterdex } from "./lobster-dex.ts";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";
import { planLobsterPasser, resolveLobsterPasserCrossMs } from "./lobster-pet-plans.ts";
import { arrive, createPet, spritePresent } from "./lobster-pet.test-support.ts";
type Pet = ReturnType<typeof createPet>;

const visitorPool = () => ["penguin", "fedora"] as const;
const versionKey = "openclaw.control.lobsterpet.gatewayVersion.v1";
const residentSelector = ".lobster-pet:not(.lobster-pet--passer)";
const passerSelector = ".lobster-pet--passer";
beforeEach(() => vi.useFakeTimers());
async function crossingPet(seed = 21, props: Partial<Pet> = {}, mode: Pet["mode"] = "idle") {
  const element = createPet(seed, mode);
  await updatePet(element, { residentEnabled: false, critters: visitorPool(), ...props }, 9000);
  return element;
}
async function tick(element: Pet, ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await element.updateComplete;
}
async function updatePet(element: Pet, props: Partial<Pet>, elapsed = 0) {
  Object.assign(element, props);
  await element.updateComplete;
  if (elapsed) {
    await tick(element, elapsed);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

it.each([true, false])("brings an upgrade bindle (resident=%s)", async (residentEnabled) => {
  vi.setSystemTime(new Date("2026-07-09T12:00:00"));
  localStorage.setItem(versionKey, "2026.6.1");
  const element = createPet(42);
  element.residentEnabled = residentEnabled;
  element.gatewayVersion = "2026.7.1";
  if (!residentEnabled) {
    await element.updateComplete;
    expect(localStorage.getItem(versionKey)).toBe("2026.6.1");
    expect(element.querySelector(".lob-bindle")).toBeNull();
    element.residentEnabled = true;
  }
  await arrive(element);

  expect(element.querySelector(".lob-bindle")).not.toBeNull();
  expect(element.querySelector(".lobster-pet")?.getAttribute("title")).toContain("just moved in");
  expect(localStorage.getItem(versionKey)).toBe("2026.7.1");
});

it.each([
  [9, ".lobster-pet--duck"],
  [104, ".lobster-bottle"],
] as const)("keeps visitor %s independent of the disabled resident", async (seed, selector) => {
  const element = await crossingPet(seed, {}, "offline");
  expect(element.querySelector(selector)).not.toBeNull();
  expect(element.querySelector(residentSelector)).toBeNull();
  expect(getLobsterdex().size).toBe(0);
  await updatePet(element, { visitsEnabled: false });
  expect(element.querySelector(".lobster-pet, .lobster-bottle")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("retires an active resident immediately and never summons it for offline or long runs", async () => {
  const element = createPet(42, "offline");
  await element.updateComplete;
  vi.advanceTimersToNextFrame();
  await element.updateComplete;
  expect(spritePresent(element)).toBe(true);
  for (const [props, delay, present] of [
    [{ residentEnabled: false }, 0, false],
    [{ mode: "busy" }, 600_500, false],
    [{ mode: "offline" }, 0, false],
    [{ residentEnabled: true }, 0, true],
  ] as const) {
    await updatePet(element, props, delay);
    expect(spritePresent(element)).toBe(present);
  }
});

it.each(["penguin", "fedora"] as const)("refreshes a crossing's pool to %s", async (kind) => {
  const element = await crossingPet();
  const crossing = element.querySelector(".lobster-pet--penguin");
  expect(crossing).not.toBeNull();

  await updatePet(element, { critters: visitorPool() });
  expect(element.querySelector(".lobster-pet--penguin")).toBe(crossing);

  await updatePet(element, { critters: [kind] });
  expect(element.querySelector(passerSelector)).toBe(kind === "penguin" ? crossing : null);
  await tick(element, 13_000);
  expect(element.querySelector(passerSelector)).toBeNull();

  for (let refresh = 0; refresh < 2; refresh++) {
    await updatePet(element, { critters: visitorPool() }, 10_000);
    expect(element.querySelector(passerSelector)).toBeNull();
  }

  const parent = element.parentElement!;
  element.remove();
  await element.updateComplete;
  parent.append(element);
  await element.updateComplete;
  await tick(element, 10_000);
  expect(element.querySelector(passerSelector)).toBeNull();

  await updatePet(element, { seed: 55 }, 9000);
  expect(element.querySelector(".lobster-pet--fedora")).not.toBeNull();
});

it("publishes the resident's greeting at a visitor's midpoint", async () => {
  vi.setSystemTime(new Date("2026-07-09T12:00:00"));
  localStorage.setItem(
    "openclaw.control.lobsterpet.familiarity.v1",
    JSON.stringify({ visits: 15, shoos: 0 }),
  );
  const element = createPet(21);
  await element.updateComplete;
  // This load's stranger arrives at 8,403ms and crosses for 11 seconds.
  await tick(element, 13_902);
  const resident = element.querySelector<HTMLElement>(residentSelector);
  expect(resident?.classList.contains("lobster-pet--act-wave")).toBe(false);
  await tick(element, 1);
  expect(resident?.classList.contains("lobster-pet--act-wave")).toBe(true);
});

it("earns the golden ledge trim once the Lobsterdex is complete", async () => {
  vi.setSystemTime(new Date("2026-07-09T12:00:00"));
  const dex = Object.fromEntries(LOBSTER_PET_PALETTES.map(({ id }) => [id, {}]));
  localStorage.setItem("openclaw.control.lobsterdex.v1", JSON.stringify(dex));
  const element = createPet(42);
  await element.updateComplete;
  expect(element.hasAttribute("data-dex-complete")).toBe(true);
  for (const [props, complete] of [
    [{ residentEnabled: false }, false],
    [{ residentEnabled: true }, true],
    [{ visitsEnabled: false }, false],
  ] as const) {
    await updatePet(element, props);
    expect(element.hasAttribute("data-dex-complete")).toBe(complete);
  }
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

it.each([
  ["crab", "a plugin visitor", 11000],
  ["stranger", "a plugin visitor", 11000],
  ["ferris", "a crab, allegedly", 5000],
] as const)(
  "preserves declared %s artwork and crossing across refreshes",
  async (kind, title, crossMs) => {
    const fetchArtwork = vi
      .spyOn(artworkLoader, "fetchPluginThemeArtworkBlobUrl")
      .mockImplementation(async ({ url }) => `blob:${url}`);
    onTestFinished(() => fetchArtwork.mockRestore());

    const element = await crossingPet(21, {
      critters: [kind],
      critterArtwork: { [kind]: { url: `/${kind}?v=1`, title, crossMs: 5000 } },
    });
    await vi.dynamicImportSettled();
    const passer = element.querySelector<HTMLElement>(`.lobster-pet--${kind}`)!;
    expect(passer.title).toBe(title);
    expect(passer.style.getPropertyValue("--lob-scale")).toBe("1.8");
    expect(passer.style.getPropertyValue("--lob-cross")).toBe(`${crossMs}ms`);
    expect(passer.querySelector(".lobster-pet__body img")?.getAttribute("src")).toBe(
      `blob:/${kind}?v=1`,
    );
    expect(passer.querySelector("svg")).toBeNull();
    await updatePet(element, { critters: [...element.critters] });
    expect(element.querySelector(passerSelector)).toBe(passer);

    if (kind === "ferris") {
      await updatePet(element, {
        critterArtwork: { ferris: { url: "/ferris?v=2", crossMs: 90000 } },
      });
      await vi.dynamicImportSettled();
      expect(passer.title).toBe("ferris");
      expect(passer.querySelector("img")?.getAttribute("src")).toBe("blob:/ferris?v=2");
      expect(passer.style.getPropertyValue("--lob-cross")).toBe("5000ms");
      await updatePet(element, { critters: [] });
      expect(element.querySelector(passerSelector)).toBeNull();
    }
  },
);
