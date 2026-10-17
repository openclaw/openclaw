/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings, settingsKeyForGateway } from "../app/settings.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { getLobsterdex, getLobsterdexEntries } from "./lobster-dex.ts";
import { resolveLobsterPetMode, resolveLobsterRunOutcome } from "./lobster-pet-contract.ts";
import {
  canonicalLobsterLook,
  createLobsterPetLook,
  renderLobsterSvg,
} from "./lobster-pet-look.ts";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";
import {
  LOBSTER_BOTTLE_FORTUNES,
  pickLobsterEntrance,
  planLobsterBottle,
  resolveLobsterLoadIdentity,
} from "./lobster-pet-plans.ts";
import {
  advanceUntil,
  arrive,
  createPet,
  spritePresent,
  type LobsterPetElement,
} from "./lobster-pet.test-support.ts";

const paletteById = (id: string) =>
  expectDefined(
    LOBSTER_PET_PALETTES.find((entry) => entry.id === id),
    id,
  );
const activity = (status: "done" | "failed", lastActivityAt: number, endedAt?: number) => ({
  status,
  lastActivityAt,
  ...(endedAt === undefined ? {} : { endedAt }),
});

function paletteSvg(
  id: string,
  options: Parameters<typeof renderLobsterSvg>[1] = {},
  accessory: "none" | "crown" = "none",
) {
  const palette = paletteById(id);
  return renderLobsterSvg(
    { ...canonicalLobsterLook(palette), accessory },
    { standalone: true, ...options },
  );
}

const summer = new Date("2026-07-09T12:00:00");
const neutralDate = new Date("2026-07-15T12:00:00");
const identityOf = (seed: number) =>
  resolveLobsterLoadIdentity(seed, createLobsterPetLook(seed, neutralDate));
const friends = {
  gold: { firstSeenAt: 1, name: "Goldenrod" },
  watermelon: { firstSeenAt: 2, name: "Pips" },
};
function rememberDex(
  entries: Record<string, { firstSeenAt: number; name: string; shinySeenAt?: number }>,
) {
  localStorage.setItem("openclaw.control.lobsterdex.v1", JSON.stringify(entries));
}
async function expectPresenceAfter(
  element: LobsterPetElement,
  present: boolean,
  maxMs: number,
  selector = ".lobster-pet",
) {
  const hasExpectedPresence = () => (element.querySelector(selector) !== null) === present;
  expect(await advanceUntil(element, hasExpectedPresence, maxMs)).toBe(true);
}
async function visitingPet(seed = 42, mode?: Parameters<typeof createPet>[1]) {
  const element = createPet(seed, mode);
  await arrive(element);
  return element;
}
async function tick(element: LobsterPetElement, ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await element.updateComplete;
}
async function expectClassAfter(element: LobsterPetElement, suffix: string, maxMs = 10_000) {
  const hasClass = () => spriteClasses(element).includes(`lobster-pet--${suffix}`);
  expect(await advanceUntil(element, hasClass, maxMs, 100)).toBe(true);
}
async function openDismissMenu(
  element: LobsterPetElement,
  options: MouseEventInit = {},
  selector = ".lobster-pet",
) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...options });
  element.querySelector(selector)?.dispatchEvent(event);
  await element.updateComplete;
  await settleDismissMenu(element);
}
async function settleDismissMenu(element: LobsterPetElement) {
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    const firstItem = element.querySelector('.lobster-pet-dismiss-menu [role="menuitem"]');
    expect(firstItem).not.toBeNull();
    expect(document.activeElement).toBe(firstItem);
  });
}

function selectDismissal(element: LobsterPetElement, value: "dismiss" | "dismiss-permanently") {
  expectDefined(
    element.querySelector<HTMLButtonElement>(`[role="menuitem"][data-value="${value}"]`),
    `${value} menu item`,
  ).click();
}

function poke(element: LobsterPetElement): void {
  const sprite = element.querySelector(".lobster-pet");
  sprite?.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
  sprite?.dispatchEvent(new MouseEvent("pointerup", { button: 0, bubbles: true }));
}

