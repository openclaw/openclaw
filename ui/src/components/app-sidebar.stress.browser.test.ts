import type { CDPSession } from "@vitest/browser-playwright";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import "../test-helpers/load-styles.ts";
import { owner, other, key, mount, settled, geometry } from "../test-helpers/sidebar-stress.ts";
import {
  setSessionsGrouping,
  setSessionsShowPreview,
  setSessionsStatusFilter,
} from "./session-organizer-menu.runtime.ts";
setupSidebarTest();
afterEach(async () => {
  document.documentElement.removeAttribute("data-theme-mode");
  document.documentElement.removeAttribute("dir");
  const session: CDPSession = cdp();
  await session.send("Emulation.setEmulatedMedia", { features: [] });
  document.documentElement.style.removeProperty("--control-ui-text-scale");
});
const matrix = (
  [
    ["category", "light", 220, true, 1000, 1, false, false],
    ["person", "dark", 220, true, 1000, 1.4, true, false],
    ["project", "light", 320, true, 390, 1, true, false],
    ["none", "dark", 280, false, 1000, 1, true, true],
  ] as const
).map(([grouping, theme, width, preview, viewport, textScale, reduced, rtl]) => ({
  grouping,
  theme,
  width,
  preview,
  viewport,
  textScale,
  reduced,
  rtl,
}));

async function showAll(sidebar: Awaited<ReturnType<typeof mount>>["sidebar"]) {
  for (let pass = 0; pass < 8; pass++) {
    const more = sidebar.querySelectorAll<HTMLButtonElement>(
      '.sidebar-session-pagination__button[aria-label="Show more"]',
    );
    if (!more.length) {
      break;
    }
    more.forEach((button) => button.click());
    await settled(sidebar);
  }
}

function titleIssues(row: ReturnType<typeof geometry>[number], suffix = "") {
  const issues: string[] = [];
  if (row.title && row.title.right > row.rect.right + 0.5) {
    issues.push(row.key + " title outside row" + suffix);
  }
  if (row.title && row.title.width <= 0) {
    issues.push(row.key + " title has no space" + suffix);
  }
  return issues;
}

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
      const { sidebar, gateway, fixtureKeys, context } = await mount(width);
      context.theme.setMode(theme === "dark" ? "dark" : "light");
      await expect.poll(() => document.documentElement.dataset.themeMode).toBe(theme);
      setSessionsGrouping(sidebar.sessionOrganizer, grouping);
      setSessionsShowPreview(sidebar.sessionOrganizer, preview);
      sidebar.sessionOrganizer.saveCollapsedSessionSections(new Set());
      await settled(sidebar);
      await showAll(sidebar);
      for (const attribute of ["data-child-session-toggle", "data-show-more-children"]) {
        sidebar.querySelector<HTMLButtonElement>(`[${attribute}="${key("parent")}"]`)?.click();
        await settled(sidebar);
      }
      const ownerChip = () =>
        sidebar.querySelector(`[data-session-key="${key("owner-running")}"] .session-owner-chip`);
      const before = geometry(sidebar);
      expect(before.length).toBeGreaterThan(35);
      if (grouping === "person") {
        expect(sidebar.querySelector('[data-session-section^="person:"]')).not.toBeNull();
        expect(ownerChip()).toBeNull();
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
        const glyphs = [
          ...row.rings.map(({ rect, bare }) => ({ rect, width: bare ? 12 : 25, height: null })),
          ...row.traces.map((rect) => ({ rect, width: 32, height: 22 })),
          ...row.stacks.map((rect) => ({ rect, width: 28, height: 20 })),
        ];
        for (const { rect, width: expectedWidth, height } of glyphs) {
          expect(Math.abs(rect.width - expectedWidth), row.key).toBeLessThanOrEqual(0.1);
          if (height !== null) {
            expect(Math.abs(rect.height - height), row.key).toBeLessThanOrEqual(0.1);
          }
        }
        for (const rect of [...row.rings.map((ring) => ring.rect), ...row.traces]) {
          if (row.title) {
            expect(
              rtl ? row.title.right - rect.left : rect.right - row.title.left,
              row.key,
            ).toBeLessThanOrEqual(0.5);
          }
        }
        issues.push(...titleIssues(row));
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
        issues.push(...titleIssues(row, " after viewers join"));
        const previous = before.find((x) => x.key === row.key);
        if (
          previous &&
          row.title &&
          previous.title &&
          Math.abs(
            rtl ? row.title.right - previous.title.right : row.title.left - previous.title.left,
          ) > 0.1
        ) {
          issues.push(row.key + " title shifted with presence");
        }
      }
      if (grouping === "person") {
        expect(ownerChip()).not.toBeNull();
      }
      if (reduced) {
        for (const ring of sidebar.querySelectorAll(".session-glyph__ring")) {
          expect(getComputedStyle(ring).animationName).toBe("none");
        }
        // Main replaces the moving paired arc with its static track in reduced motion.
        for (const trace of sidebar.querySelectorAll(".session-glyph__trace")) {
          expect(getComputedStyle(trace.querySelector(".session-glyph__trace-run")!).display).toBe(
            "none",
          );
          expect(
            getComputedStyle(trace.querySelector(".session-glyph__trace-track")!).display,
          ).not.toBe("none");
        }
      }
      expect(issues).toEqual([]);
    },
  );
});

describe.runIf("__vitest_browser__" in globalThis)("catalog and archive row stress", () => {
  it.each(["none", "person", "project"] as const)("catalog %s", async (grouping) => {
    const width = 220;
    const theme = "light";
    await page.viewport(1000, 1100);
    document.documentElement.dataset.themeMode = theme;
    localStorage.setItem("openclaw:sidebar:sessions:catalog-grouping", grouping);
    const { sidebar, context } = await mount(width);
    context.theme.setMode("light");
    await expect.poll(() => document.documentElement.dataset.themeMode).toBe(theme);
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
  });
  it("keeps archive attribution and row actions in person grouping", async () => {
    await page.viewport(1000, 1100);
    const { sidebar } = await mount(220);
    setSessionsGrouping(sidebar.sessionOrganizer, "person");
    setSessionsStatusFilter(sidebar.sessionOrganizer, "all");
    await settled(sidebar);
    await showAll(sidebar);
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
    setSessionsStatusFilter(sidebar.sessionOrganizer, "archived");
    await settled(sidebar);
    const archived = sidebar.querySelector<HTMLElement>(`[data-session-key="${key("archived")}"]`);
    expect(archived?.querySelector(".session-owner-chip")?.getAttribute("aria-label")).toContain(
      "Archived by Casey",
    );
  });
});
