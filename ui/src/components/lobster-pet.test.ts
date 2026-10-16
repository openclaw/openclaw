/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
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

function paletteSvg(
  id: string,
  options: Parameters<typeof renderLobsterSvg>[1] = {},
  accessory: "none" | "crown" = "none",
) {
  const palette = expectDefined(
    LOBSTER_PET_PALETTES.find((entry) => entry.id === id),
    id,
  );
  const container = document.createElement("div");
  container.replaceChildren(
    renderLobsterSvg(
      { ...canonicalLobsterLook(palette), accessory },
      { standalone: true, ...options },
    ),
  );
  return container;
}

function petClock() {
  vi.setSystemTime(new Date("2026-07-09T12:00:00"));
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
async function advancePetFrame(element: LobsterPetElement): Promise<void> {
  vi.advanceTimersToNextFrame();
  await element.updateComplete;
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
  let elapsed = 0;
  while (elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(200);
    elapsed += 200;
    await element.updateComplete;
    const match = /lobster-pet--act-([a-z]+)/.exec(spriteClasses(element));
    if (match) {
      return expectDefined(match[1], "lobster act name");
    }
  }
  return null;
}

async function startVigilOnlyRun(
  outcome: LobsterPetElement["runOutcome"],
): Promise<LobsterPetElement> {
  petClock();
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
  it("adds santa hats in December and pumpkins in late October", () => {
    const december = new Date("2026-12-10T12:00:00");
    const october = new Date("2026-10-25T12:00:00");
    const july = new Date("2026-07-15T12:00:00");
    const accessoriesOn = (date: Date) =>
      new Set(Array.from({ length: 400 }, (_, seed) => createLobsterPetLook(seed, date).accessory));
    const decemberSet = accessoriesOn(december);
    expect(decemberSet.has("santa")).toBe(true);
    expect(decemberSet.has("pumpkin")).toBe(false);
    const octoberSet = accessoriesOn(october);
    expect(octoberSet.has("pumpkin")).toBe(true);
    expect(octoberSet.has("santa")).toBe(false);
    const julySet = accessoriesOn(july);
    expect(julySet.has("santa")).toBe(false);
    expect(julySet.has("pumpkin")).toBe(false);
    expect(julySet.has("party")).toBe(false);
    expect(julySet.has("monocle")).toBe(false);
  });

  it("dresses fancy on National Lobster Day", () => {
    const lobsterDaySet = new Set(
      Array.from(
        { length: 400 },
        (_, seed) => createLobsterPetLook(seed, new Date("2026-09-25T12:00:00")).accessory,
      ),
    );
    expect(lobsterDaySet.has("monocle")).toBe(true);
    expect(lobsterDaySet.has("pumpkin")).toBe(false);
  });

  it("dresses everyone as the classic logo on the repo anniversary", () => {
    const anniversary = new Date("2026-11-24T12:00:00");
    for (let seed = 0; seed < 50; seed++) {
      const look = createLobsterPetLook(seed, anniversary);
      expect(look.palette.id).toBe("retro");
      expect(look.accessory).toBe("party");
    }
    // The day after is business as usual.
    const after = createLobsterPetLook(7, new Date("2026-11-25T12:00:00"));
    expect(after.accessory).not.toBe("party");
  });
});

describe("resolveLobsterPetMode", () => {
  it("maps connection and run state to modes", () => {
    expect(resolveLobsterPetMode(false, [{ hasActiveRun: true }])).toBe("offline");
    expect(resolveLobsterPetMode(true, null)).toBe("idle");
    expect(resolveLobsterPetMode(true, [{ hasActiveRun: false }, {}])).toBe("idle");
    expect(resolveLobsterPetMode(true, [{ hasActiveRun: false }, { hasActiveRun: true }])).toBe(
      "busy",
    );
  });

  it("stops looking busy after a registry-active run reaches a terminal status", () => {
    expect(resolveLobsterPetMode(true, [{ status: "done", hasActiveRun: true }])).toBe("idle");
    expect(resolveLobsterPetMode(true, [{ status: "running", hasActiveRun: true }])).toBe("busy");
  });
});

