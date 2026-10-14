/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { beforeEach, expect, it } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { ApplicationContext, ApplicationTheme } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { LobsterdexPage } from "./lobsterdex-page.tsx";

beforeEach(() => i18n.setLocale("en"));

it("follows the replacement theme's Lobsterdex availability", () => {
  function theme(lobsterdex: boolean) {
    let branding = { ...resolveThemeBranding(undefined), lobsterdex };
    const listeners = new Set<() => void>();
    return {
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
