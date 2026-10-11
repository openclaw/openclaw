import { cleanup, getByRole, render as renderSolid } from "@solidjs/testing-library";
import { html, nothing, render, svg, type TemplateResult } from "lit";
import { createRenderEffect, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPanelEmptyState } from "./panel-empty-state.ts";
import {
  renderPanelLoadingSkeleton,
  type PanelLoadingSkeletonVariant,
} from "./panel-loading-skeleton.ts";

const owners: HTMLElement[] = [];
function mountLit(template: TemplateResult) {
  const owner = document.body.appendChild(document.createElement("div"));
  owners.push(owner);
  render(template, owner);
  return owner;
}

afterEach(async () => {
  cleanup();
  for (const owner of owners.splice(0)) {
    render(nothing, owner);
    owner.remove();
  }
  await Promise.resolve();
});

describe("panel presentation bridges", () => {
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
    "renders an accessible light-DOM %s placeholder for Lit callers",
    async (variant) => {
      const owner = mountLit(renderPanelLoadingSkeleton(variant, `Loading ${variant}`));
      const skeleton = owner.querySelector("openclaw-panel-loading-skeleton")!;
      await skeleton.updateComplete;
      expect(skeleton.shadowRoot).toBeNull();
      expect(owner.querySelectorAll("openclaw-panel-loading-skeleton")).toHaveLength(1);
      expect(skeleton.dataset.panelSkeleton).toBe(variant);
      expect(skeleton.getAttribute("aria-label")).toBe(`Loading ${variant}`);
      expect(skeleton.getAttribute("aria-busy")).toBe("true");
      expect(skeleton.querySelectorAll(".skeleton").length).toBeGreaterThan(3);
    },
  );

  it("updates Lit properties and compact/overlay attributes without replacing unchanged contents", async () => {
    const owner = mountLit(renderPanelLoadingSkeleton("browser", "Loading browser"));
    const skeleton = owner.querySelector("openclaw-panel-loading-skeleton")!;
    await skeleton.updateComplete;
    const viewport = skeleton.querySelector(".viewport");
    render(renderPanelLoadingSkeleton("browser", "Reconnecting", true, true), owner);
    await skeleton.updateComplete;
    expect(skeleton.querySelector(".viewport")).toBe(viewport);
    expect(skeleton.compact).toBe(true);
    expect(skeleton.overlay).toBe(true);
    expect(skeleton.hasAttribute("compact")).toBe(true);
    expect(skeleton.hasAttribute("overlay")).toBe(true);
    expect(skeleton.getAttribute("aria-label")).toBe("Reconnecting");
    render(renderPanelLoadingSkeleton("desktop", "Connecting"), owner);
    await skeleton.updateComplete;
    expect(skeleton.compact).toBe(false);
    expect(skeleton.overlay).toBe(false);
    expect(skeleton.querySelector(".skeleton")).toBeNull();
    expect(skeleton.querySelector(".desktop-loading")?.textContent).toContain("Connecting");
  });

  it("mounts one registered skeleton from Solid and synchronizes reactive properties", async () => {
    const [label, setLabel] = createSignal("Connecting");
    const [compact, setCompact] = createSignal(false);
    const view = renderSolid(() => {
      const host = document.createElement("openclaw-panel-loading-skeleton");
      host.variant = "desktop";
      createRenderEffect(
        () => ({ label: label(), compact: compact() }),
        (value) => {
          host.label = value.label;
          host.compact = value.compact;
        },
      );
      return host;
    });
    flush();
    const skeleton = view.container.querySelector("openclaw-panel-loading-skeleton")!;
    await skeleton.updateComplete;
    const spinner = skeleton.querySelector(".desktop-spinner");
    setLabel("Authenticating");
    setCompact(true);
    flush();
    await skeleton.updateComplete;
    expect(view.container.querySelectorAll("openclaw-panel-loading-skeleton")).toHaveLength(1);
    expect(skeleton.querySelector(".desktop-spinner")).toBe(spinner);
    expect(skeleton.getAttribute("aria-label")).toBe("Authenticating");
    expect(skeleton.compact).toBe(true);
    expect(skeleton.hasAttribute("compact")).toBe(true);
    expect(skeleton.querySelector(".desktop-loading")?.textContent).toContain("Authenticating");
  });

  it("retains Lit default/named content through replacement and reconnect without hiding actions", async () => {
    const action = vi.fn();
    const view = (label: string, path: string) =>
      renderPanelEmptyState({
        icon: svg`<svg viewBox="0 0 24 24"><path d=${path}></path></svg>`,
        heading: label,
        description: "Choose a file to continue.",
        action: html`<button type="button" @click=${action}>${label}</button>`,
      });
    const owner = mountLit(view("Add file", "M1 1h10"));
    const host = owner.querySelector("openclaw-panel-empty-state")!;
    await host.updateComplete;
    const content = host.querySelector(".empty-state");
    const icon = host.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(host.shadowRoot).toBeNull();
    const button = getByRole(host, "button", { name: "Add file" });
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
    button.click();
    render(view("Add another file", "M2 2v10"), owner);
    await host.updateComplete;
    expect(host.querySelector(".empty-state")).toBe(content);
    expect(host.querySelector("svg")).toBe(icon);
    expect(icon?.querySelector("path")?.getAttribute("d")).toBe("M2 2v10");
    expect(host.querySelector(".empty-state__title")?.textContent).toBe("Add another file");
    expect(getByRole(host, "button", { name: "Add another file" })).toBe(button);
    host.remove();
    await Promise.resolve();
    expect(icon?.hasAttribute("aria-hidden")).toBe(false);
    owner.append(host);
    await host.updateComplete;
    expect(owner.querySelectorAll("openclaw-panel-empty-state")).toHaveLength(1);
    expect(host.querySelectorAll(".empty-state")).toHaveLength(1);
    expect(host.querySelector("svg")).toBe(icon);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    getByRole(host, "button", { name: "Add another file" }).click();
    render(view("Choose again", "M3 3h9"), owner);
    await host.updateComplete;
    expect(host.querySelector("path")?.getAttribute("d")).toBe("M3 3h9");
    getByRole(host, "button", { name: "Choose again" }).click();
    expect(action).toHaveBeenCalledTimes(3);
  });

  it("mounts the registered empty state from Solid without a nested host", async () => {
    const [heading, setHeading] = createSignal("No files");
    const view = renderSolid(() => {
      const host = document.createElement("openclaw-panel-empty-state");
      host.description = "Choose a workspace.";
      host.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
      const action = document.createElement("span");
      action.slot = "action";
      const button = document.createElement("button");
      button.textContent = "Choose workspace";
      action.append(button);
      host.append(action);
      createRenderEffect(heading, (value) => {
        host.heading = value;
      });
      return host;
    });
    flush();
    const host = view.container.querySelector("openclaw-panel-empty-state")!;
    await host.updateComplete;
    const body = host.querySelector(".empty-state");
    setHeading("No matching files");
    flush();
    await host.updateComplete;
    expect(view.container.querySelectorAll("openclaw-panel-empty-state")).toHaveLength(1);
    expect(host.querySelectorAll(".empty-state")).toHaveLength(1);
    expect(host.querySelector(".empty-state")).toBe(body);
    expect(host.querySelector(".empty-state__title")?.textContent).toBe("No matching files");
    expect(getByRole(host, "button", { name: "Choose workspace" })).toBeTruthy();
  });
});
