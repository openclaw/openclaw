import { render } from "lit";
import { expect, it, vi } from "vitest";
import { renderHubTabs } from "./hub-tabs.ts";

it("keeps the selected hub tab visible after dock resizing and asynchronous counts", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "width: 330px; height: 100px; overflow: auto;";
  const content = container.appendChild(document.createElement("div"));
  content.style.cssText = "padding: 40px 0 160px;";
  const values = ["Overview", "Files", "Tools", "Skills", "Channels", "Automations", "Memory"];
  const draw = (withCounts: boolean) =>
    render(
      renderHubTabs({
        id: "agents",
        active: "Memory",
        tabs: values.map((value) => ({
          value,
          label: value,
          count: withCounts && value !== "Memory" ? 99 : null,
        })),
        ariaLabel: "Agent sections",
        panelId: "agent-panel",
        onSelect: () => undefined,
      }),
      content,
    );
  const selectedIsVisible = () => {
    const group = content.querySelector("wa-tab-group")!;
    const strip = group.getBoundingClientRect();
    const selected = content.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
    return selected.left >= strip.left - 1 && selected.right <= strip.right + 1;
  };
  try {
    draw(false);
    await expect.poll(selectedIsVisible).toBe(true);
    container.scrollTop = 80;
    container.style.width = "220px";
    await expect.poll(selectedIsVisible).toBe(true);
    draw(true);
    await expect.poll(selectedIsVisible).toBe(true);
    expect(container.scrollTop).toBe(80);
  } finally {
    render(null, content);
    container.remove();
  }
});

it("labels the shadow tablist and releases resize observations when a hub strip is removed", async () => {
  const targets = new Map<ResizeObserver, Set<Element>>();
  const NativeResizeObserver = ResizeObserver;
  vi.stubGlobal(
    "ResizeObserver",
    class extends NativeResizeObserver {
      override observe(target: Element, options?: ResizeObserverOptions) {
        const owned = targets.get(this) ?? new Set<Element>();
        owned.add(target);
        targets.set(this, owned);
        super.observe(target, options);
      }
      override unobserve(target: Element) {
        targets.get(this)?.delete(target);
        super.unobserve(target);
      }
      override disconnect() {
        targets.get(this)?.clear();
        super.disconnect();
      }
    },
  );
  const container = document.body.appendChild(document.createElement("div"));
  const observedCount = () => [...targets.values()].reduce((count, owned) => count + owned.size, 0);
  try {
    render(
      renderHubTabs({
        id: "disposable",
        active: "overview",
        tabs: [{ value: "overview", label: "Overview" }],
        ariaLabel: "Agent sections",
        panelId: "agent-panel",
        onSelect: () => undefined,
      }),
      container,
    );
    await expect.poll(observedCount).toBeGreaterThan(0);
    expect(
      container
        .querySelector("wa-tab-group")
        ?.shadowRoot?.querySelector('[role="tablist"]')
        ?.getAttribute("aria-label"),
    ).toBe("Agent sections");
    render(null, container);
    await expect.poll(observedCount).toBe(0);
  } finally {
    render(null, container);
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps arrow-key focus separate from manual hub activation", async () => {
  const { page, userEvent } = await import("vitest/browser");
  const container = document.body.appendChild(document.createElement("div"));
  container.style.width = "160px";
  let active = "overview";
  const draw = () =>
    render(
      renderHubTabs({
        id: "manual",
        active,
        tabs: ["overview", "automations", "memory"].map((value) => ({ value, label: value })),
        ariaLabel: "Agent sections",
        panelId: "agent-panel",
        onSelect: (value) => {
          active = value;
          draw();
        },
      }),
      container,
    );
  try {
    draw();
    const overview = page.getByRole("tab", { name: "overview", exact: true });
    await overview.click();
    await userEvent.keyboard("{End}");
    expect(active).toBe("overview");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => active).toBe("memory");
    await expect
      .poll(() => {
        const strip = container.getBoundingClientRect();
        const tab = container.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
        return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
      })
      .toBe(true);
    await overview.click();
    await expect.poll(() => active).toBe("overview");
  } finally {
    render(null, container);
    container.remove();
  }
});
