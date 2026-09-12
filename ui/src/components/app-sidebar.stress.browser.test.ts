import type { CDPSession } from "@vitest/browser-playwright";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar.ts";
import { owner, other, key, mount, settled, geometry } from "../test-helpers/sidebar-stress.ts";
setupSidebarTest();
const captureDirectory = "../../../.openclaw/tmp/sidebar-stress-" + crypto.randomUUID();
afterEach(async () => {
  document.documentElement.removeAttribute("data-theme-mode");
  document.documentElement.removeAttribute("dir");
  const session: CDPSession = cdp();
  await session.send("Emulation.setEmulatedMedia", { features: [] });
  document.documentElement.style.removeProperty("--control-ui-text-scale");
});
const desktopMatrix = (["category", "person", "project", "none"] as const).flatMap((grouping) =>
  ["light", "dark"].flatMap((theme) =>
    [220, 280].flatMap((width) =>
      [false, true].map((preview) => ({
        grouping,
        theme,
        width,
        preview,
        viewport: 1000,
        textScale: 1,
        reduced: false,
        rtl: false,
      })),
    ),
  ),
);

const matrix = [
  ...desktopMatrix,
  ...(["category", "person", "project", "none"] as const).flatMap((grouping) => [
    {
      grouping,
      theme: "light",
      width: 320,
      preview: true,
      viewport: 390,
      textScale: 1,
      reduced: true,
      rtl: false,
    },
    {
      grouping,
      theme: "dark",
      width: 220,
      preview: true,
      viewport: 1000,
      textScale: 1.4,
      reduced: true,
      rtl: false,
    },
    {
      grouping,
      theme: "dark",
      width: 280,
      preview: false,
      viewport: 1000,
      textScale: 1,
      reduced: true,
      rtl: true,
    },
  ]),
];

