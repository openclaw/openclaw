import { getByRole } from "@solidjs/testing-library";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { PanelEmptyState } from "./solid/panel-empty-state.tsx";
import type { PanelLoadingSkeletonVariant } from "./solid/panel-loading-skeleton.tsx";
import { PanelLoadingSkeleton } from "./solid/panel-loading-skeleton.tsx";

const variants = [
  "board",
  "browser",
  "browser-viewport",
  "chat",
  "desktop",
  "discussion",
  "document",
  "file-list",
  "files",
  "review",
  "terminal",
] satisfies PanelLoadingSkeletonVariant[];

describe("panel presentations", () => {
  it.each(variants)("renders an accessible light-DOM %s placeholder", async (variant) => {
    const { container: owner } = mountSolid(PanelLoadingSkeleton, {
      variant,
      label: `Loading ${variant}`,
    });
    const skeleton = owner.querySelector<HTMLElement>("openclaw-panel-loading-skeleton")!;
    expect(skeleton.getAttribute("aria-label")).toBe(`Loading ${variant}`);
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(getByRole(owner, "status", { name: `Loading ${variant}` })).toBe(skeleton);
    expect(
      skeleton.querySelector(variant === "desktop" ? ".desktop-spinner" : ".skeleton"),
    ).not.toBeNull();
  });

  it.each(variants)("keeps concurrent %s placeholders independent and stable", (variant) => {
    const props = { variant, label: `Loading ${variant}` };
    const first = mountSolid(PanelLoadingSkeleton, props);
    const owner = document.body.appendChild(document.createElement("div"));
    onTestFinished(() => owner.remove());
    const second = mountSolid(PanelLoadingSkeleton, props, owner);
    const content = (view: typeof first) =>
      view.container.querySelector<HTMLElement>(".panel-loading-content")!;
    const original = content(first).firstElementChild;
    const sibling = content(second).firstElementChild;
    expect(original).not.toBeNull();
    expect(sibling).not.toBe(original);
    expect(content(first).innerHTML).toBe(content(second).innerHTML);
    if (variant === "board") {
      expect(
        [...content(first).querySelectorAll<HTMLElement>(".widget")].map((widget) => [
          widget.style.gridColumn,
          widget.style.gridRow,
        ]),
      ).toEqual([
        ["span 6", "span 4"],
        ["span 6", "span 4"],
        ["span 4", "span 3"],
        ["span 8", "span 3"],
      ]);
    }
    first.update({ ...props, label: "Reconnecting" });
    expect(content(first).firstElementChild).toBe(original);
    expect(content(second).firstElementChild).toBe(sibling);
    first.dispose();
    expect(sibling?.isConnected).toBe(true);
    expect(getByRole(second.container, "status", { name: props.label })).not.toBeNull();
  });

  it("updates compact/overlay attributes without replacing unchanged contents", async () => {
    const view = mountSolid<Parameters<typeof PanelLoadingSkeleton>[0]>(PanelLoadingSkeleton, {
      variant: "browser",
      label: "Loading browser",
      compact: false,
      overlay: false,
    });
    const skeleton = view.container.querySelector<HTMLElement>("openclaw-panel-loading-skeleton")!;
    const viewport = skeleton.querySelector(".viewport");
    view.update({ variant: "browser", label: "Reconnecting", compact: true, overlay: true });
    expect(skeleton.querySelector(".viewport")).toBe(viewport);
    expect(skeleton.hasAttribute("compact")).toBe(true);
    expect(skeleton.hasAttribute("overlay")).toBe(true);
    expect(skeleton.getAttribute("aria-label")).toBe("Reconnecting");
    view.update({ variant: "desktop", label: "Connecting", compact: false, overlay: false });
    expect(skeleton.hasAttribute("compact")).toBe(false);
    expect(skeleton.hasAttribute("overlay")).toBe(false);
    expect(skeleton.querySelector(".skeleton")).toBeNull();
    expect(skeleton.querySelector(".desktop-loading")?.textContent).toContain("Connecting");
    const spinner = skeleton.querySelector(".desktop-spinner");
    view.update({ variant: "desktop", label: "Authenticating", compact: true, overlay: false });
    expect(skeleton.querySelector(".desktop-spinner")).toBe(spinner);
    expect(skeleton.getAttribute("aria-label")).toBe("Authenticating");
    expect(skeleton.hasAttribute("compact")).toBe(true);
    expect(skeleton.querySelector(".desktop-loading")?.textContent).toContain("Authenticating");
  });

  it("retains icon and action content through updates and reconnect without hiding actions", () => {
    const action = vi.fn();
    const owner = document.body.appendChild(document.createElement("div"));
    onTestFinished(() => owner.remove());
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    icon.append(path);
    const button = document.createElement("button");
    button.addEventListener("click", action);
    const props = {
      heading: "Add file",
      description: "Choose a file to continue.",
      icon,
      action: button,
    };
    const view = mountSolid(PanelEmptyState, props, owner);
    const host = owner.querySelector<HTMLElement>("openclaw-panel-empty-state")!;
    const update = (label: string, data: string) => {
      view.update({ ...props, heading: label });
      button.textContent = label;
      path.setAttribute("d", data);
    };
    update("Add file", "M1 1h10");
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(getByRole(host, "button", { name: "Add file" })).toBe(button);
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
    button.click();
    update("Add another file", "M2 2v10");
    expect(host.querySelector("svg")).toBe(icon);
    expect(path.getAttribute("d")).toBe("M2 2v10");
    expect(host.querySelector(".empty-state__title")?.textContent).toBe("Add another file");
    expect(getByRole(host, "button", { name: "Add another file" })).toBe(button);
    owner.remove();
    document.body.append(owner);
    expect(host.querySelector("svg")).toBe(icon);
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
    getByRole(host, "button", { name: "Add another file" }).click();
    update("Choose again", "M3 3h9");
    expect(path.getAttribute("d")).toBe("M3 3h9");
    getByRole(host, "button", { name: "Choose again" }).click();
    expect(action).toHaveBeenCalledTimes(3);
    view.dispose();
  });
});
