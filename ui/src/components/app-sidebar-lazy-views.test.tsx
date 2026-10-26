/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import {
  mountRoster,
  roster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { selectSidebarView } from "../test-helpers/app-sidebar-setup.ts";

const modules = vi.hoisted(() => ({
  roster: { started: false, ...Promise.withResolvers<void>() },
  pages: { started: false, ...Promise.withResolvers<void>() },
  online: { started: false, ...Promise.withResolvers<void>() },
}));
vi.mock("./sidebar-agent-roster.tsx", async (importOriginal) => {
  modules.roster.started = true;
  await modules.roster.promise;
  return importOriginal();
});
vi.mock("./app-sidebar-pages.tsx", async (importOriginal) => {
  modules.pages.started = true;
  await modules.pages.promise;
  return importOriginal();
});
vi.mock("./app-sidebar-online.tsx", async (importOriginal) => {
  modules.online.started = true;
  await modules.online.promise;
  return importOriginal();
});

it("loads optional sidebar views on selection without replacing the shell or retained controls", async () => {
  try {
    const { sidebar } = await mountRoster(roster, []);
    await vi.waitFor(() =>
      expect(sidebar.querySelector(".sidebar-shell"), "mounted sidebar shell").not.toBeNull(),
    );
    const regions = [".sidebar-shell", ".sidebar-rail", ".sidebar-shell__body"];
    const originalRegions = regions.map((selector) => sidebar.querySelector(selector));
    originalRegions.forEach((region) => expect(region).not.toBeNull());
    const expectRegions = () =>
      regions.forEach((selector, index) =>
        expect(sidebar.querySelector(selector)).toBe(originalRegions[index]),
      );
    const body = sidebar.querySelector(".sidebar-shell__body");
    expect(Object.values(modules).map((module) => module.started)).toEqual([false, false, false]);
    const loading = async (module: (typeof modules)[keyof typeof modules]) => {
      await vi.waitFor(() => {
        expect(module.started).toBe(true);
        expect(body?.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
      });
      expectRegions();
      module.resolve();
    };
    const retainLink = async (selector: string) => {
      await vi.waitFor(() => expect(sidebar.querySelector(selector)).not.toBeNull());
      const link = sidebar.querySelector<HTMLAnchorElement>(selector)!;
      link.focus();
      sidebar.invalidate();
      await settleRoster(sidebar);
      expect(sidebar.querySelector(selector)).toBe(link);
      expect(document.activeElement).toBe(link);
      expect(body?.querySelector(".sidebar-view-loading")).toBeNull();
    };

    sidebar.sidebarAgentsMode = "roster";
    await loading(modules.roster);
    await retainLink("a.sidebar-agent-roster__row");
    expect(modules.pages.started).toBe(false);

    await selectSidebarView(sidebar, "pages");
    await loading(modules.pages);
    await retainLink('.sidebar-pages [data-sidebar-entry="route:usage"] a');
    await selectSidebarView(sidebar, "online");
    await loading(modules.online);
    await vi.waitFor(() => expect(body?.querySelector(".sidebar-online")).not.toBeNull());
  } finally {
    modules.roster.resolve();
    modules.pages.resolve();
    modules.online.resolve();
  }
});
