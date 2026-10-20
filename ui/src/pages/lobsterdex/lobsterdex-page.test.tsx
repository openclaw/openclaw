/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { ApplicationContext, ApplicationTheme } from "../../app/context.ts";
import { getLobsterdexEntries, recordLobsterVisit } from "../../components/lobster-dex.ts";
import { i18n } from "../../i18n/index.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { LobsterdexPage } from "./lobsterdex-page.tsx";

beforeEach(() => i18n.setLocale("en"));

function theme(lobsterdex: boolean) {
  let branding = { ...resolveThemeBranding(undefined), lobsterdex };
  const listeners = new Set<() => void>();
  return {
    // SAFETY: Lobsterdex consumes only branding and its subscription from the theme owner.
    source: {
      get branding() {
        return branding;
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as ApplicationTheme,
    publish(visible: boolean) {
      branding = { ...branding, lobsterdex: visible };
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

it("follows the replacement theme's Lobsterdex availability", () => {
  const first = theme(true);
  const second = theme(false);
  const [current, setCurrent] = createSignal(first.source);
  const context = {
    get theme() {
      return current();
    },
    basePath: "",
    navigate: () => {},
  } as unknown as ApplicationContext;
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <LobsterdexPage />
    </ApplicationProvider>
  ));
  flush();
  expect(
    view.container.querySelector("openclaw-lobsterdex-page .lobsterdex-page__grid"),
  ).not.toBeNull();
  setCurrent(second.source);
  flush();
  expect(view.container.querySelector(".lobsterdex-page__grid")).toBeNull();
  first.publish(true);
  flush();
  expect(view.container.querySelector(".lobsterdex-page__grid")).toBeNull();
  second.publish(true);
  flush();
  expect(view.container.querySelector(".lobsterdex-page__grid")).not.toBeNull();
});

it.each(["shown", "hidden", "disposed"] as const)(
  "follows the initial card hash only once (%s)",
  async (mode) => {
    const previousUrl = location.href;
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    history.replaceState(null, "", "#lobsterdex-blue");
    const current = theme(mode !== "hidden");
    // SAFETY: This page reads only the theme, base path, and navigation from the application.
    const context = {
      theme: current.source,
      basePath: "",
      navigate: () => {},
    } as unknown as ApplicationContext;
    const view = mountSolid(() => (
      <ApplicationProvider value={context}>
        <LobsterdexPage />
      </ApplicationProvider>
    ));
    let mounted = true;
    try {
      await Promise.resolve();
      flush();
      if (mode === "hidden") {
        current.publish(true);
        flush();
      }
      const card = view.container.querySelector<HTMLElement>("#lobsterdex-blue")!;
      const scroll = vi.fn();
      card.scrollIntoView = scroll;
      expect(card.classList.contains("lobsterdex-page__card--highlight")).toBe(mode !== "hidden");
      vi.advanceTimersByTime(16);
      expect(scroll).not.toHaveBeenCalled();
      if (mode === "disposed") {
        view.unmount();
        mounted = false;
      }
      vi.advanceTimersByTime(16);
      expect(scroll).toHaveBeenCalledTimes(mode === "shown" ? 1 : 0);
      if (mode !== "shown") {
        return;
      }
      expect(scroll).toHaveBeenLastCalledWith({ block: "center" });
      card.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "other" }));
      expect(card.classList.contains("lobsterdex-page__card--highlight")).toBe(true);
      card.dispatchEvent(
        Object.assign(new Event("animationend"), { animationName: "lobsterdex-card-highlight" }),
      );
      expect(card.classList.contains("lobsterdex-page__card--highlight")).toBe(false);

      history.replaceState(null, "", "#lobsterdex-crimson");
      current.publish(false);
      flush();
      current.publish(true);
      flush();
      const nextCard = view.container.querySelector<HTMLElement>("#lobsterdex-crimson")!;
      nextCard.scrollIntoView = scroll;
      vi.advanceTimersByTime(32);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(nextCard.classList.contains("lobsterdex-page__card--highlight")).toBe(false);
    } finally {
      if (mounted) {
        view.unmount();
      }
      history.replaceState(null, "", previousUrl);
      vi.useRealTimers();
    }
  },
);

function mountLobsterdex() {
  // SAFETY: This page reads only the theme, base path, and navigation from the application.
  const context = {
    theme: theme(true).source,
    basePath: "",
    navigate: () => {},
  } as unknown as ApplicationContext;
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <LobsterdexPage />
    </ApplicationProvider>
  ));
  flush();
  return view;
}

