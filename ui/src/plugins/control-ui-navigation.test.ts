import { render, type LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiHost, ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { icons } from "../components/icons.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import "./control-ui-view.runtime.ts";

const originalLocation = window.location.href;
afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, "", originalLocation);
});

it("shows the active plugin section's ordered children and leaves pinned children standalone", async () => {
  const listeners = new Set<() => void>();
  const openPage = vi.fn();
  const host = {
    navigation: {
      openPage,
      pageHref: (page: ControlUiNavigationItem["page"]) =>
        page.id === "special"
          ? "/special"
          : `/boards${page.params ? `?${new URLSearchParams(page.params)}` : ""}`,
    },
  } as unknown as ControlUiHost;
  const registration = (
    value: ControlUiNavigationItem,
    pluginId = "example",
  ): ControlUiRegistration<ControlUiNavigationItem> => ({
    key: `${pluginId}/${value.id}`,
    pluginId,
    signal: new AbortController().signal,
    host,
    value,
  });
  const entries = [
    registration({ id: "boards", label: "Boards", icon: "layers", page: { id: "boards" } }),
    registration({
      id: "zulu",
      parent: "boards",
      label: "Zulu",
      order: 2,
      page: { id: "boards", params: { board: "zulu" } },
    }),
    registration({
      id: "beta",
      parent: "boards",
      label: "Beta",
      order: 1,
      icon: "toString",
      page: { id: "special" },
    }),
    registration({
      id: "alpha",
      parent: "boards",
      label: "Alpha",
      order: 1,
      icon: "activity",
      page: { id: "boards", params: { board: "alpha" } },
    }),
    registration(
      { id: "foreign", parent: "boards", label: "Other plugin", page: { id: "boards" } },
      "other",
    ),
  ];
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const provider = createApplicationContextProvider({
    plugins: { registrations: () => entries, subscribe },
    router: { subscribe },
  } as unknown as ApplicationContext);
  const contribution = (key: string) =>
    Object.assign(document.createElement("openclaw-plugin-contributions") as LitElement, {
      kind: "navigation",
      navigationKey: key,
    });
  const parent = contribution("example/boards");
  const pinned = contribution("example/alpha");
  provider.append(parent, pinned);
  window.history.replaceState(null, "", "/boards?board=alpha&filter=mine");
  document.body.append(provider);
  await parent.updateComplete;
  await pinned.updateComplete;

  const children = [...parent.querySelectorAll<HTMLAnchorElement>(".nav-item--child")];
  expect(children.map((child) => child.textContent?.trim())).toEqual(["Alpha", "Beta", "Zulu"]);
  expect(children.map((child) => child.getAttribute("aria-current"))).toEqual(["page", null, null]);
  const icon = document.createElement("div");
  render(icons.activity, icon);
  expect(children[0]?.querySelector("svg")?.outerHTML).toBe(icon.querySelector("svg")?.outerHTML);
  expect(children[1]?.querySelector("svg")?.outerHTML).toBe(
    parent.querySelector(".nav-item__icon svg")?.outerHTML,
  );
  expect(pinned.querySelectorAll("a")).toHaveLength(1);
  expect(pinned.querySelector(".nav-item--child")).toBeNull();
  expect(pinned.querySelector("a")?.getAttribute("aria-current")).toBe("page");
  children[1]!.click();
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ id: "special" });

  for (const [location, activeChild, childCount] of [
    ["/special?filter=mine", "Beta", 3],
    ["/boards", undefined, 3],
    ["/elsewhere", undefined, 0],
  ] as const) {
    window.history.replaceState(null, "", location);
    for (const listener of listeners) {
      listener();
    }
    await parent.updateComplete;
    await pinned.updateComplete;
    expect(parent.querySelectorAll(".nav-item--child")).toHaveLength(childCount);
    expect(parent.querySelector('.nav-item--child[aria-current="page"]')?.textContent?.trim()).toBe(
      activeChild,
    );
  }
});