describe("resolveLobsterRunOutcome", () => {
  it("uses the most recently active terminal session", () => {
    expect(resolveLobsterRunOutcome(null)).toBe("ok");
    expect(
      resolveLobsterRunOutcome([
        { status: "done", lastActivityAt: 10 },
        { status: "failed", lastActivityAt: 20 },
      ]),
    ).toBe("error");
    expect(
      resolveLobsterRunOutcome([
        { status: "failed", lastActivityAt: 10 },
        { status: "done", lastActivityAt: 20 },
      ]),
    ).toBe("ok");
    expect(resolveLobsterRunOutcome([{ status: "running", lastActivityAt: 99 }])).toBe("ok");
    expect(resolveLobsterRunOutcome([{ status: "timeout", updatedAt: 5 }])).toBe("error");
    // A user abort is neither success nor failure.
    expect(resolveLobsterRunOutcome([{ status: "killed", endedAt: 50 }])).toBe("aborted");
    // endedAt outranks activity stamps that unrelated events keep touching.
    expect(
      resolveLobsterRunOutcome([
        { status: "failed", endedAt: 30, lastActivityAt: 10 },
        { status: "done", endedAt: 20, lastActivityAt: 40 },
      ]),
    ).toBe("error");
  });
});

describe("lobster pet element", () => {
  beforeEach(() => vi.useFakeTimers());
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

    const arrived = await advanceUntil(element, () => spritePresent(element), 12_000);
    expect(arrived).toBe(false);
  });

  it("departs after its stay and returns for a later visit", async () => {
    const element = await visitingPet(42);

    const departed = await advanceUntil(element, () => !spritePresent(element), 400_000);
    expect(departed).toBe(true);

    expect(await advanceUntil(element, () => spritePresent(element), 1_200_000)).toBe(false);
    const returned = await advanceUntil(element, () => spritePresent(element), 2_500_000);
    expect(returned).toBe(true);
  });

  it("startles when poked", async () => {
    const element = await visitingPet(42);

    poke(element);
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
  });

  it("schedules acts while perched", async () => {
    petClock();
    const element = await visitingPet(42);

    const act = await advanceUntilAct(element, 20_000);

    expect(act).not.toBeNull();
    expect(spriteClasses(element)).toContain(`lobster-pet--act-${act}`);
  });

  it("reacts to busy, idle, and offline mode changes", async () => {
    petClock();
    const element = await visitingPet(42);

    await updatePet(element, { mode: "busy" });
    expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
    expect(spriteClasses(element)).toContain("lobster-pet--busy");

    await updatePet(element, { runOutcome: "ok", mode: "idle" });
    expect(spriteClasses(element)).toContain("lobster-pet--act-cheer");

    const offline = createPet(7, "offline");
    await offline.updateComplete;
    await advancePetFrame(offline);
    expect(spritePresent(offline)).toBe(true);
    expect(spriteClasses(offline)).toContain("lobster-pet--offline");
  });

  it("renders deterministic molt and twin load variants", async () => {
    petClock();
    const molting = await visitingPet(2);
    expect(await advanceUntilAct(molting, 30_000)).toBe("molt");
    expect(
      await advanceUntil(
        molting,
        () => molting.querySelector(".lobster-pet--shell") !== null,
        30_000,
      ),
    ).toBe(true);

    const twins = await visitingPet(21);
    expect(twins.querySelectorAll(".lobster-pet:not(.lobster-pet--shell)")).toHaveLength(2);
    expect(twins.querySelector(".lobster-pet--twin")?.getAttribute("title")).toMatch(/ Jr\.$/);
  });

  it("records arrivals in the lobsterdex", async () => {
    petClock();
    vi.stubGlobal("localStorage", window.localStorage);
    await visitingPet(42);
    const look = createLobsterPetLook(42, new Date("2026-07-09T12:00:00"));
    expect(getLobsterdex().has(look.palette.id)).toBe(true);
    expect(getLobsterdexEntries().get(look.palette.id)?.name).toBeTruthy();
  });

  it("anchors the dismiss menu at the raw pointer position and preserves outside focus", async () => {
    const element = await visitingPet(42);
    const composer = element.parentElement!.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.focus();

    // Coordinates deliberately exceed a guessed 264x80 pre-clamp: a
    // reintroduced clamp would move the trigger away from these exact values.
    const clientX = 1200;
    const clientY = 850;
    element
      .querySelector(".lobster-pet")
      ?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY }),
      );
    await element.updateComplete;

    await settleDismissMenu(element);
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

    const gone = await advanceUntil(element, () => !spritePresent(element), 5_000);
    expect(gone).toBe(true);

    // Dismissal outlasts later scheduled visits and even offline summons.
    const revisited = await advanceUntil(element, () => spritePresent(element), 3_700_000);
    expect(revisited).toBe(false);
    await updatePet(element, { mode: "offline" });
    expect(spritePresent(element)).toBe(false);
  });

  it("persists permanent dismissal in browser storage", async () => {
    vi.stubGlobal("localStorage", window.localStorage);
    const element = await visitingPet(42);

    element
      .querySelector(".lobster-pet")
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await element.updateComplete;
    await settleDismissMenu(element);
    selectDismissal(element, "dismiss-permanently");
    await element.updateComplete;

    const persistedSettings = Array.from({ length: localStorage.length }, (_, index) => {
      const raw = localStorage.getItem(localStorage.key(index) ?? "");
      try {
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    });
    expect(persistedSettings).toContainEqual(expect.objectContaining({ lobsterPetVisits: false }));
    expect(await advanceUntil(element, () => !spritePresent(element), 5_000)).toBe(true);
  });

  it("never shows when visits are disabled, offline included", async () => {
    const element = createPet(42, "offline");
    await updatePet(element, { visitsEnabled: false });

    expect(spritePresent(element)).toBe(false);
    const appeared = await advanceUntil(element, () => spritePresent(element), 1_200_000);
    expect(appeared).toBe(false);
  });

  it("stops timers on disconnect", async () => {
    const element = await visitingPet(42);

    element.remove();
    await element.updateComplete;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gets grumpy after three fast pokes and recovers after a minute", async () => {
    petClock();
    const element = await visitingPet(42);

    for (let i = 0; i < 3; i++) {
      poke(element);
      await element.updateComplete;
    }
    expect(spriteClasses(element)).toContain("lobster-pet--grumpy");

    await tick(element, 61_000);
    expect(spriteClasses(element)).not.toContain("lobster-pet--grumpy");
  });

  it("leaves in a huff after ten pokes but returns for a later visit", async () => {
    petClock();
    const element = await visitingPet(42);

    for (let i = 0; i < 10; i++) {
      poke(element);
      await element.updateComplete;
    }
    const gone = await advanceUntil(element, () => !spritePresent(element), 5_000);
    expect(gone).toBe(true);

    const returned = await advanceUntil(element, () => spritePresent(element), 3_700_000);
    expect(returned).toBe(true);
  });

  it("old friends wave hello on their first arrival of the load", async () => {
    petClock();
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.lobsterpet.familiarity.v1",
      JSON.stringify({ visits: 30, shoos: 0 }),
    );
    const element = await visitingPet(42);

    // The greeting fires right after the entrance settles.
    await tick(element, 600);
    expect(spriteClasses(element)).toContain("lobster-pet--act-wave");
  });

  it("shooing is remembered in the familiarity counters", async () => {
    petClock();
    vi.stubGlobal("localStorage", window.localStorage);
    const element = await visitingPet(42);

    element
      .querySelector(".lobster-pet:not(.lobster-pet--shell)")
      ?.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true, bubbles: true }));
    await element.updateComplete;
    await settleDismissMenu(element);
    selectDismissal(element, "dismiss");
    await element.updateComplete;
    const raw = JSON.parse(
      localStorage.getItem("openclaw.control.lobsterpet.familiarity.v1") ?? "{}",
    );
    expect(raw.shoos).toBe(1);
  });

  it("cancels a pending pet when the pointer interaction is cancelled", async () => {
    petClock();
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
    petClock();
    const element = createPet(42, "busy");
    element.runOutcome = "error";
    await arrive(element);

    await updatePet(element, { mode: "idle" });
    expect(spriteClasses(element)).toContain("lobster-pet--act-droop");
    expect(spriteClasses(element)).not.toContain("lobster-pet--act-cheer");
  });

  it("keeps vigil during long runs and settles until the run ends", async () => {
    petClock();
    const element = await visitingPet(42, "busy");

    await tick(element, 600_500);
    expect(spriteClasses(element)).toContain("lobster-pet--vigil");

    // No fidgeting while keeping vigil.
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

      const reachedNextPhase = await advanceUntil(
        element,
        () =>
          spriteClasses(element).includes("lobster-pet--away") ||
          spriteClasses(element).includes("lobster-pet--act-sweep"),
        10_000,
        100,
      );
      expect(reachedNextPhase).toBe(true);
      if (outcome === "error") {
        expect(spriteClasses(element)).toContain("lobster-pet--act-sweep");
        expect(spriteClasses(element)).not.toContain("lobster-pet--away");
        expect(
          await advanceUntil(
            element,
            () => spriteClasses(element).includes("lobster-pet--away"),
            10_000,
            100,
          ),
        ).toBe(true);
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
    petClock();
    const element = await visitingPet(42);

    // jsdom rects are zero, so any positive clientX is to the sprite's right
    // and any negative clientX is to its left.
    await vi.advanceTimersByTimeAsync(200);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
    await element.updateComplete;
    expect(
      element.querySelector<HTMLElement>(".lobster-pet")?.style.getPropertyValue("--lob-face"),
    ).toBe("1");

    await vi.advanceTimersByTimeAsync(200);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: -400 }));
    await element.updateComplete;
    expect(
      element.querySelector<HTMLElement>(".lobster-pet")?.style.getPropertyValue("--lob-face"),
    ).toBe("-1");
  });

  it("travels light on first sighting and on same-version reloads", async () => {
    petClock();
    vi.stubGlobal("localStorage", window.localStorage);
    // First version ever seen: record a baseline, no bindle.
    const first = createPet(42);
    first.gatewayVersion = "2026.7.1";
    await arrive(first);
    expect(first.querySelector(".lob-bindle")).toBeNull();
    expect(localStorage.getItem("openclaw.control.lobsterpet.gatewayVersion.v1")).toBe("2026.7.1");
    first.remove();

    // Same version on the next load: still no bindle.
    const second = createPet(42);
    second.gatewayVersion = "2026.7.1";
    await arrive(second);
    expect(second.querySelector(".lob-bindle")).toBeNull();
  });

  it.each(["running", "suspended"] as const)(
    "keeps opt-in sounds and pet interaction usable with %s audio",
    async (audioState) => {
      vi.setSystemTime(new Date("2026-07-09T12:00:00"));
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
    petClock();
    vi.stubGlobal("localStorage", window.localStorage);
    const look = createLobsterPetLook(42, new Date("2026-07-09T12:00:00"));
    localStorage.setItem(
      "openclaw.control.lobsterdex.v1",
      JSON.stringify({
        [look.palette.id]: {
          firstSeenAt: new Date("2025-07-09T12:00:00").getTime(),
          name: "Original",
        },
      }),
    );
    const element = await visitingPet(42);

    expect(spriteClasses(element)).toContain("lobster-pet--party");
    // The memory itself stays immutable through the celebratory visit.
    expect(getLobsterdexEntries().get(look.palette.id)?.name).toBe("Original");
  });

  it("wears the sailor cap on lobster days, deferring to rolled headwear", async () => {
    // 2026-01-05 is a probed lobster day; seed 42 rolls the (face-worn)
    // eyepatch that day, so the cap fits.
    vi.setSystemTime(new Date("2026-01-05T12:00:00"));
    const element = await visitingPet(42);
    expect(element.querySelector(".lob-cap")).not.toBeNull();
    element.remove();

    // Ordinary days stay capless.
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const plain = await visitingPet(42);
    expect(plain.querySelector(".lob-cap")).toBeNull();
  });

  it("ships a hidden peek eye only in sleeping renders", () => {
    const container = document.createElement("div");
    const look = createLobsterPetLook(42, new Date("2026-07-09T12:00:00"));
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

    const actualContainer = paletteSvg("actual");
    expect(actualContainer.querySelector(".lob-actual")).not.toBeNull();
    expect(actualContainer.querySelector(".lob-standard-dome")).toBeNull();

    const balloonContainer = paletteSvg("balloon");
    expect(balloonContainer.querySelector(".lob-balloon-frame")).not.toBeNull();
    expect(balloonContainer.querySelector(".lob-standard-dome")).toBeNull();

    const asciiContainer = paletteSvg("ascii");
    expect(asciiContainer.querySelector(".lob-ascii")).not.toBeNull();
    expect(asciiContainer.querySelector(".lob-eye-open")?.textContent).toContain("(o)");
    expect(asciiContainer.querySelector(".lob-eye-closed")?.textContent).toContain("(-)");
    expect(asciiContainer.querySelector(".lob-standard-dome")).toBeNull();

    const portalContainer = paletteSvg("portal");
    expect(portalContainer.querySelectorAll(".lob-portal-ring")).toHaveLength(2);
    expect(portalContainer.querySelector(".lob-standard-dome")).toBeNull();
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
    // Tab switches re-enter through the visibilitychange resume path, which
    // must stay inert under reduced motion too. Mode flips must not startle.
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
    const neutralDate = new Date("2026-07-15T12:00:00");
    const identityOf = (seed: number) =>
      resolveLobsterLoadIdentity(seed, createLobsterPetLook(seed, neutralDate));
    const elder = identityOf(644);
    expect(elder.elder).toBe(true);
    expect(elder.look.scale).toBe(3);
    expect(elder.look.accessory).toBe("barnacle");
    let elders = 0;
    for (let seed = 0; seed < 3_000; seed++) {
      if (identityOf(seed).elder) {
        elders++;
      }
    }
    expect(elders).toBeGreaterThan(0);
    expect(elders).toBeLessThan(3_000 * 0.035);
  });

  it("returns old friends only from palettes the dex knows", () => {
    vi.stubGlobal("localStorage", window.localStorage);
    const neutralDate = new Date("2026-07-15T12:00:00");
    const identityOf = (seed: number) =>
      resolveLobsterLoadIdentity(seed, createLobsterPetLook(seed, neutralDate));
    // An empty dex has no friends to bring back, whatever the roll says.
    expect(identityOf(191).oldFriend).toBe(false);
    localStorage.setItem(
      "openclaw.control.lobsterdex.v1",
      JSON.stringify({
        gold: { firstSeenAt: 1, name: "Goldenrod" },
        // Sorts after "gold" (as retired tangerine did) so probe seed 191 keeps
        // picking index 0 = gold from the sorted candidate list.
        watermelon: { firstSeenAt: 2, name: "Pips" },
      }),
    );
    const friend = identityOf(191);
    expect(friend.oldFriend).toBe(true);
    expect(friend.look.palette.id).toBe("gold");
    expect(friend.friendName).toBe("Goldenrod");
    const goldenRetro = expectDefined(
      LOBSTER_PET_PALETTES.find((palette) => palette.id === "goldenretro"),
      "golden retro palette",
    );
    const grail = resolveLobsterLoadIdentity(191, {
      ...createLobsterPetLook(191, neutralDate),
      palette: goldenRetro,
    });
    expect(grail.oldFriend).toBe(false);
    expect(grail.look.palette.id).toBe("goldenretro");
    // A seed whose friend roll misses stays a fresh stranger.
    expect(identityOf(42).oldFriend).toBe(false);
  });

  it("ignores stale removed palettes in dex counts and old-friend planning", () => {
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.lobsterdex.v1",
      JSON.stringify({
        clawdia: { firstSeenAt: 1, name: "Clawdia", shinySeenAt: 2 },
        coral: { firstSeenAt: 1, name: "Faded" },
        teal: { firstSeenAt: 2, name: "Lagoon" },
        tangerine: { firstSeenAt: 3, name: "Marmalade" },
        calico: { firstSeenAt: 4, name: "Patches" },
        abyss: { firstSeenAt: 5, name: "Lantern" },
      }),
    );
    const seen = getLobsterdex();
    expect(LOBSTER_PET_PALETTES.filter((palette) => seen.has(palette.id))).toHaveLength(0);

    const neutralDate = new Date("2026-07-15T12:00:00");
    const identity = resolveLobsterLoadIdentity(191, createLobsterPetLook(191, neutralDate));
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
  beforeEach(() => vi.useFakeTimers());
  it.each([
    ["clawnstantine", "Clawnstantine"],
    ["clawiestardust", "Clawie Stardust"],
    ["taylorpinch", "Taylor Pinch"],
    ["clawtoodeetoo", "Clawtoo Deetoo"],
    ["leonardodepinchy", "Leonardo DaPinchy"],
    ["shellvis", "Shellvis"],
    ["alexandergrahamshell", "Alexander Graham Shell"],
  ] as const)("records a genuine %s arrival with its signature identity", async (id, name) => {
    const now = new Date("2026-07-09T12:00:00");
    vi.setSystemTime(now);
    vi.stubGlobal("localStorage", window.localStorage);
    let seed = 0;
    while (seed < 20_000 && createLobsterPetLook(seed, now).palette.id !== id) {
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

  // Probe seeds (deterministic per stream): 644 hosts the Elder; 636 rolls
  // an old-friend return plus a balloon entrance; 4689 hatches a shiny variant;
  // 104 is a shy load that beaches a bottle at ~194s; 37 is a shy load with
  // a snail crossing at ~407s.
  it("hosts the Elder: barnacled, renamed, and never molting", async () => {
    petClock();
    const element = await visitingPet(644);

    expect(spriteClasses(element)).toContain("lobster-pet--elder");
    expect(element.querySelector(".lob-barnacles")).not.toBeNull();
    expect(element.querySelector(".lobster-pet")?.getAttribute("title")).toBe(
      "Methuselah · old as the tides",
    );
  });

  it("brings back an old friend from the Lobsterdex, balloon and all", async () => {
    petClock();
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.lobsterdex.v1",
      JSON.stringify({
        gold: { firstSeenAt: 1, name: "Goldenrod" },
        // Sorts after "gold" so seed 636 picks gold from the sorted candidates.
        watermelon: { firstSeenAt: 2, name: "Pips" },
      }),
    );
    const element = await visitingPet(636);

    // The seeded look is repainted as the remembered gold visitor.
    expect(spriteClasses(element)).toContain("lobster-pet--palette-gold");
    expect(element.querySelector(".lobster-pet")?.getAttribute("title")).toBe(
      "Goldenrod · an old friend",
    );
    // This seed also floats in under a balloon...
    expect(spriteClasses(element)).toContain("lobster-pet--enter-balloon");
    expect(element.querySelector(".lobster-pet__balloon")).not.toBeNull();
    // ...and old friends greet even before the familiarity tier does.
    const waved = await advanceUntil(
      element,
      () => spriteClasses(element).includes("lobster-pet--act-wave"),
      5_000,
      100,
    );
    expect(waved).toBe(true);
  });

  it("hatches shiny lobsters that sparkle and log in the Lobsterdex", async () => {
    const neutralDate = new Date("2026-07-09T12:00:00");
    vi.setSystemTime(neutralDate);
    vi.stubGlobal("localStorage", window.localStorage);
    const seed = 4_689;
    const shinyLook = createLobsterPetLook(seed, neutralDate);
    expect(shinyLook.shiny).toBe(true);
    const element = await visitingPet(seed);

    expect(spriteClasses(element)).toContain("lobster-pet--shiny");
    expect(spriteClasses(element)).toContain(`lobster-pet--palette-${shinyLook.palette.id}`);
    expect(element.querySelectorAll(".lobster-pet__sparkle").length).toBeGreaterThan(0);
    expect(element.querySelector(".lobster-pet")?.getAttribute("title")).toContain("✦");
    expect(getLobsterdexEntries().get(shinyLook.palette.id)?.shinySeenAt).not.toBeNull();
  });

  it("beaches a message in a bottle on its own clock, pet or no pet", async () => {
    petClock();
    const element = createPet(104);
    await element.updateComplete;

    // Seed 104 is a shy load: no pet ever, but the tide does not care.
    const washedUp = await advanceUntil(
      element,
      () => element.querySelector(".lobster-bottle") !== null,
      300_000,
    );
    expect(washedUp).toBe(true);
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

    // Read fortunes drift back out with the tide.
    const ebbed = await advanceUntil(
      element,
      () => element.querySelector(".lobster-bottle") === null,
      150_000,
    );
    expect(ebbed).toBe(true);
  });

  it("lets the snail take its sweet time crossing the ledge", async () => {
    petClock();
    const element = createPet(37);
    await element.updateComplete;

    const appeared = await advanceUntil(
      element,
      () => element.querySelector(".lobster-pet--snail") !== null,
      500_000,
    );
    expect(appeared).toBe(true);
    // A regular passer's 11s crossing would be long over; the snail abides.
    await tick(element, 60_000);
    expect(element.querySelector(".lobster-pet--snail")).not.toBeNull();
    const gone = await advanceUntil(
      element,
      () => element.querySelector(".lobster-pet--snail") === null,
      40_000,
    );
    expect(gone).toBe(true);
  });
});
