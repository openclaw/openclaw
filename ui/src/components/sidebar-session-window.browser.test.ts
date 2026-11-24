import { expect, it } from "vitest";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "../test-helpers/load-styles.ts";

setupSidebarTest();

it("preserves measured two-line row heights when layout invalidation does not resize rows", async () => {
  const keys = Array.from({ length: 8 }, (_, i) => `agent:main:telegram:group:sample:topic:${i}`);
  const sessions = createSessionsHarness("main", keys);
  sessions.sessions.state.result!.sessions.forEach((row, i) => {
    Object.assign(row, { label: `Channel conversation ${i}`, channel: "telegram", kind: "group" });
  });
  const { sidebar } = await mountSidebar(
    createGateway(createTestGatewayClient(async () => ({}))),
    sessions.sessions,
  );
  sidebar.style.cssText = "display:block;width:320px;height:600px";
  const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  scroller.style.cssText = "height:500px;flex:none;overflow:auto";
  sidebar.connected = true;
  sidebar.sessionsShowPreview = false;
  const rows = () =>
    [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session")].toSorted(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    );
  const separated = () => {
    const mounted = rows();
    expect(mounted.length).toBeGreaterThan(1);
    expect(mounted).toHaveLength(keys.length);
    for (let i = 1; i < mounted.length; i++) {
      expect(mounted[i]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        mounted[i - 1]!.getBoundingClientRect().bottom,
      );
    }
  };
  await waitForSolid(() => {
    expect(sidebar.querySelectorAll(".sidebar-recent-session__channel").length).toBeGreaterThan(1);
    separated();
  });
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await waitForSolid(separated);
  const first = rows()[0]!;
  const height = first.getBoundingClientRect().height;
  sidebar.style.setProperty("--control-ui-text-scale", "1.1");
  first.querySelector<HTMLAnchorElement>("a")!.focus();
  // This text-scale change leaves the fixed title/subtitle line boxes unchanged.
  // Focusing a row updates retention without replacing the mounted elements.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  separated();
  expect(rows()[0]).toBe(first);
  expect(first.getBoundingClientRect().height).toBe(height);
});

it("keeps enlarged child groups apart when child loading settles after reopening", async () => {
  const parentKey = "agent:main:parent";
  const nextKey = "agent:main:next";
  const childKeys = Array.from({ length: 4 }, (_, index) => `agent:main:dashboard:child-${index}`);
  const harness = createSessionsHarness("main", [parentKey, nextKey, ...childKeys]);
  const result = harness.sessions.state.result!;
  result.sessions.forEach((row, index) => {
    Object.assign(
      row,
      index === 0
        ? { label: "Parent task", childSessions: childKeys, createdAt: 100 }
        : index === 1
          ? { label: "Following task", createdAt: 90 }
          : {
              label: `Child ${index}`,
              kind: "direct",
              spawnedBy: parentKey,
              parentSessionKey: parentKey,
              createdAt: index,
            },
    );
  });
  harness.list.mockImplementation(async (options) => ({
    ...result,
    sessions:
      options?.spawnedBy === parentKey
        ? result.sessions.filter((row) => childKeys.includes(row.key))
        : result.sessions,
    hasMore: false,
  }));
  const { sidebar } = await mountSidebar(
    createGateway(createTestGatewayClient(async () => ({}))),
    harness.sessions,
  );
  sidebar.style.cssText = "display:block;width:320px;height:700px;--control-ui-text-scale:1.25";
  const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  scroller.style.cssText = "height:600px;flex:none;overflow:auto";
  sidebar.setSessionSortMode("created");
  sidebar.connected = true;
  sidebar.sessionsShowPreview = false;
  await waitForSolid(() =>
    expect(sidebar.querySelector(`[data-child-session-toggle="${parentKey}"]`)).not.toBeNull(),
  );
  const toggle = sidebar.querySelector<HTMLButtonElement>(
    `[data-child-session-toggle="${parentKey}"]`,
  )!;
  if (toggle.getAttribute("aria-expanded") !== "true") {
    toggle.click();
  }
  const separated = () => {
    const children = [
      ...sidebar.querySelectorAll<HTMLElement>(
        `[data-session-tree="${parentKey}"] .sidebar-recent-session--child`,
      ),
    ];
    expect(children).toHaveLength(childKeys.length);
    const next = sidebar.querySelector<HTMLElement>(`[data-session-key="${nextKey}"]`)!;
    const lastChild = children.at(-1)!;
    // Enlarged rows exceed the 32px estimate, so losing their measurements overlaps the next root.
    expect(lastChild.getBoundingClientRect().height).toBeGreaterThan(32);
    expect(next.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      lastChild.getBoundingClientRect().bottom,
    );
  };
  await waitForSolid(separated);
  for (let cycle = 0; cycle < 3; cycle++) {
    toggle.click();
    await waitForSolid(() =>
      expect(
        sidebar.querySelectorAll(
          `[data-session-tree="${parentKey}"] .sidebar-recent-session--child`,
        ),
      ).toHaveLength(0),
    );
    toggle.click();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    await waitForSolid(separated);
  }
});