describe.runIf("__vitest_browser__" in globalThis)("full sidebar state stress", () => {
  it.each(matrix)(
    "$grouping / $theme / $width px / preview=$preview / viewport=$viewport / text=$textScale / rtl=$rtl",
    async ({ grouping, theme, width, preview, viewport, textScale, reduced, rtl }) => {
      await page.viewport(viewport, 1100);
      document.documentElement.dir = rtl ? "rtl" : "ltr";
      document.documentElement.style.setProperty("--control-ui-text-scale", String(textScale));
      const session: CDPSession = cdp();
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }],
      });
      document.documentElement.dataset.themeMode = theme;
      const { sidebar, gateway, fixtureKeys } = await mount(width);
      sidebar.sessionOrganizer.setSessionsGrouping(grouping);
      sidebar.sessionOrganizer.setSessionsShowPreview(preview);
      sidebar.sessionOrganizer.saveCollapsedSessionSections(new Set());
      await settled(sidebar);
      for (let pass = 0; pass < 8; pass++) {
        const more = [
          ...sidebar.querySelectorAll<HTMLButtonElement>(
            '.sidebar-session-pagination__button[aria-label="Show more"]',
          ),
        ];
        if (!more.length) {
          break;
        }
        more.forEach((b) => b.click());
        await settled(sidebar);
      }
      const parent = sidebar.querySelector<HTMLButtonElement>(
        `[data-child-session-toggle="${key("parent")}"]`,
      );
      parent?.click();
      await settled(sidebar);
      sidebar
        .querySelector<HTMLButtonElement>(`[data-show-more-children="${key("parent")}"]`)
        ?.click();
      await settled(sidebar);
      const before = geometry(sidebar);
      expect(before.length).toBeGreaterThan(35);
      if (grouping === "person") {
        expect(sidebar.querySelector('[data-session-section^="person:"]')).not.toBeNull();
        expect(
          sidebar.querySelector(`[data-session-key="${key("owner-running")}"] .session-owner-chip`),
        ).toBeNull();
      }
      if (grouping === "project") {
        expect(
          sidebar.querySelectorAll('[data-session-section^="project:"]').length,
        ).toBeGreaterThanOrEqual(3);
      }
      const issues: string[] = fixtureKeys
        .filter((expected) => !before.some((row) => row.key === expected))
        .map((missing) => "Missing fixture row: " + missing);
      for (const row of before) {
        for (const ring of row.rings) {
          if (Math.abs(ring.rect.width - (ring.bare ? 12 : 25)) > 0.1) {
            issues.push(row.key + " ring " + ring.rect.width);
          }
          if (
            row.title &&
            (rtl ? ring.rect.left < row.title.right - 0.5 : ring.rect.right > row.title.left + 0.5)
          ) {
            issues.push(row.key + " ring/title overlap");
          }
        }
        for (const stack of row.stacks) {
          if (Math.abs(stack.width - 20) > 0.1 || Math.abs(stack.height - 20) > 0.1) {
            issues.push(row.key + " oversized stack");
          }
        }
        if (row.title && row.title.right > row.rect.right + 0.5) {
          issues.push(row.key + " title outside row");
        }
        if (row.title && row.title.width <= 0) {
          issues.push(row.key + " title has no space");
        }
      }
      if (grouping === "person" && width === 280 && !preview && !rtl) {
        const image = await page.screenshot({
          element: sidebar,
          path: captureDirectory + "/person-" + theme + "-no-viewer.png",
        });
        console.info("SIDEBAR_STRESS_CAPTURE", image);
      }
      gateway.publishEvent("presence", {
        presence: [
          {
            instanceId: "nora-browser",
            user: { id: "nora", identity: { type: "profile", id: "nora" }, name: "Nora" },
            watchedSessions: [key("owner-running"), key("group-running")],
          },
          ...["viewer-a", "viewer-b", "viewer-c", "viewer-d"].map((id) => ({
            instanceId: id,
            user: { id, identity: { type: "profile", id }, name: id },
            watchedSessions: [key("crowded")],
          })),
        ],
      });
      await settled(sidebar);
      const after = geometry(sidebar);
      for (const row of after) {
        if (row.title && row.title.width <= 0) {
          issues.push(row.key + " no title space after viewers join");
        }
        if (row.title && row.title.right > row.rect.right + 0.5) {
          issues.push(row.key + " title overflow after viewers join");
        }
        const previous = before.find((x) => x.key === row.key);
        if (
          previous &&
          row.title &&
          previous.title &&
          Math.abs(row.title.x - previous.title.x) > 0.1
        ) {
          issues.push(row.key + " title shifted with presence");
        }
      }
      if (grouping === "person") {
        expect(
          sidebar.querySelector(`[data-session-key="${key("owner-running")}"] .session-owner-chip`),
        ).not.toBeNull();
      }
      console.info(
        "SIDEBAR_STRESS",
        JSON.stringify({
          grouping,
          theme,
          width,
          preview,
          viewport,
          textScale,
          reduced,
          rtl,
          rows: before.length,
          rings: before.flatMap((r) => r.rings).length,
          issues,
        }),
      );
      if (reduced) {
        for (const ring of sidebar.querySelectorAll(".session-glyph__ring")) {
          expect(getComputedStyle(ring).animationName).toBe("none");
        }
      }
      // Preserve diagnostic captures for the explicitly requested local stress audit.
      if (width === 280 && !preview && !rtl) {
        for (const ring of sidebar.querySelectorAll(".session-glyph__ring")) {
          for (const animation of ring.getAnimations()) {
            animation.pause();
            animation.currentTime = 0;
          }
        }
        const image = await page.screenshot({
          element: sidebar,
          path: captureDirectory + "/" + grouping + "-" + theme + ".png",
        });
        console.info("SIDEBAR_STRESS_CAPTURE", image);
      }
      expect(issues).toEqual([]);
    },
  );
});