function spriteClasses(element: LobsterPetElement): string {
  return element.querySelector(".lobster-pet")?.className ?? "";
}

async function advanceUntilAct(element: LobsterPetElement, maxMs: number): Promise<string | null> {
  let act: string | null = null;
  await advanceUntil(
    element,
    () => {
      act = /lobster-pet--act-([a-z]+)/.exec(spriteClasses(element))?.[1] ?? null;
      return act !== null;
    },
    maxMs,
    200,
  );
  return act;
}

async function startVigilOnlyRun(outcome: LobsterPetElement["runOutcome"]) {
  // Seed 0 opts out of scheduled visits and passers, so vigil is the only
  // presence owner when the run finishes.
  const element = createPet(0, "busy");
  await updatePet(element, { runOutcome: outcome });
  expect(spritePresent(element)).toBe(false);
  await tick(element, 600_500);
  expect(spriteClasses(element)).toContain("lobster-pet--vigil");
  return element;
}

async function updatePet(element: LobsterPetElement, props: Partial<LobsterPetElement>) {
  Object.assign(element, props);
  await element.updateComplete;
}

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("seasonal wardrobe", () => {
  it.each([
    ["2026-12-10", ["santa"], ["pumpkin"]],
    ["2026-10-25", ["pumpkin"], ["santa"]],
    ["2026-07-15", [], ["santa", "pumpkin", "party", "monocle"]],
    ["2026-09-25", ["monocle"], ["pumpkin"]],
  ] as const)("respects seasonal accessories on %s", (date, present, absent) => {
    const accessories = new Set(
      Array.from(
        { length: 400 },
        (_, seed) => createLobsterPetLook(seed, new Date(`${date}T12:00:00`)).accessory,
      ),
    );
    for (const accessory of present) {
      expect(accessories).toContain(accessory);
    }
    for (const accessory of absent) {
      expect(accessories).not.toContain(accessory);
    }
  });
  it("dresses everyone as the classic logo on the repo anniversary", () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(createLobsterPetLook(seed, new Date("2026-11-24T12:00:00"))).toMatchObject({
        palette: { id: "retro" },
        accessory: "party",
      });
    }
    expect(createLobsterPetLook(7, new Date("2026-11-25T12:00:00")).accessory).not.toBe("party");
  });
});

describe("connection and run outcomes", () => {
  it.each<[boolean, Parameters<typeof resolveLobsterPetMode>[1], string]>([
    [false, [{ hasActiveRun: true }], "offline"],
    [true, null, "idle"],
    [true, [{ hasActiveRun: false }, {}], "idle"],
    [true, [{ hasActiveRun: false }, { hasActiveRun: true }], "busy"],
    [true, [{ status: "done", hasActiveRun: true }], "idle"],
    [true, [{ status: "running", hasActiveRun: true }], "busy"],
  ])("resolves connected=%s sessions=%j as %s", (connected, sessions, expected) => {
    expect(resolveLobsterPetMode(connected, sessions)).toBe(expected);
  });
  it.each<[Parameters<typeof resolveLobsterRunOutcome>[0], string]>([
    [null, "ok"],
    [[activity("done", 10), activity("failed", 20)], "error"],
    [[activity("failed", 10), activity("done", 20)], "ok"],
    [[{ status: "running", lastActivityAt: 99 }], "ok"],
    [[{ status: "timeout", updatedAt: 5 }], "error"],
    [[{ status: "killed", endedAt: 50 }], "aborted"],
    // endedAt outranks activity stamps touched by unrelated events.
    [[activity("failed", 10, 30), activity("done", 40, 20)], "error"],
  ])("resolves terminal sessions %j as %s", (sessions, expected) => {
    expect(resolveLobsterRunOutcome(sessions)).toBe(expected);
  });
});

