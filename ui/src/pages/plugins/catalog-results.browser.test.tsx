import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import {
  renderPluginCatalogResults,
  renderPluginCatalogResults as PluginCatalogResults,
  type PluginCatalogResultsProps,
} from "./catalog-results.tsx";
import { renderArtTile } from "./consent-dialog.tsx";
import { renderPluginDetailShell } from "./detail-shell.tsx";
import type { PluginInstallProgress } from "./install-progress.ts";
import { renderPluginMcpServers } from "./overview.tsx";
import baseStyles from "../../styles/base.css?inline";
import componentStyles from "../../styles/components.css?inline";
import pluginStyles from "../../styles/plugins.css?inline";
import settingsStyles from "../../styles/settings.css?inline";

const views = new WeakMap<Element, { unmount: () => void }>();
function render(content: () => JSX.Element, container: HTMLDivElement) {
  views.get(container)?.unmount();
  const view = mountSolid(content, { container });
  views.set(container, view);
  flush();
}

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
  styles.textContent = [baseStyles, componentStyles, settingsStyles, pluginStyles].join("\n");
  document.head.append(styles);
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  cleanupSolid();
  container.remove();
  styles.remove();
});

function catalogProps(): PluginCatalogResultsProps {
  return {
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
    trending: [],
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
    onInstall: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
  };
}

