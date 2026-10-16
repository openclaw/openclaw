/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { ApplicationContext, ApplicationTheme } from "../../app/context.ts";
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
