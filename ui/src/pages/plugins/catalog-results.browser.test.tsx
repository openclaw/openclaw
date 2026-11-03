import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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
import carapaceStyles from "../../styles/carapace-control-ui.css?inline";
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
  styles.textContent = [
    baseStyles,
    componentStyles,
    settingsStyles,
    carapaceStyles,
    pluginStyles,
  ].join("\n");
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

it("windows large catalogs without losing keyboard traversal, reordered cards, or resized rows", async () => {
  container.className = "content";
  Object.assign(container.style, { height: "500px", width: "1100px", overflow: "auto" });
  const entries = Array.from({ length: 1_000 }, (_, index) =>
    plugin(`window-${String(index).padStart(4, "0")}`),
  );
  const [items, setItems] = createSignal(entries);
  const [messages, setMessages] = createSignal<PluginCatalogResultsProps["messages"]>({});
  const [progress, setProgress] = createSignal<PluginCatalogResultsProps["installProgress"]>();
  render(() => (
    <PluginCatalogResults
      {...catalogProps()}
      query=""
      category="tools"
      result={{ items: items() }}
      messages={messages()}
      installProgress={progress()}
    />
  ));
  const card = (index: number) =>
    find(`[data-plugin-id="window-${String(index).padStart(4, "0")}"]`);
  const cards = () => [...container.querySelectorAll<HTMLElement>(".plugin-catalog-card")];
  await waitForSolid(() => {
    expect(cards().length).toBeLessThan(100);
    expect(cards().length).toBeGreaterThan(4);
    expect(container.scrollHeight).toBeGreaterThan(10_000);
  });
  await nextFrame();
  const boundary = Math.max(
    ...cards()
      .map((node) => Number(node.dataset.pluginId!.slice(-4)))
      .filter((index) => index < 100),
  );
  const focused = card(boundary).querySelector<HTMLAnchorElement>(".plugin-card-author")!;
  focused.focus();
  flush();
  expect(card(boundary + 1)).not.toBeNull();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(
    card(boundary + 1).querySelector(".plugin-catalog-card__primary-link"),
  );
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(focused);
  const retainedCard = card(boundary);
  setItems([plugin("ranked-first"), ...entries]);
  await waitForSolid(() => {
    expect(card(boundary)).toBe(retainedCard);
    expect(document.activeElement).toBe(focused);
    expect(retainedCard.parentElement!.getAttribute("aria-posinset")).toBe(String(boundary + 2));
    expect(retainedCard.parentElement!.getAttribute("aria-setsize")).toBe("1001");
  });
  setItems([entries[0]!, plugin("ranked-first"), ...entries.slice(1)]);
  await waitForSolid(() => {
    expect(card(0).parentElement!.getAttribute("aria-posinset")).toBe("1");
    expect(card(boundary)).toBe(retainedCard);
    expect(document.activeElement).toBe(focused);
  });

  const moved = entries.toSpliced(boundary, 1);
  moved.splice(500, 0, entries[boundary]!);
  setItems(moved);
  flush();
  expect(card(boundary)).toBe(retainedCard);
  expect(focused.isConnected).toBe(true);
  await nextFrame();
  expect(retainedCard.parentElement!.getAttribute("aria-posinset")).toBe("501");
  setItems(entries);
  await nextFrame();
  expect(card(boundary)).toBe(retainedCard);
  // Native keyed moves also blur on the unwindowed catalog; preserve the node
  // without adding a separate focus-restoration policy to the windowing owner.
  focused.focus();
  expect(document.activeElement).toBe(focused);

  container.scrollTop = 0;
  await nextFrame();
  setProgress(
    new Map<string, PluginInstallProgress>([
      [
        "install:window-0000",
        {
          startedAt: Date.now(),
          activities: [{ activityId: "dependencies", stage: "dependencies", status: "started" }],
        },
      ],
    ]),
  );
  await nextFrame();
  const installAction = card(0).querySelector<HTMLButtonElement>("button")!;
  installAction.click();
  await waitForSolid(() => {
    const popup = find(".plugin-install-action__popup", card(0));
    expect(popup.matches(":popover-open")).toBe(true);
    const bounds = popup.getBoundingClientRect();
    const anchor = installAction.getBoundingClientRect();
    expect(Math.abs(bounds.left - anchor.left)).toBeLessThan(2);
    expect(bounds.top).toBeGreaterThanOrEqual(anchor.bottom);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  });
  setProgress(undefined);
  await nextFrame();
  setMessages({
    "install:window-0000": { kind: "error", text: "Visible error details. ".repeat(30) },
  });
  await waitForSolid(() => {
    const tall = card(0).getBoundingClientRect();
    const nextRow = card(4).getBoundingClientRect();
    expect(tall.height).toBeGreaterThan(150);
    expect(Math.abs(tall.height - card(1).getBoundingClientRect().height)).toBeLessThan(1);
    expect(nextRow.top).toBeGreaterThanOrEqual(tall.bottom);
  });
  const expandedHeight = card(0).getBoundingClientRect().height;
  setMessages({});
  await waitForSolid(() => {
    expect(card(0).getBoundingClientRect().height).toBeLessThan(expandedHeight);
    expect(card(4).getBoundingClientRect().top).toBeGreaterThanOrEqual(
      card(0).getBoundingClientRect().bottom,
    );
  });
  const rootStyle = document.documentElement.style;
  const previousSpacing = rootStyle.getPropertyValue("--space-3");
  const compactHeight = card(0).getBoundingClientRect().height;
  try {
    rootStyle.setProperty("--space-3", "32px");
    await waitForSolid(() => {
      const first = card(0).getBoundingClientRect();
      const next = card(4).getBoundingClientRect();
      expect(first.height).toBeGreaterThan(compactHeight + 30);
      expect(Math.abs(next.top - first.bottom - 32)).toBeLessThan(1);
    });
  } finally {
    if (previousSpacing) {
      rootStyle.setProperty("--space-3", previousSpacing);
    } else {
      rootStyle.removeProperty("--space-3");
    }
  }
  container.style.width = "360px";
  await page.viewport(390, 844);
  await waitForSolid(() => {
    expect(card(1).getBoundingClientRect().top).toBeGreaterThanOrEqual(
      card(0).getBoundingClientRect().bottom,
    );
    expect(cards().length).toBeLessThan(100);
  });
  card(999).querySelector<HTMLAnchorElement>(".plugin-catalog-card__primary-link")!.focus();
  await nextFrame();
  const bounds = card(999).getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  expect(bounds.top).toBeLessThan(viewport.bottom);
  expect(bounds.bottom).toBeGreaterThan(viewport.top);
});

