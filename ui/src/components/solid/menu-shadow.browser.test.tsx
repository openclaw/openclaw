import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { phase } from "../../test-helpers/solid-menu.tsx";
import { Menu } from "./menu.tsx";
import "../../styles/base.css";

afterEach(cleanup);

it.each(["open", "closed"] as const)("navigates menus inside a %s shadow root", async (mode) => {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode });
  const replacementHost = document.createElement("section");
  const replacementRoot = replacementHost.attachShadow({ mode });
  const container = document.createElement("div");
  root.append(container);
  document.body.append(host, replacementHost);
  const view = render(
    () => (
      <Menu
        id="shadow-menu"
        label="Actions"
        items={[
          { id: "group", label: "Group", children: [{ id: "child", label: "Child" }] },
          { id: "archive", label: "Archive" },
        ]}
      />
    ),
    { container },
  );
  flush();
  const trigger = root.getElementById("shadow-menu:trigger") as HTMLButtonElement;
  const surface = root.getElementById("shadow-menu:content")!;
  const group = root.getElementById("shadow-menu-group:trigger")!;
  const child = root.getElementById("shadow-menu-group:child")!;
  const archive = root.getElementById("shadow-menu:archive")!;
  try {
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    await phase(surface, "open");
    expect(getComputedStyle(surface).position).toBe("fixed");
    expect(getComputedStyle(surface).display).toBe("flex");
    expect(surface.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(surface.getBoundingClientRect().height).toBeGreaterThan(0);
    await userEvent.keyboard("{End}");
    await expect.poll(() => root.activeElement).toBe(archive);
    await userEvent.keyboard("{Home}{ArrowRight}");
    await phase(root.getElementById("shadow-menu-group:content")!, "open");
    await expect.poll(() => root.activeElement).toBe(child);
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => root.activeElement).toBe(group);
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => root.activeElement).toBe(archive);
    replacementRoot.append(container);
    await Promise.resolve();
    expect(root.querySelector("[data-openclaw-overlay-style]")).toBeNull();
    expect(replacementRoot.querySelectorAll("[data-openclaw-overlay-style]")).toHaveLength(1);
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    await phase(surface, "open");
    expect(getComputedStyle(surface).position).toBe("fixed");
    expect(surface.getBoundingClientRect().width).toBeGreaterThan(0);
    view.unmount();
    expect(replacementRoot.querySelector("[data-openclaw-overlay-style]")).toBeNull();
  } finally {
    view.unmount();
    host.remove();
    replacementHost.remove();
  }
});
