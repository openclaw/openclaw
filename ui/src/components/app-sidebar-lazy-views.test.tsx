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

it("loads optional sidebar views on selection without replacing the shell or retained controls", async () => {
  try {
    const { sidebar } = await mountRoster(roster, []);
    await vi.waitFor(() =>
      expect(sidebar.querySelector(".sidebar-shell"), "mounted sidebar shell").not.toBeNull(),
    );
    const shell = sidebar.querySelector(".sidebar-shell");
    const rail = sidebar.querySelector(".sidebar-rail");
    const body = sidebar.querySelector(".sidebar-shell__body");
    expect(shell).not.toBeNull();
    expect(rail).not.toBeNull();
    expect(body).not.toBeNull();
    expect(modules.roster.started).toBe(false);
    expect(modules.pages.started).toBe(false);

    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => {
      expect(modules.roster.started).toBe(true);
      expect(body?.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    });
    expect(sidebar.querySelector(".sidebar-shell")).toBe(shell);
    expect(sidebar.querySelector(".sidebar-rail")).toBe(rail);
    expect(sidebar.querySelector(".sidebar-shell__body")).toBe(body);
    modules.roster.resolve();
    await vi.waitFor(() =>
      expect(sidebar.querySelector("a.sidebar-agent-roster__row")).not.toBeNull(),
    );
    const agentLink = sidebar.querySelector<HTMLAnchorElement>("a.sidebar-agent-roster__row")!;
    agentLink.focus();
    sidebar.invalidate();
    await settleRoster(sidebar);
    expect(sidebar.querySelector("a.sidebar-agent-roster__row")).toBe(agentLink);
    expect(document.activeElement).toBe(agentLink);
    expect(body?.querySelector(".sidebar-view-loading")).toBeNull();
    expect(modules.pages.started).toBe(false);

    await selectSidebarView(sidebar, "pages");
    await vi.waitFor(() => {
      expect(modules.pages.started).toBe(true);
      expect(body?.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    });
    expect(sidebar.querySelector(".sidebar-shell")).toBe(shell);
    expect(sidebar.querySelector(".sidebar-rail")).toBe(rail);
    expect(sidebar.querySelector(".sidebar-shell__body")).toBe(body);
    modules.pages.resolve();
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector('.sidebar-pages [data-sidebar-entry="route:usage"] a'),
      ).not.toBeNull(),
    );
    const pageLink = sidebar.querySelector<HTMLAnchorElement>(
      '.sidebar-pages [data-sidebar-entry="route:usage"] a',
    )!;
    pageLink.focus();
    sidebar.invalidate();
    await settleRoster(sidebar);
    expect(sidebar.querySelector('.sidebar-pages [data-sidebar-entry="route:usage"] a')).toBe(
      pageLink,
    );
    expect(document.activeElement).toBe(pageLink);
    expect(body?.querySelector(".sidebar-view-loading")).toBeNull();
  } finally {
    modules.roster.resolve();
    modules.pages.resolve();
  }
});
