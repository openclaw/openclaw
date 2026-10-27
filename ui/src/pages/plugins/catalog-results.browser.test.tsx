import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { baseProps, plugin } from "./catalog-results.test-support.ts";
import {
  renderPluginCatalogResults as PluginCatalogResults,
  type PluginCatalogResultsProps,
} from "./catalog-results.tsx";
import { PluginArtTile } from "./consent-dialog.tsx";
import { renderPluginDetailShell } from "./detail-shell.tsx";
import type { PluginInstallProgress } from "./install-progress.ts";
import { renderPluginContentCapabilities } from "./overview.tsx";
import baseStyles from "../../styles/base.css?inline";
import componentStyles from "../../styles/components.css?inline";
import pluginStyles from "../../styles/plugins.css?inline";
import settingsStyles from "../../styles/settings.css?inline";

const views = new WeakMap<Element, { unmount: () => void }>();
const find = (selector: string, root: ParentNode = container) =>
  root.querySelector<HTMLElement>(selector)!;
const detail = (props: Partial<Parameters<typeof renderPluginDetailShell>[0]>) =>
  renderPluginDetailShell({
    id: "demo",
    name: "Demo",
    backHref: "/plugins",
    backLabel: "Plugins",
    onBack: vi.fn(),
    identity: <></>,
    panel: <></>,
    ...props,
  });
function render(content: () => JSX.Element) {
  views.get(container)?.unmount();
  const view = mountSolid(content, { container });
  views.set(container, view);
  flush();
}

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

const entry = plugin("long-title", {
  catalog: {
    name: "TencentDB Agent Memory",
    author: "tencentdb-agent-memory",
    summary: "A long description with an unbroken identifier " + "identifier".repeat(20),
    categories: [],
  },
});
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
  return baseProps({
    result: { items: [entry] },
    categories: [],
    featured: [],
    trending: [],
    query: "memory",
    entryHref: () => "/plugins/long-title",
  });
}

async function renderCatalog(props: Partial<PluginCatalogResultsProps>) {
  render(() => PluginCatalogResults({ ...catalogProps(), ...props }));
  await nextFrame();
}