it.each([263, 362])(
  "keeps long identity text clear of the action within a %ipx card",
  async (width) => {
    const onInstall = vi.fn();
    const props = { ...catalogProps(), onInstall };
    const progress = {
      startedAt: Date.now(),
      activities: [{ activityId: "dependencies", stage: "dependencies", status: "started" }],
    } satisfies PluginInstallProgress;
    for (const busy of [false, true]) {
      render(
        () =>
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

it.each([263, 362])("centers installed status dots in a %ipx card header", (width) => {
  for (const state of ["enabled", "disabled", "needs-setup", "error"] as const) {
    render(
      () =>
        renderPluginCatalogResults({
          ...catalogProps(),
          result: {
            items: [{ ...entry, local: { ...entry.local, installed: true, state } }],
          },
        }),
      container,
    );
    container.querySelector<HTMLElement>(".plugin-catalog-grid")!.style.gridTemplateColumns =
      `${width}px`;
    const card = container.querySelector<HTMLElement>(".plugin-catalog-card")!;
    const header = card
      .querySelector<HTMLElement>(".plugin-catalog-card__head")!
      .getBoundingClientRect();
    const dot = card.querySelector<HTMLElement>(".settings-status__dot")!.getBoundingClientRect();
    expect(dot.width).toBeGreaterThan(0);
    expect(Math.abs(dot.y + dot.height / 2 - (header.y + header.height / 2))).toBeLessThan(1);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  }
});

it.each([
  { width: 40, whiteBackground: false },
  { width: 80, whiteBackground: false },
  { width: 40, whiteBackground: true },
])(
  "fits a $width-pixel icon with official background=$whiteBackground and preserves settled artwork",
  async ({ width, whiteBackground }) => {
    const icon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="40"><rect width="100%" height="100%" fill="red"/></svg>`)}`;
    const currentSource = "https://example.com/current.svg";
    const failedSource = "https://example.com/failed.svg";
    const [iconUrls, setIconUrls] = createSignal<Record<string, string>>({
      [currentSource]: icon,
      [failedSource]: "data:image/svg+xml,not-an-svg",
    });
    const items = [
      { ...entry, id: "loaded-artwork", catalog: { ...entry.catalog, imageUrl: currentSource } },
      {
        ...entry,
        id: "failed-artwork",
        catalog: { ...entry.catalog, name: "Broken Artwork", imageUrl: failedSource },
      },
    ];
    render(
      () => (
        <>
          {whiteBackground ? (
            renderArtTile("official", "Official", { iconUrl: icon, whiteBackground })
          ) : (
            <>
              <span class="installed-plugins-card__art">
                {renderArtTile("demo", "Demo", { iconUrl: icon, whiteBackground })}
              </span>
              {renderPluginDetailShell({
                id: "demo",
                name: "Demo",
                backHref: "/plugins",
                backLabel: "Plugins",
                onBack: vi.fn(),
                identity: <></>,
                panel: <></>,
                icon: renderArtTile("demo", "Demo", { iconUrl: icon, whiteBackground }),
              })}
            </>
          )}
          <PluginCatalogResults {...catalogProps()} result={{ items }} iconUrls={iconUrls()} />
        </>
      ),
      container,
    );
    await Promise.all(
      [...container.querySelectorAll<HTMLImageElement>(".plugins-icon")]
        .filter((image) => image.getAttribute("src") === icon)
        .map(
          (image) =>
            new Promise<void>((resolve, reject) => {
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", reject, { once: true });
            }),
        ),
    );
    const loadedCard = container.querySelector('[data-plugin-id="loaded-artwork"]')!;
    const failedCard = container.querySelector('[data-plugin-id="failed-artwork"]')!;
    const loadedImage = loadedCard.querySelector<HTMLImageElement>(".plugins-icon")!;
    await expect.poll(() => failedCard.querySelector("img")).toBeNull();
    expect(loadedImage.hidden).toBe(false);
    expect(failedCard.querySelector(".plugins-tile--fallback")?.textContent?.trim()).toBe("BA");

    setIconUrls((current) => ({ ...current, "https://example.com/another.svg": icon }));
    flush();

    expect(loadedCard.querySelector(".plugins-icon")).toBe(loadedImage);
    expect(loadedImage.hidden).toBe(false);
    expect(loadedCard.querySelector(".skeleton")).toBeNull();
    expect(failedCard.querySelector("img")).toBeNull();
    expect(failedCard.querySelector(".plugins-tile--fallback")?.textContent?.trim()).toBe("BA");
    if (whiteBackground) {
      const image = container.querySelector<HTMLImageElement>(".plugins-icon")!;
      expect(image.parentElement!.classList.contains("plugins-tile--white")).toBe(true);
      expect(getComputedStyle(image.parentElement!).backgroundColor).toBe("rgb(255, 255, 255)");
      expect(getComputedStyle(image).padding).toBe("4px");
      return;
    }
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
  },
);

it("fills the remaining viewport with card-sized placeholders across resizes", async () => {
  render(() => renderPluginCatalogResults({ ...catalogProps(), loading: true }), container);
  const errors: string[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.message);
  window.addEventListener("error", onError);
  try {
    for (const { width, height } of [
      { width: 1847, height: 1344 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1366, height: 768 },
    ]) {
      await page.viewport(width, height);
      await expect
        .poll(() => {
          const grid = container.querySelector<HTMLElement>(".plugin-catalog-grid--skeleton")!;
          const cards = [...grid.children].map((card) => card.getBoundingClientRect());
          const cardHeight = cards[0]!.height;
          const row = cardHeight + Number.parseFloat(getComputedStyle(grid).rowGap);
          const bottom = cards.at(-1)!.bottom;
          return bottom >= height && bottom < height + row && cardHeight < 200;
        })
        .toBe(true);
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(errors).toEqual([]);
  } finally {
    window.removeEventListener("error", onError);
  }
});

it.each([390, 768, 1366, 1440])(
  "keeps the README close to expandable MCP servers beside a tall sidebar at %ipx",
  async (width) => {
    await page.viewport(width, 900);
    render(
      () =>
        renderPluginDetailShell({
          id: "mcp",
          name: "Workspace integrations",
          backHref: "/plugins",
          backLabel: "Plugins",
          onBack: vi.fn(),
          identity: undefined,
          panel: renderPluginMcpServers(
            ["workspace", "local"],
            [
              {
                name: "workspace",
                url: "https://mcp.example.com/" + "long-path/".repeat(35),
                transport: "streamable-http",
                auth: "oauth",
                scope: "documents.read documents.write",
                setup: "Connect your workspace in OpenClaw.",
              },
            ],
          ),
          sidebar: (
            <>
              <div style={{ "min-height": "900px" }}>Release and security metadata</div>
            </>
          ),
          readme: (
            <>
              <p>Use the workspace integration to read your documents.</p>
            </>
          ),
        }),
      container,
    );
    const readme = container.querySelector<HTMLElement>(".plugin-catalog-detail__readme-section")!;
    const capabilities = container.querySelector<HTMLElement>(".plugin-capabilities")!;
    const gap = () =>
      readme.getBoundingClientRect().top - capabilities.getBoundingClientRect().bottom;
    expect(gap()).toBeGreaterThanOrEqual(20);
    expect(gap()).toBeLessThanOrEqual(32);
    await expect
      .element(page.getByRole("heading", { name: /MCP Servers\s*2/, exact: true }))
      .toBeVisible();
    const server = page.getByText("workspace", { exact: true });
    await server.click();
    await expect.element(page.getByText("OAuth", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Connect your workspace in OpenClaw.")).toBeVisible();
    expect(gap()).toBeLessThanOrEqual(32);
    const authLabel = [...container.querySelectorAll("dt")].find(
      (label) => label.textContent === "Authentication",
    )!;
    expect(authLabel.getBoundingClientRect().height).toBeLessThanOrEqual(
      Number.parseFloat(getComputedStyle(authLabel).lineHeight) + 1,
    );
    expect(container.scrollWidth).toBeLessThanOrEqual(width);
    const summary = container.querySelector<HTMLElement>("summary")!;
    summary.focus();
    await userEvent.keyboard("{Enter}");
    expect(container.querySelector("details")?.open).toBe(false);
    await page.getByText("local", { exact: true }).click();
    await expect
      .element(
        page.getByText("Connection details are not included in this plugin’s catalog metadata."),
      )
      .toBeVisible();
  },
);