it("retains focused cards when crossing the catalog windowing threshold in both directions", async () => {
  container.className = "content";
  Object.assign(container.style, { height: "500px", width: "1100px", overflow: "auto" });
  const entries = Array.from({ length: 61 }, (_, index) => plugin(`threshold-${index}`));
  const [items, setItems] = createSignal(entries.slice(0, 60));
  render(() => (
    <PluginCatalogResults
      {...catalogProps()}
      query=""
      category="tools"
      result={{ items: items() }}
    />
  ));
  const cards = () => container.querySelectorAll(".plugin-catalog-card");
  await waitForSolid(() => expect(cards()).toHaveLength(60));
  await nextFrame();
  const middle = find('[data-plugin-id="threshold-30"]');
  const focused = middle.querySelector<HTMLAnchorElement>(".plugin-card-author")!;
  focused.focus();

  for (const count of [61, 60, 61]) {
    setItems(entries.slice(0, count));
    flush();
    expect(find('[data-plugin-id="threshold-30"]')).toBe(middle);
    expect(document.activeElement).toBe(focused);
    await nextFrame();
    await waitForSolid(() => {
      expect(find('[data-plugin-id="threshold-30"]')).toBe(middle);
      expect(document.activeElement).toBe(focused);
      if (count === 60) {
        expect(cards()).toHaveLength(60);
        expect(middle.parentElement!.style.position).toBe("");
      } else {
        expect(cards().length).toBeLessThan(61);
        expect(middle.parentElement!.style.position).toBe("absolute");
      }
    });
  }
  find('[data-plugin-id="threshold-60"]')
    .querySelector<HTMLAnchorElement>(".plugin-catalog-card__primary-link")!
    .focus();
  await nextFrame();
  const last = find('[data-plugin-id="threshold-60"]').getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  expect(last.top).toBeLessThan(viewport.bottom);
  expect(last.bottom).toBeGreaterThan(viewport.top);
});

it("windows both publisher groups while keeping their search endpoints reachable", async () => {
  container.className = "content";
  Object.assign(container.style, { height: "500px", width: "1100px", overflow: "auto" });
  const items = Array.from({ length: 1_000 }, (_, index) =>
    plugin(`search-${String(index).padStart(4, "0")}`, {
      catalog: { official: index % 2 === 0 },
    }),
  );
  const [messages, setMessages] = createSignal<PluginCatalogResultsProps["messages"]>({});
  render(() => (
    <PluginCatalogResults
      {...catalogProps()}
      result={{ items }}
      query="search"
      messages={messages()}
    />
  ));
  await nextFrame();
  const groups = [...container.querySelectorAll<HTMLElement>("[data-catalog-section]")];
  expect(groups.map((group) => group.dataset.catalogSection)).toEqual(["official", "community"]);
  await waitForSolid(() => {
    expect(container.querySelectorAll(".plugin-catalog-card").length).toBeLessThan(100);
    for (const group of groups) {
      expect(group.querySelector("[aria-setsize]")?.getAttribute("aria-setsize")).toBe("500");
    }
  });
  expect(container.querySelector(".plugin-catalog-grid--results")).toBeNull();
  const firstOfficial = find('[data-plugin-id="search-0000"]');
  const height = firstOfficial.getBoundingClientRect().height;
  setMessages({
    "install:search-0000": { kind: "error", text: "Visible error details. ".repeat(100) },
  });
  await waitForSolid(() =>
    expect(firstOfficial.getBoundingClientRect().height).toBeGreaterThan(height),
  );
  for (const id of ["search-0998", "search-0999", "search-0000"]) {
    const card = find(`[data-plugin-id="${id}"]`);
    const link = card.querySelector<HTMLAnchorElement>(".plugin-catalog-card__primary-link")!;
    link.focus();
    await nextFrame();
    const bounds = card.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    expect(document.activeElement).toBe(link);
    expect(bounds.top).toBeLessThan(viewport.bottom);
    expect(bounds.bottom, id).toBeGreaterThan(viewport.top);
  }
});

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