describe.runIf("__vitest_browser__" in globalThis)("catalog and archive row stress", () => {
  it.each(
    (["none", "person", "project"] as const).flatMap((grouping) =>
      [220, 280].flatMap((width) => ["light", "dark"].map((theme) => ({ grouping, width, theme }))),
    ),
  )("catalog $grouping / $width / $theme", async ({ grouping, width, theme }) => {
    await page.viewport(1000, 1100);
    document.documentElement.dataset.themeMode = theme;
    localStorage.setItem("openclaw:sidebar:sessions:catalog-grouping", grouping);
    const { sidebar } = await mount(width);
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local",
            kind: "gateway",
            connected: true,
            sessions: Array.from({ length: 8 }, (_, i) => ({
              threadId: "thread-" + i,
              name: "Native catalog thread " + i,
              cwd: i % 2 ? "/projects/alpha" : "/projects/beta",
              createdActor: i % 2 ? owner : other,
              status: i % 2 ? "running" : "idle",
              archived: false,
              canContinue: true,
              canArchive: true,
              ...(i === 0 ? { sessionKey: key("group-running") } : {}),
              ...(i === 1 ? { pullRequest: { numbers: [123], state: "draft" as const } } : {}),
            })),
          },
          {
            hostId: "node:offline",
            label: "Offline host",
            kind: "node",
            connected: false,
            error: { code: "NODE_OFFLINE", message: "Fixture offline" },
            sessions: [
              {
                threadId: "offline",
                name: "Cached remote thread",
                cwd: "/projects/remote",
                status: "running",
                archived: false,
                canContinue: false,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await settled(sidebar);
    const catalog = sidebar.querySelector<HTMLElement>('[data-session-section="catalog:codex"]');
    expect(catalog).not.toBeNull();
    const rows = geometry(catalog!);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      for (const ring of row.rings) {
        expect(ring.rect.width).toBe(ring.bare ? 12 : 25);
        if (row.title) {
          expect(ring.rect.right).toBeLessThanOrEqual(row.title.left + 0.5);
        }
      }
    }
    if (grouping !== "none") {
      expect(catalog!.querySelector("[data-session-catalog-project]")).not.toBeNull();
    }
    const toggle = catalog!.querySelector<HTMLButtonElement>(".sidebar-session-group-toggle")!;
    toggle.click();
    await settled(sidebar);
    expect(geometry(catalog!).length).toBe(0);
    toggle.click();
    await settled(sidebar);
    expect(geometry(catalog!).length).toBe(rows.length);
    console.info(
      "SIDEBAR_CATALOG_STRESS",
      JSON.stringify({ grouping, width, theme, rows: rows.length }),
    );
  });
  it.each(["category", "person", "project", "none"] as const)(
    "all/archived views and row actions in %s grouping",
    async (grouping) => {
      await page.viewport(1000, 1100);
      const { sidebar } = await mount(220);
      sidebar.sessionOrganizer.setSessionsGrouping(grouping);
      sidebar.sessionOrganizer.setSessionsStatusFilter("all");
      await settled(sidebar);
      for (let pass = 0; pass < 8; pass++) {
        const more = [
          ...sidebar.querySelectorAll<HTMLButtonElement>(
            '.sidebar-session-pagination__button[aria-label="Show more"]',
          ),
        ];
        if (!more.length) {
          break;
        }
        more.forEach((button) => button.click());
        await settled(sidebar);
      }
      const row = sidebar.querySelector<HTMLElement>(`[data-session-key="${key("archived")}"]`);
      expect(row).not.toBeNull();
      expect(row!.querySelector(".sidebar-session__archive-glyph")).not.toBeNull();
      for (const entry of geometry(sidebar)) {
        for (const ring of entry.rings) {
          expect(ring.rect.width).toBe(ring.bare ? 12 : 25);
        }
      }
      const target = sidebar.querySelector<HTMLAnchorElement>(
        `[data-session-key="${key("pinned")}"] .sidebar-recent-session__link`,
      )!;
      target.focus();
      expect(document.activeElement).toBe(target);
      target.dispatchEvent(
        new MouseEvent("click", { altKey: true, bubbles: true, cancelable: true }),
      );
      await settled(sidebar);
      expect(sidebar.querySelector(".sidebar-recent-session--selected")).not.toBeNull();
      sidebar.sessionOrganizer.setSessionsStatusFilter("archived");
      await settled(sidebar);
      const archived = sidebar.querySelector<HTMLElement>(
        `[data-session-key="${key("archived")}"]`,
      );
      expect(archived?.querySelector(".session-owner-chip")?.getAttribute("aria-label")).toContain(
        "Archived by Casey",
      );
    },
  );
});
