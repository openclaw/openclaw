import { html, nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import { renderPluginCatalogResults, type PluginCatalogResultsProps } from "./catalog-results.ts";
import { renderArtTile } from "./consent-dialog.ts";
import { renderPluginDetailShell } from "./detail-shell.ts";
import type { PluginInstallProgress } from "./install-progress.ts";
import baseStyles from "../../styles/base.css?inline";
import componentStyles from "../../styles/components.css?inline";
import pluginStyles from "../../styles/plugins.css?inline";

const entry = {
  id: "long-title",
  catalog: {
    name: "TencentDB Agent Memory",
    author: "tencentdb-agent-memory",
    summary: "A long description with an unbroken identifier " + "identifier".repeat(20),
    official: true,
    categories: [],
  },
  local: {
    present: false,
    installed: false,
    enabled: false,
    state: "not-installed",
    action: "install",
  },
} satisfies PluginDiscoveryEntry;
let container: HTMLDivElement;
let styles: HTMLStyleElement;
beforeEach(async () => {
  await page.viewport(1440, 900);
  styles = document.createElement("style");
  styles.textContent = [baseStyles, componentStyles, pluginStyles].join("\n");
  document.head.append(styles);
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  render(nothing, container);
  container.remove();
  styles.remove();
});

it.each([263, 362])(
  "keeps long identity text clear of the action within a %ipx card",
  async (width) => {
    const onInstall = vi.fn();
    const props: PluginCatalogResultsProps = {
      connected: true,
      loading: false,
      result: { items: [entry] },
      error: null,
      remoteError: null,
      categories: [],
      categoriesLoading: false,
      categoriesError: null,
      onRetryCategories: vi.fn(),
      featured: [],
      featuredLoading: false,
      trending: [],
      trendingLoading: false,
      loadingMore: false,
      loadMoreError: null,
      intent: "all",
      category: null,
      query: "memory",
      iconUrls: {},
      pluginIconUrls: {},
      canInstall: true,
      entryHref: () => "/plugins/long-title",
      onIntentChange: vi.fn(),
      onCategoryChange: vi.fn(),
      onQueryChange: vi.fn(),
      onOpenEntry: vi.fn(),
      onInstall,
      onLoadMore: vi.fn(),
      onRetry: vi.fn(),
    };
    const progress = {
      startedAt: Date.now(),
      activities: [{ activityId: "dependencies", stage: "dependencies", status: "started" }],
    } satisfies PluginInstallProgress;
    for (const busy of [false, true]) {
      render(
        renderPluginCatalogResults({
          ...props,
          busy: busy ? { "install:long-title": "install" } : {},
          installProgress: busy ? new Map([["install:long-title", progress]]) : undefined,
        }),
        container,
      );
      const grid = container.querySelector<HTMLElement>(".plugin-catalog-grid")!;
      grid.style.gridTemplateColumns = `${width}px`;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const card = container.querySelector<HTMLElement>(".plugin-catalog-card")!;
      const identity = card.querySelector<HTMLElement>(".installed-plugins-card__identity")!;
      const action = card.querySelector<HTMLButtonElement>("button")!;
      const bounds = identity.getBoundingClientRect();
      for (const text of identity.querySelectorAll<HTMLElement>("h3,.plugin-card-author")) {
        expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right + 1);
        expect(text.getBoundingClientRect().right).toBeLessThan(
          action.getBoundingClientRect().left,
        );
      }
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      expect(action.disabled).toBe(false);
      if (busy) {
        const spinner = action.querySelector<HTMLElement>(".btn__spinner");
        expect(spinner).not.toBeNull();
        expect(getComputedStyle(spinner!).animationName).toBe("btn-spinner-spin");
        expect(action.getAttribute("aria-busy")).toBe("true");
      }
      action.click();
      if (busy) {
        await expect.poll(() => action.getAttribute("aria-expanded")).toBe("true");
        expect(card.querySelector('[role="status"]')?.textContent).toContain(
          "Installing plugin dependencies",
        );
      }
    }
    expect(onInstall).toHaveBeenCalledOnce();
  },
);

it.each([40, 80])("fills icon tiles without cropping a %ipx-wide source", async (width) => {
  const icon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="40"><rect width="100%" height="100%" fill="red"/></svg>`)}`;
  render(
    html`
      <span class="installed-plugins-card__art"
        >${renderArtTile("demo", "Demo", { iconUrl: icon })}</span
      >
      ${renderPluginDetailShell({
        id: "demo",
        name: "Demo",
        backHref: "/plugins",
        backLabel: "Plugins",
        onBack: vi.fn(),
        identity: html``,
        panel: html``,
        icon: renderArtTile("demo", "Demo", { iconUrl: icon }),
      })}
    `,
    container,
  );
  await Promise.all(
    [...container.querySelectorAll<HTMLImageElement>(".plugins-icon")].map(
      (image) =>
        new Promise<void>((resolve, reject) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", reject, { once: true });
        }),
    ),
  );
  for (const selector of [".installed-plugins-card__art", ".plugin-catalog-detail__icon"]) {
    const frame = container.querySelector<HTMLElement>(selector)!;
    const image = frame.querySelector<HTMLImageElement>("img")!;
    expect(image.naturalWidth).toBe(width);
    const frameBounds = frame.getBoundingClientRect();
    const imageBounds = image.getBoundingClientRect();
    expect(imageBounds.width).toBe(frameBounds.width);
    expect(imageBounds.height).toBe(frameBounds.height);
    expect(getComputedStyle(image).padding).toBe("0px");
    expect(getComputedStyle(image).objectFit).toBe("contain");
    expect(getComputedStyle(image.parentElement!).borderWidth).toBe("0px");
  }
});

it("renders the official icon background as opaque white", async () => {
  const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="15" fill="blue"/></svg>')}`;
  render(
    renderArtTile("official", "Official", { iconUrl: icon, whiteBackground: true }),
    container,
  );
  const image = container.querySelector<HTMLImageElement>(".plugins-icon")!;
  await new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", reject, { once: true });
  });

  const tile = image.parentElement!;
  expect(tile.classList.contains("plugins-tile--white")).toBe(true);
  expect(getComputedStyle(tile).backgroundColor).toBe("rgb(255, 255, 255)");
  expect(getComputedStyle(image).padding).toBe("4px");
});