it.each([263, 362])(
  "keeps long identity text compact and clear of the action within a %ipx card",
  async (width) => {
    const onInstall = vi.fn();
    const progress = {
      startedAt: Date.now(),
      activities: [{ activityId: "dependencies", stage: "dependencies", status: "started" }],
    } satisfies PluginInstallProgress;
    for (const busy of [false, true]) {
      await renderCatalog({
        onInstall,
        busy: busy ? { "install:long-title": "install" } : {},
        installProgress: busy ? new Map([["install:long-title", progress]]) : undefined,
      });
      const grid = find(".plugin-catalog-grid");
      grid.style.gridTemplateColumns = `${width}px`;
      await nextFrame();
      const card = find(".plugin-catalog-card");
      const identity = find(".installed-plugins-card__identity", card);
      const action = card.querySelector("button")!;
      const title = find("h3", card).getBoundingClientRect();
      const button = action.getBoundingClientRect();
      expect(Math.abs(button.y + button.height / 2 - (title.y + title.height / 2))).toBeLessThan(1);
      const author = find(".plugin-card-author", card);
      const authorText = document.createRange();
      authorText.selectNodeContents(author);
      expect(authorText.getBoundingClientRect().top - title.bottom).toBeLessThanOrEqual(6);
      const bounds = identity.getBoundingClientRect();
      for (const text of identity.querySelectorAll<HTMLElement>("h3,.plugin-card-author")) {
        const right = text.getBoundingClientRect().right;
        expect(right).toBeLessThanOrEqual(bounds.right + 1);
        if (text.matches("h3")) {
          expect(right).toBeLessThan(action.getBoundingClientRect().left);
        }
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

it.each([263, 362])(
  "centers installed status dots on the title row in a %ipx card",
  async (width) => {
    await renderCatalog({
      result: {
        items: [{ ...entry, local: { ...entry.local, installed: true, state: "enabled" } }],
      },
    });
    find(".plugin-catalog-grid").style.gridTemplateColumns = `${width}px`;
    const card = find(".plugin-catalog-card");
    const header = find(".plugin-card-title-row", card).getBoundingClientRect();
    const dot = find(".settings-status__dot", card).getBoundingClientRect();
    expect(dot.width).toBeGreaterThan(0);
    expect(Math.abs(dot.y + dot.height / 2 - (header.y + header.height / 2))).toBeLessThan(1);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  },
);

it.each([
  [40, false],
  [80, false],
  [40, true],
] as const)(
  "fits a %i-pixel icon with official background=%s and preserves settled artwork",
  async (width, whiteBackground) => {
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
    const artwork = (slug = "demo", name = "Demo") => (
      <PluginArtTile slug={slug} name={name} iconUrl={icon} whiteBackground={whiteBackground} />
    );
    render(() => (
      <>
        {whiteBackground ? (
          artwork("official", "Official")
        ) : (
          <>
            <span class="installed-plugins-card__art">{artwork()}</span>
            {detail({ icon: artwork() })}
          </>
        )}
        <PluginCatalogResults {...catalogProps()} result={{ items }} iconUrls={iconUrls()} />
      </>
    ));
    await nextFrame();
    const images = [...container.querySelectorAll<HTMLImageElement>(".plugins-icon")].filter(
      (image) => image.getAttribute("src") === icon,
    );
    await expect
      .poll(() =>
        images.every((image) => image.complete && image.naturalWidth > 0 && !image.hidden),
      )
      .toBe(true);
    const loadedCard = find('[data-plugin-id="loaded-artwork"]');
    const failedCard = find('[data-plugin-id="failed-artwork"]');
    const loadedImage = loadedCard.querySelector<HTMLImageElement>(".plugins-icon")!;
    await expect.poll(() => failedCard.querySelector("img")).toBeNull();

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
      const frame = find(selector);
      const image = frame.querySelector("img")!;
      expect(image.naturalWidth).toBe(width);
      const frameBounds = frame.getBoundingClientRect();
      const imageBounds = image.getBoundingClientRect();
      expect(imageBounds).toMatchObject({ width: frameBounds.width, height: frameBounds.height });
      expect(getComputedStyle(image)).toMatchObject({ padding: "0px", objectFit: "contain" });
      expect(getComputedStyle(image.parentElement!).borderWidth).toBe("0px");
    }
  },
);

it("fills the remaining viewport with card-sized placeholders across resizes", async () => {
  await renderCatalog({
    reads: { browse: Promise.withResolvers<null>().promise, categories: null, more: null },
  });
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
          const grid = find(".plugin-catalog-grid--skeleton");
          const cards = [...grid.children].map((card) => card.getBoundingClientRect());
          const cardHeight = cards[0]!.height;
          const row = cardHeight + Number.parseFloat(getComputedStyle(grid).rowGap);
          const bottom = cards.at(-1)!.bottom;
          return bottom >= height && bottom < height + row && cardHeight < 200;
        })
        .toBe(true);
    }
    await nextFrame();
    expect(errors).toEqual([]);
  } finally {
    window.removeEventListener("error", onError);
  }
});

it.each([390, 768, 1366, 1440])(
  "keeps the README close to expandable MCP servers beside a tall sidebar at %ipx",
  async (width) => {
    await page.viewport(width, 900);
    render(() =>
      detail({
        id: "mcp",
        name: "Workspace integrations",
        identity: undefined,
        panel: renderPluginContentCapabilities({
          contracts: undefined,
          skills: [],
          tools: [],
          mcpServers: ["workspace", "local"],
          mcpServerDetails: [
            {
              name: "workspace",
              url: "https://mcp.example.com/" + "long-path/".repeat(35),
              transport: "streamable-http",
              auth: "oauth",
              scope: "documents.read documents.write",
              setup: "Connect your workspace in OpenClaw.",
            },
          ],
        }),
        sidebar: <div style={{ "min-height": "900px" }}>Release and security metadata</div>,
        readme: <p>Use the workspace integration to read your documents.</p>,
      }),
    );
    const readme = find(".plugin-catalog-detail__readme-section");
    const capabilities = find(".plugin-capabilities");
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
    const summary = find("summary");
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
