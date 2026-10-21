import { cleanup, getByRole, render as renderSolid } from "@solidjs/testing-library";
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { PanelEmptyState } from "./solid/panel-empty-state.tsx";
import type { PanelLoadingSkeletonVariant } from "./solid/panel-loading-skeleton.tsx";
import { PanelLoadingSkeleton } from "./solid/panel-loading-skeleton.tsx";

const owners: HTMLElement[] = [];

afterEach(async () => {
  cleanup();
  for (const owner of owners.splice(0)) {
    owner.remove();
  }
  await Promise.resolve();
});

describe("panel presentations", () => {
  it.each([
    "board",
    "browser",
    "chat",
    "discussion",
    "document",
    "file-list",
    "files",
    "review",
    "terminal",
  ] satisfies PanelLoadingSkeletonVariant[])(
    "renders an accessible light-DOM %s placeholder",
    async (variant) => {
      const { container: owner } = mountSolid(PanelLoadingSkeleton, {
        variant,
        label: `Loading ${variant}`,
      });
      const skeleton = owner.querySelector<HTMLElement>("openclaw-panel-loading-skeleton")!;
      expect(skeleton.shadowRoot).toBeNull();
      expect(owner.querySelectorAll("openclaw-panel-loading-skeleton")).toHaveLength(1);
      expect(skeleton.dataset.panelSkeleton).toBe(variant);
      expect(skeleton.getAttribute("aria-label")).toBe(`Loading ${variant}`);
      expect(skeleton.getAttribute("aria-busy")).toBe("true");
      expect(skeleton.querySelectorAll(".skeleton").length).toBeGreaterThan(3);
    },
  );

  it("updates compact/overlay attributes without replacing unchanged contents", async () => {
    const view = mountSolid<Parameters<typeof PanelLoadingSkeleton>[0]>(PanelLoadingSkeleton, {
      variant: "browser",
      label: "Loading browser",
      compact: false,
      overlay: false,
    });
    const owner = view.container;
    const skeleton = owner.querySelector<HTMLElement>("openclaw-panel-loading-skeleton")!;
    const viewport = skeleton.querySelector(".viewport");
    view.update({ variant: "browser", label: "Reconnecting", compact: true, overlay: true });
    flush();
    expect(skeleton.querySelector(".viewport")).toBe(viewport);
    expect(skeleton.hasAttribute("compact")).toBe(true);
    expect(skeleton.hasAttribute("overlay")).toBe(true);
    expect(skeleton.getAttribute("aria-label")).toBe("Reconnecting");
    view.update({ variant: "desktop", label: "Connecting", compact: false, overlay: false });
    flush();
    expect(skeleton.hasAttribute("compact")).toBe(false);
    expect(skeleton.hasAttribute("overlay")).toBe(false);
    expect(skeleton.querySelector(".skeleton")).toBeNull();
    expect(skeleton.querySelector(".desktop-loading")?.textContent).toContain("Connecting");
  });

  it("mounts one direct Solid skeleton and synchronizes reactive properties", () => {
    const [label, setLabel] = createSignal("Connecting");
    const [compact, setCompact] = createSignal(false);
    const view = renderSolid(() =>
      createComponent(PanelLoadingSkeleton, {
        variant: "desktop",
        get label() {
          return label();
        },
        get compact() {
          return compact();
        },
      }),
    );
    flush();
    const skeleton = view.container.querySelector<HTMLElement>("openclaw-panel-loading-skeleton")!;
    const spinner = skeleton.querySelector(".desktop-spinner");
    setLabel("Authenticating");
    setCompact(true);
    flush();
    expect(view.container.querySelectorAll("openclaw-panel-loading-skeleton")).toHaveLength(1);
    expect(skeleton.querySelector(".desktop-spinner")).toBe(spinner);
    expect(skeleton.getAttribute("aria-label")).toBe("Authenticating");
    expect(skeleton.hasAttribute("compact")).toBe(true);
    expect(skeleton.querySelector(".desktop-loading")?.textContent).toContain("Authenticating");
  });

  it("retains icon and action content through updates and reconnect without hiding actions", () => {
    const action = vi.fn();
    const owner = document.body.appendChild(document.createElement("div"));
    owners.push(owner);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    icon.append(path);
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", action);
    const view = mountSolid(
      PanelEmptyState,
      {
        heading: "Add file",
        description: "Choose a file to continue.",
        icon,
        action: button,
      },
      owner,
    );
    const host = owner.querySelector<HTMLElement>("openclaw-panel-empty-state")!;
    const update = (label: string, data: string) => {
      view.update({
        heading: label,
        description: "Choose a file to continue.",
        icon,
        action: button,
      });
      button.textContent = label;
      path.setAttribute("d", data);
    };
    update("Add file", "M1 1h10");
    const content = host.querySelector(".empty-state");
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(host.shadowRoot).toBeNull();
    expect(getByRole(host, "button", { name: "Add file" })).toBe(button);
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
    button.click();
    update("Add another file", "M2 2v10");
    expect(host.querySelector(".empty-state")).toBe(content);
    expect(host.querySelector("svg")).toBe(icon);
    expect(path.getAttribute("d")).toBe("M2 2v10");
    expect(host.querySelector(".empty-state__title")?.textContent).toBe("Add another file");
    expect(getByRole(host, "button", { name: "Add another file" })).toBe(button);
    owner.remove();
    document.body.append(owner);
    expect(owner.querySelectorAll("openclaw-panel-empty-state")).toHaveLength(1);
    expect(host.querySelectorAll(".empty-state")).toHaveLength(1);
    expect(host.querySelector("svg")).toBe(icon);
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
    getByRole(host, "button", { name: "Add another file" }).click();
    update("Choose again", "M3 3h9");
    expect(path.getAttribute("d")).toBe("M3 3h9");
    getByRole(host, "button", { name: "Choose again" }).click();
    expect(action).toHaveBeenCalledTimes(3);
    view.dispose();
  });

  it("mounts the same empty-state implementation from Solid without a nested host", () => {
    const [heading, setHeading] = createSignal("No files");
    const view = renderSolid(() =>
      createComponent(PanelEmptyState, {
        get heading() {
          return heading();
        },
        description: "Choose a workspace.",
        get icon() {
          return document.createElementNS("http://www.w3.org/2000/svg", "svg");
        },
        get action() {
          const button = document.createElement("button");
          button.textContent = "Choose workspace";
          return button;
        },
      }),
    );
    flush();
    const host = view.container.querySelector<HTMLElement>("openclaw-panel-empty-state")!;
    const body = host.querySelector(".empty-state");
    setHeading("No matching files");
    flush();
    expect(view.container.querySelectorAll("openclaw-panel-empty-state")).toHaveLength(1);
    expect(host.querySelectorAll(".empty-state")).toHaveLength(1);
    expect(host.querySelector(".empty-state")).toBe(body);
    expect(host.querySelector(".empty-state__title")?.textContent).toBe("No matching files");
    expect(getByRole(host, "button", { name: "Choose workspace" })).toBeTruthy();
  });
});