describe("LobsterdexPage discovery", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.clear();
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-10T12:00:00.000Z").getTime());
    await i18n.setLocale("en");
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders discovered lore, first visit, hidden hints, and the count", () => {
    const firstSeenAt = new Date("2026-07-10T12:00:00.000Z").getTime();
    recordLobsterVisit("crimson", { name: "Ruby", shiny: true });
    const { container } = mountLobsterdex();

    expect(container.querySelector(".lobsterdex-page__count")?.textContent).toBe("1/49 visited");

    const seen = container.querySelector(".lobster-pet--palette-crimson")?.closest("article");
    expect(seen?.id).toBe("lobsterdex-crimson");
    expect(seen?.querySelector("h3")?.textContent).toBe("Ruby");
    expect(seen?.querySelector(".lobsterdex-page__lore")?.textContent).toBe(
      "The classic red, first in every tide pool.",
    );
    expect(seen?.querySelector(".lobsterdex-page__date")?.textContent).toContain(
      new Date(firstSeenAt).toLocaleDateString("en"),
    );
    expect(seen?.querySelectorAll(".lobsterdex-page__date")).toHaveLength(2);
    expect(seen?.querySelector(".lobsterdex-page__dates")?.textContent).toContain(
      `✦ Shiny spotted ${new Date(firstSeenAt).toLocaleDateString("en")}`,
    );
    expect(seen?.querySelector(".lobsterdex-page__star")).not.toBeNull();
    expect(seen?.querySelector('button[aria-label="Copy link"]')).not.toBeNull();

    const unseen = container.querySelector(".lobster-pet--palette-watermelon")?.closest("article");
    expect(unseen?.querySelector("h3")?.textContent).toBe("?");
    expect(unseen?.querySelector(".lobsterdex-page__lore")?.textContent).toBe("Ripe when thumped.");
    expect(unseen?.querySelector(".lobsterdex-page__date")).toBeNull();
  });

  it.each([
    [
      "clawnstantine",
      "Clawnstantine",
      "All tides lead here.",
      "Built an empire. Still rules from the ledge.",
    ],
    [
      "clawiestardust",
      "Clawie Stardust",
      "Something electric washed ashore.",
      "Changes shells. Never changes style.",
    ],
    [
      "taylorpinch",
      "Taylor Pinch",
      "Someone is shaking off the sand.",
      "Turns every tide into an era.",
    ],
    [
      "clawtoodeetoo",
      "Clawtoo Deetoo",
      "A resourceful little droid.",
      "Speaks fluent beep. Fixes things anyway.",
    ],
    [
      "leonardodepinchy",
      "Leonardo DaPinchy",
      "A little Renaissance is washing ashore.",
      "Every shell is a canvas.",
    ],
    ["shellvis", "Shellvis", "Someone brought blue suede claws.", "The king of rock and claw."],
    [
      "alexandergrahamshell",
      "Alexander Graham Shell",
      "A familiar ringing from the shore.",
      "Good ideas ring a bell.",
    ],
  ] as const)(
    "discovers %s by palette, not an existing visitor name, and retains shiny sightings",
    (id, name, hint, flavor) => {
      // Names are not palette identity. Remembered visitors must neither
      // reveal the new palette nor be renamed by it.
      recordLobsterVisit("crimson", { name });
      const { container } = mountLobsterdex();
      const card = () => container.querySelector(`#lobsterdex-${id}`);
      expect(card()?.querySelector("h3")?.textContent).toBe("?");
      expect(card()?.textContent).toContain(hint);

      recordLobsterVisit(id, { name, shiny: true });
      recordLobsterVisit(id, { name: "Impostor" });
      flush();
      expect(card()?.querySelector("h3")?.textContent).toBe(name);
      expect(getLobsterdexEntries().get("crimson")?.name).toBe(name);
      expect(card()?.textContent).toContain(flavor);
      expect(card()?.querySelector(`.lob-${id}`)).not.toBeNull();
      expect(card()?.querySelector(".lobsterdex-page__star")).not.toBeNull();
      expect(card()?.querySelectorAll("time")).toHaveLength(2);
      expect(card()?.classList.contains("lobsterdex-page__card--unseen")).toBe(false);
    },
  );
});