describe("lobster pet element", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(summer);
  });
  it("starts hidden and arrives on its seeded visit schedule", async () => {
    const element = createPet(42);
    await element.updateComplete;
    expect(spritePresent(element)).toBe(false);
    await tick(element, 1_000);
    expect(spritePresent(element)).toBe(false);
    await arrive(element);
    expect(element.querySelector(".lobster-pet__svg")).not.toBeNull();
    expect(spriteClasses(element)).toContain("lobster-pet--idle");
    expect(["top", "floor"]).toContain(element.getAttribute("data-spot"));
  });

  it("a shy seed never visits on its own", async () => {
    const element = createPet(7);
    await element.updateComplete;
    expect(await advanceUntil(element, () => spritePresent(element), 12_000)).toBe(false);
  });

  it("departs after its stay and returns for a later visit", async () => {
    const element = await visitingPet(42);
    await expectPresenceAfter(element, false, 400_000);
    expect(await advanceUntil(element, () => spritePresent(element), 1_200_000)).toBe(false);
    await expectPresenceAfter(element, true, 2_500_000);
  });

  it("schedules acts while perched", async () => {
    const element = await visitingPet(42);
    const act = await advanceUntilAct(element, 20_000);
    expect(act).not.toBeNull();
    expect(spriteClasses(element)).toContain(`lobster-pet--act-${act}`);
  });

  it("reacts to busy, idle, and offline mode changes", async () => {
    const element = await visitingPet(42);
    await updatePet(element, { mode: "busy" });
    expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
    expect(spriteClasses(element)).toContain("lobster-pet--busy");
    await updatePet(element, { runOutcome: "ok", mode: "idle" });
    expect(spriteClasses(element)).toContain("lobster-pet--act-cheer");
    const offline = createPet(7, "offline");
    await offline.updateComplete;
    vi.advanceTimersToNextFrame();
    await offline.updateComplete;
    expect(spritePresent(offline)).toBe(true);
    expect(spriteClasses(offline)).toContain("lobster-pet--offline");
  });

  it("renders deterministic molt and twin load variants", async () => {
    const molting = await visitingPet(2);
    expect(await advanceUntilAct(molting, 30_000)).toBe("molt");
    await expectPresenceAfter(molting, true, 30_000, ".lobster-pet--shell");
    const twins = await visitingPet(21);
    expect(twins.querySelectorAll(".lobster-pet:not(.lobster-pet--shell)")).toHaveLength(2);
    expect(twins.querySelector(".lobster-pet--twin")?.getAttribute("title")).toMatch(/ Jr\.$/);
  });

  it("records arrivals in the lobsterdex", async () => {
    await visitingPet(42);
    const look = createLobsterPetLook(42, summer);
    expect(getLobsterdex().has(look.palette.id)).toBe(true);
    expect(getLobsterdexEntries().get(look.palette.id)?.name).toBeTruthy();
  });

  it("anchors the dismiss menu at the raw pointer position and preserves outside focus", async () => {
    const element = await visitingPet(42);
    const composer = element.parentElement!.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.focus();

    // Exceed the old 264×80 pre-clamp to catch trigger-coordinate drift.
    const clientX = 1200;
    const clientY = 850;
    await openDismissMenu(element, { clientX, clientY });
    const menu = element.querySelector(".lobster-pet-dismiss-menu__panel");
    expect(menu?.getAttribute("data-placement")).toBe("top-start");
    const trigger = element.querySelector<HTMLElement>(
      ".lobster-pet-dismiss-menu .oc-menu-trigger",
    );
    const position = trigger?.closest<HTMLElement>(".lobster-pet-dismiss-menu__position");
    expect(position?.style.getPropertyValue("--lobster-pet-menu-x")).toBe(`${clientX}px`);
    expect(position?.style.getPropertyValue("--lobster-pet-menu-y")).toBe(`${clientY}px`);
    expect(trigger?.tabIndex).toBe(-1);
    expect(trigger?.getAttribute("aria-hidden")).toBe("true");
    composer.focus();
    await Promise.resolve();
    expect(menu?.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(composer);
  });

  it("offers a temporary dismissal from the right-click menu", async () => {
    const element = await visitingPet(42);
    const composer = element.parentElement!.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.focus();

    const sprite = element.querySelector(".lobster-pet");
    sprite?.dispatchEvent(new MouseEvent("pointerdown", { button: 2 }));
    const shoo = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    sprite?.dispatchEvent(shoo);
    sprite?.dispatchEvent(new MouseEvent("pointerup", { button: 2 }));
    await element.updateComplete;
    expect(shoo.defaultPrevented).toBe(true);
    expect(spritePresent(element)).toBe(true);
    expect(spriteClasses(element)).not.toContain("lobster-pet--act-startle");
    await settleDismissMenu(element);
    expect(
      [...element.querySelectorAll('.lobster-pet-dismiss-menu [role="menuitem"]')].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["Dismiss", "Dismiss and don't show again"]);

    const veto = (event: Event) => event.preventDefault();
    document.addEventListener("overlay-hide", veto);
    try {
      selectDismissal(element, "dismiss");
      await element.updateComplete;
      expect(spriteClasses(element)).not.toContain("lobster-pet--away");
      expect(element.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(true);
      expect(document.activeElement).toBe(
        element.querySelector('.lobster-pet-dismiss-menu [role="menuitem"]'),
      );
    } finally {
      document.removeEventListener("overlay-hide", veto);
    }
    selectDismissal(element, "dismiss");
    await element.updateComplete;
    expect(document.activeElement).toBe(composer);

    await expectPresenceAfter(element, false, 5_000);

    // Dismissal outlasts later scheduled visits and even offline summons.
    expect(await advanceUntil(element, () => spritePresent(element), 3_700_000)).toBe(false);
    await updatePet(element, { mode: "offline" });
    expect(spritePresent(element)).toBe(false);
  });

  it("persists permanent dismissal in browser storage", async () => {
    const element = await visitingPet(42);
    await openDismissMenu(element);
    selectDismissal(element, "dismiss-permanently");
    await element.updateComplete;
    const key = settingsKeyForGateway(loadSettings().gatewayUrl);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toMatchObject({
      lobsterPetVisits: false,
    });
    await expectPresenceAfter(element, false, 5_000);
  });

  it("never shows when visits are disabled, offline included", async () => {
    const element = createPet(42, "offline");
    await updatePet(element, { visitsEnabled: false });
    expect(spritePresent(element)).toBe(false);
    expect(await advanceUntil(element, () => spritePresent(element), 1_200_000)).toBe(false);
  });

  it("stops timers on disconnect", async () => {
    const element = await visitingPet(42);
    element.remove();
    await element.updateComplete;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 3, 10])("reacts to %s fast pokes and recovers", async (count) => {
    const element = await visitingPet(42);
    for (let i = 0; i < count; i++) {
      poke(element);
      await element.updateComplete;
    }
    if (count === 1) {
      expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
    } else if (count === 3) {
      expect(spriteClasses(element)).toContain("lobster-pet--grumpy");
      await tick(element, 61_000);
      expect(spriteClasses(element)).not.toContain("lobster-pet--grumpy");
    } else {
      await expectPresenceAfter(element, false, 5_000);
      await expectPresenceAfter(element, true, 3_700_000);
    }
  });

  it("old friends wave hello on their first arrival of the load", async () => {
    localStorage.setItem(
      "openclaw.control.lobsterpet.familiarity.v1",
      JSON.stringify({ visits: 30, shoos: 0 }),
    );
    const element = await visitingPet(42);
    await tick(element, 600);
    expect(spriteClasses(element)).toContain("lobster-pet--act-wave");
  });

  it("shooing is remembered in the familiarity counters", async () => {
    const element = await visitingPet(42);
    await openDismissMenu(element, {}, ".lobster-pet:not(.lobster-pet--shell)");
    selectDismissal(element, "dismiss");
    await element.updateComplete;
    const raw = JSON.parse(
      localStorage.getItem("openclaw.control.lobsterpet.familiarity.v1") ?? "{}",
    );
    expect(raw.shoos).toBe(1);
  });

  it("cancels a pending pet when the pointer interaction is cancelled", async () => {
    const element = createPet(42, "offline");
    await element.updateComplete;
    const sprite = element.querySelector(".lobster-pet");
    sprite?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    sprite?.dispatchEvent(new Event("pointercancel"));
    await tick(element, 400);
    expect(spriteClasses(element)).not.toContain("lobster-pet--act-pet");
  });

  it("droops instead of cheering when the finished run failed", async () => {
    const element = createPet(42, "busy");
    element.runOutcome = "error";
    await arrive(element);
    await updatePet(element, { mode: "idle" });
    expect(spriteClasses(element)).toContain("lobster-pet--act-droop");
    expect(spriteClasses(element)).not.toContain("lobster-pet--act-cheer");
  });

  it("keeps vigil during long runs and settles until the run ends", async () => {
    const element = await visitingPet(42, "busy");
    await tick(element, 600_500);
    expect(spriteClasses(element)).toContain("lobster-pet--vigil");
    const act = await advanceUntilAct(element, 30_000);
    expect(act).toBeNull();
    await updatePet(element, { mode: "idle" });
    expect(spriteClasses(element)).not.toContain("lobster-pet--vigil");
  });

  it.each([
    ["ok", "cheer"],
    ["error", "droop"],
    ["aborted", "startle"],
  ] as const)(
    "finishes a vigil-only %s run with a visible %s before leaving",
    async (outcome, act) => {
      const element = await startVigilOnlyRun(outcome);
      await updatePet(element, { mode: "idle" });
      expect(spriteClasses(element)).toContain(`lobster-pet--act-${act}`);
      expect(spriteClasses(element)).not.toContain("lobster-pet--away");

      await advanceUntil(
        element,
        () =>
          spriteClasses(element).includes("lobster-pet--away") ||
          spriteClasses(element).includes("lobster-pet--act-sweep"),
        10_000,
        100,
      );
      if (outcome === "error") {
        expect(spriteClasses(element)).toContain("lobster-pet--act-sweep");
        expect(spriteClasses(element)).not.toContain("lobster-pet--away");
        await expectClassAfter(element, "away");
      }
      expect(spriteClasses(element)).toContain("lobster-pet--away");

      await tick(element, 400);
      expect(spritePresent(element)).toBe(false);
    },
  );

  it.each(["seed reset", "page hide"] as const)(
    "releases vigil outcome presence on %s",
    async (cleanup) => {
      const element = await startVigilOnlyRun("ok");
      await updatePet(element, { mode: "idle" });

      if (cleanup === "seed reset") {
        element.seed = 7;
      } else {
        const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
        hidden.mockRestore();
      }
      await element.updateComplete;
      expect(spriteClasses(element)).not.toContain("lobster-pet--act-cheer");

      await tick(element, 400);
      expect(spritePresent(element)).toBe(false);
    },
  );

  it("watches the pointer between acts", async () => {
    const element = await visitingPet(42);
    // jsdom rects are zero: positive/negative X is right/left of the sprite.
    for (const [clientX, facing] of [
      [400, "1"],
      [-400, "-1"],
    ] as const) {
      await vi.advanceTimersByTimeAsync(200);
      document.dispatchEvent(new MouseEvent("pointermove", { clientX }));
      await element.updateComplete;
      expect(
        element.querySelector<HTMLElement>(".lobster-pet")?.style.getPropertyValue("--lob-face"),
      ).toBe(facing);
    }
  });

  it("travels light on first sighting and on same-version reloads", async () => {
    const first = createPet(42);
    first.gatewayVersion = "2026.7.1";
    await arrive(first);
    expect(first.querySelector(".lob-bindle")).toBeNull();
    expect(localStorage.getItem("openclaw.control.lobsterpet.gatewayVersion.v1")).toBe("2026.7.1");
    first.remove();
    const second = createPet(42);
    second.gatewayVersion = "2026.7.1";
    await arrive(second);
    expect(second.querySelector(".lob-bindle")).toBeNull();
  });

  it.each(["running", "suspended"] as const)(
    "keeps opt-in sounds and pet interaction usable with %s audio",
    async (audioState) => {
      let resumeCalls = 0;
      const audioContextCtor = vi.fn(function MockAudioContext() {
        const param = () => ({ setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
        return {
          state: audioState,
          currentTime: 0,
          destination: {},
          // Vitest spies consume rejected promises while recording settled results.
          resume: () => {
            resumeCalls += 1;
            return Promise.reject(new Error("Audio resume rejected"));
          },
          close: vi.fn(() => Promise.resolve()),
          createOscillator: vi.fn(() => ({
            type: "sine",
            frequency: param(),
            connect: (node: unknown) => node,
            start: vi.fn(),
            stop: vi.fn(),
          })),
          createGain: vi.fn(() => ({ gain: param(), connect: vi.fn() })),
        };
      });
      vi.stubGlobal("AudioContext", audioContextCtor);
      const element = await visitingPet(42);
      poke(element);
      expect(audioContextCtor).not.toHaveBeenCalled();

      await updatePet(element, { soundsEnabled: true });
      poke(element);
      expect(audioContextCtor).toHaveBeenCalledTimes(1);
      await element.updateComplete;
      expect(resumeCalls).toBe(audioState === "suspended" ? 1 : 0);
      expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
    },
  );

  it("wears the party hat on its first-visit anniversary", async () => {
    const look = createLobsterPetLook(42, summer);
    rememberDex({
      [look.palette.id]: {
        firstSeenAt: new Date("2025-07-09T12:00:00").getTime(),
        name: "Original",
      },
    });
    const element = await visitingPet(42);
    expect(spriteClasses(element)).toContain("lobster-pet--party");
    expect(getLobsterdexEntries().get(look.palette.id)?.name).toBe("Original");
  });

  it("wears the sailor cap on lobster days, deferring to rolled headwear", async () => {
    // This lobster day rolls a face-worn eyepatch, leaving room for the cap.
    vi.setSystemTime(new Date("2026-01-05T12:00:00"));
    const element = await visitingPet(42);
    expect(element.querySelector(".lob-cap")).not.toBeNull();
    element.remove();
    vi.setSystemTime(summer);
    const plain = await visitingPet(42);
    expect(plain.querySelector(".lob-cap")).toBeNull();
  });

  it("ships a hidden peek eye only in sleeping renders", () => {
    const container = document.createElement("div");
    const look = createLobsterPetLook(42, summer);
    container.replaceChildren(renderLobsterSvg(look, { sleeping: true }));
    expect(container.querySelector(".lob-eye-peek")).not.toBeNull();
    container.replaceChildren(renderLobsterSvg(look, { standalone: true }));
    expect(container.querySelector(".lob-eye-peek")).toBeNull();
  });

  it("props an open book against the claws while keeping both eyes open", () => {
    const container = paletteSvg("crimson", { reading: true });
    expect(container.querySelector(".lob-reading-book")).not.toBeNull();
    expect(container.querySelectorAll(".lob-eye-open circle")).toHaveLength(4);
    expect(container.querySelector<SVGElement>(".lob-eye-closed")?.style.display).toBe("none");
  });

  it("renders full replacement geometry without the standard dome", () => {
    const flatpackContainer = paletteSvg("flatpack", {}, "crown");
    expect(flatpackContainer.querySelector(".lob-flatpack")).not.toBeNull();
    expect(flatpackContainer.querySelector(".lob-flatpack__allen-key")).not.toBeNull();
    expect(flatpackContainer.querySelector('[fill="#f6c945"]')).toBeNull();

    const loadingContainer = paletteSvg("loading");
    expect(loadingContainer.querySelector(".lob-skeleton")).not.toBeNull();
    expect(loadingContainer.querySelectorAll(".lob-eye-open circle")).toHaveLength(2);

    for (const [id, selector] of [
      ["actual", ".lob-actual"],
      ["balloon", ".lob-balloon-frame"],
      ["ascii", ".lob-ascii"],
      ["portal", ".lob-portal-ring"],
    ] as const) {
      const container = paletteSvg(id);
      expect(container.querySelector(selector)).not.toBeNull();
      expect(container.querySelector(".lob-standard-dome")).toBeNull();
      if (id === "ascii") {
        expect(container.querySelector(".lob-eye-open")?.textContent).toContain("(o)");
        expect(container.querySelector(".lob-eye-closed")?.textContent).toContain("(-)");
      } else if (id === "portal") {
        expect(container.querySelectorAll(".lob-portal-ring")).toHaveLength(2);
      }
    }
  });

  it("never stacks the sailor cap on the tinfoil hat", () => {
    const container = paletteSvg("tinfoil", { sailorCap: true });
    expect(container.querySelector(".lob-tinfoil-hat")).not.toBeNull();
    expect(container.querySelector(".lob-cap")).toBeNull();
  });

  it("stays static when reduced motion is preferred, including visibility resumes", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    const element = await visitingPet(42);
    expect(element.querySelector(".lobster-pet__svg")).not.toBeNull();
    // Visibility resumes and mode flips must also honor reduced motion.
    document.dispatchEvent(new Event("visibilitychange"));
    await updatePet(element, { mode: "busy" });
    const act = await advanceUntilAct(element, 30_000);
    expect(act).toBeNull();
  });
});

describe("lobster plans", () => {
  it("maps entrance rolls to their rarity bands", () => {
    expect(pickLobsterEntrance(0.01)).toBe("balloon");
    expect(pickLobsterEntrance(0.06)).toBe("bubble");
    expect(pickLobsterEntrance(0.129)).toBe("bubble");
    expect(pickLobsterEntrance(0.13)).toBe("walk");
    expect(pickLobsterEntrance(0.9)).toBe("walk");
  });

  it("resolves rare elder identities deterministically", () => {
    const elder = identityOf(644);
    expect(elder).toMatchObject({ elder: true, look: { scale: 3, accessory: "barnacle" } });
    const elders = Array.from({ length: 3_000 }, (_, seed) => identityOf(seed)).filter(
      (identity) => identity.elder,
    ).length;
    expect(elders).toBeGreaterThan(0);
    expect(elders).toBeLessThan(3_000 * 0.035);
  });

  it("returns old friends only from palettes the dex knows", () => {
    expect(identityOf(191).oldFriend).toBe(false);
    rememberDex(friends);
    const friend = identityOf(191);
    expect(friend).toMatchObject({
      oldFriend: true,
      look: { palette: { id: "gold" } },
      friendName: "Goldenrod",
    });
    const goldenRetro = paletteById("goldenretro");
    const grail = resolveLobsterLoadIdentity(191, {
      ...createLobsterPetLook(191, neutralDate),
      palette: goldenRetro,
    });
    expect(grail).toMatchObject({ oldFriend: false, look: { palette: { id: "goldenretro" } } });
    expect(identityOf(42).oldFriend).toBe(false);
  });

  it("ignores stale removed palettes in dex counts and old-friend planning", () => {
    rememberDex({
      clawdia: { firstSeenAt: 1, name: "Clawdia", shinySeenAt: 2 },
      coral: { firstSeenAt: 1, name: "Faded" },
      teal: { firstSeenAt: 2, name: "Lagoon" },
    });
    const seen = getLobsterdex();
    expect(LOBSTER_PET_PALETTES.filter((palette) => seen.has(palette.id))).toHaveLength(0);
    const identity = identityOf(191);
    expect(identity.oldFriend).toBe(false);
    expect(identity.look.palette.id).not.toBe("clawdia");
    expect(getLobsterdexEntries().get("clawdia")).toEqual({
      firstSeenAt: 1,
      name: "Clawdia",
      shinySeenAt: 2,
    });
    expect(identity.look.palette.id).not.toBe("coral");
    expect(identity.look.palette.id).not.toBe("teal");
  });

  it("beaches bottles rarely, with fortunes and spots in range", () => {
    let bottles = 0;
    const total = 20_000;
    for (let seed = 0; seed < total; seed++) {
      const plan = planLobsterBottle(seed);
      if (!plan) {
        continue;
      }
      bottles++;
      expect(plan.atMs).toBeGreaterThanOrEqual(3500);
      expect(plan.atMs).toBeLessThanOrEqual(10_000);
      expect(plan.spotPct).toBeGreaterThanOrEqual(15);
      expect(plan.spotPct).toBeLessThanOrEqual(85);
      expect(LOBSTER_BOTTLE_FORTUNES[plan.fortuneIndex]).toBeTruthy();
    }
    expect(bottles).toBeGreaterThan(0);
    expect(bottles).toBeLessThan(total * 0.05);
  });
});

describe("rare lobster loads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(summer);
  });
  it.each([
    ["clawnstantine", "Clawnstantine"],
    ["clawiestardust", "Clawie Stardust"],
    ["taylorpinch", "Taylor Pinch"],
    ["clawtoodeetoo", "Clawtoo Deetoo"],
    ["leonardodepinchy", "Leonardo DaPinchy"],
    ["shellvis", "Shellvis"],
    ["alexandergrahamshell", "Alexander Graham Shell"],
  ] as const)("records a genuine %s arrival with its signature identity", async (id, name) => {
    let seed = 0;
    while (seed < 20_000 && createLobsterPetLook(seed, summer).palette.id !== id) {
      seed++;
    }
    expect(seed).toBeLessThan(20_000);
    const element = await visitingPet(seed, "offline");
    expect(spriteClasses(element)).toContain(`lobster-pet--palette-${id}`);
    expect(element.querySelector(`.lob-${id}`)).not.toBeNull();
    expect(getLobsterdexEntries().get(id)?.name).toBe(name);
    poke(element);
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
    expect(element.querySelector(`.lob-${id}`)).not.toBeNull();
  });

  it("hosts the Elder: barnacled, renamed, and never molting", async () => {
    const element = await visitingPet(644);
    expect(spriteClasses(element)).toContain("lobster-pet--elder");
    expect(element.querySelector(".lob-barnacles")).not.toBeNull();
    expect(element.querySelector(".lobster-pet")?.getAttribute("title")).toBe(
      "Methuselah · old as the tides",
    );
  });

  it("brings back an old friend from the Lobsterdex, balloon and all", async () => {
    rememberDex(friends);
    const element = await visitingPet(636);
    expect(spriteClasses(element)).toContain("lobster-pet--palette-gold");
    expect(element.querySelector(".lobster-pet")?.getAttribute("title")).toBe(
      "Goldenrod · an old friend",
    );
    expect(spriteClasses(element)).toContain("lobster-pet--enter-balloon");
    expect(element.querySelector(".lobster-pet__balloon")).not.toBeNull();
    await expectClassAfter(element, "act-wave", 5_000);
  });

  it("hatches shiny lobsters that sparkle and log in the Lobsterdex", async () => {
    const seed = 4_689;
    const shinyLook = createLobsterPetLook(seed, summer);
    const element = await visitingPet(seed);
    expect(spriteClasses(element)).toContain("lobster-pet--shiny");
    expect(spriteClasses(element)).toContain(`lobster-pet--palette-${shinyLook.palette.id}`);
    expect(element.querySelectorAll(".lobster-pet__sparkle").length).toBeGreaterThan(0);
    expect(element.querySelector(".lobster-pet")?.getAttribute("title")).toContain("✦");
    expect(getLobsterdexEntries().get(shinyLook.palette.id)?.shinySeenAt).not.toBeNull();
  });

  it("beaches a message in a bottle on its own clock, pet or no pet", async () => {
    const element = createPet(104);
    await element.updateComplete;

    // Seed 104 is a shy load: no pet ever, but the tide does not care.
    await expectPresenceAfter(element, true, 300_000, ".lobster-bottle");
    expect(spritePresent(element)).toBe(false);
    expect(element.querySelector(".lobster-bottle")?.getAttribute("title")).toBe(
      "a message in a bottle",
    );

    element
      .querySelector(".lobster-bottle")
      ?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await element.updateComplete;
    const opened = element.querySelector(".lobster-bottle");
    expect(opened?.className).toContain("lobster-bottle--open");
    expect(opened?.getAttribute("title")).toBe("a shell is just armor you outgrew");

    await expectPresenceAfter(element, false, 150_000, ".lobster-bottle");
  });

  it("lets the snail take its sweet time crossing the ledge", async () => {
    const element = createPet(37);
    await element.updateComplete;
    await expectPresenceAfter(element, true, 500_000, ".lobster-pet--snail");
    // A regular passer's 11s crossing would be long over; the snail abides.
    await tick(element, 60_000);
    expect(element.querySelector(".lobster-pet--snail")).not.toBeNull();
    await expectPresenceAfter(element, false, 40_000, ".lobster-pet--snail");
  });
});
