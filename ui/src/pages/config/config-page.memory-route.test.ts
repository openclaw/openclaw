/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { setPluginEnabled } from "../../lib/plugins/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { mountConfigPage } from "./config-page.test-support.ts";
import { createMemoryPage, memoryRoute } from "./memory-page.test-support.tsx";

vi.mock("../../lib/plugins/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plugins/index.ts")>();
  return { ...actual, setPluginEnabled: vi.fn() };
});

function createRoute(params: Partial<Parameters<typeof createMemoryPage>[0]> = {}) {
  vi.mocked(setPluginEnabled).mockReset();
  const fixture = createMemoryPage({ configObject: {}, ...params });
  const routeData = fixture.element.routeData;
  if (!routeData) {
    throw new Error("Missing Memory route fixture");
  }
  return {
    ...fixture,
    routeData,
    mount() {
      const view = mountConfigPage(fixture.context, { pageId: "memory", routeData });
      onTestFinished(view.dispose);
      return view;
    },
  };
}

it.each([
  ["/settings/memory?tab=dreaming", "/settings/memory/dreams"],
  ["/settings/memory?tab=search", "/settings/memory/settings"],
  ["/settings/memory?section=memory", "/settings/memory/settings"],
  ["/settings/memory#config-section-memory", "/settings/memory/settings#config-section-memory"],
] as const)(
  "performs at most one replace for %s and never oscillates back to a query tab",
  (sourceUrl, expectedUrl) => {
    const replace = vi.fn();
    const navigate = vi.fn();
    const fixture = createRoute({
      catalog: [],
      replace,
      navigate,
      routeData: memoryRoute(sourceUrl),
    });
    const view = fixture.mount();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      view.update({ routeData: { ...fixture.routeData } });
    }
    view.update({ routeData: null });
    view.update({ routeData: { ...fixture.routeData } });
    for (const tab of ["overview", "dreams"]) {
      view.page
        .querySelector(`#memory-tab-${tab}`)
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    }
    expect(navigate).not.toHaveBeenCalled();
    const canonical = memoryRoute(expectedUrl);
    const { pathname, search, hash } = canonical;
    expect(replace).toHaveBeenCalledExactlyOnceWith("memory", { pathname, search, hash });

    view.update({ routeData: canonical });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      view.update({ routeData: { ...canonical } });
    }
    expect(replace).toHaveBeenCalledOnce();
  },
);

it("normalizes an old Memory link again after leaving its retained Settings owner", () => {
  const replace = vi.fn();
  const fixture = createRoute({ replace, routeData: memoryRoute("/settings/memory?tab=search") });
  const view = fixture.mount();
  expect(replace).toHaveBeenCalledOnce();
  view.update({ pageId: "advanced", routeData: memoryRoute("/settings/advanced") });
  view.update({ pageId: "memory", routeData: { ...fixture.routeData } });
  expect(replace).toHaveBeenCalledTimes(2);
});

it("applies an admitted URL agent before mounting the first Memory presentation", async () => {
  const fixture = createRoute({
    agents: [{ id: "main" }, { id: "research" }],
    routeData: memoryRoute("/settings/memory?agent=research"),
  });
  fixture.mount();
  await waitForSolid(() => expect(fixture.settingsViews.length).toBeGreaterThan(0));
  expect(fixture.settingsViews.every((view) => view.snapshot.agentId === "research")).toBe(true);
});

it.each([["main"], ["research", "main"]])(
  "keeps newer sidebar intent when a pending Memory link mounts (%j)",
  async (...choices: string[]) => {
    const fixture = createRoute({
      agents: [{ id: "main" }, { id: "research" }],
      routeData: memoryRoute("/settings/memory?agent=research"),
    });
    for (const agentId of choices) {
      fixture.settingsAgentSelection.set(agentId);
    }
    fixture.mount();
    await waitForSolid(() => expect(fixture.settingsViews.at(-1)?.snapshot.agentId).toBe("main"));
    expect(fixture.settingsAgentSelection.state.selectedId).toBe("main");
    expect(fixture.settingsViews.some((view) => view.snapshot.agentId === "research")).toBe(false);
  },
);

it("honors a fresh explicit Memory navigation after the sidebar changed the same URL's agent", async () => {
  const fixture = createRoute({
    agents: [{ id: "main" }, { id: "research" }],
    routeData: memoryRoute("/settings/memory?agent=research"),
  });
  const view = fixture.mount();
  await waitForSolid(() =>
    expect(fixture.settingsAgentSelection.state.selectedId).toBe("research"),
  );
  fixture.settingsAgentSelection.set("main");
  view.update({
    routeData: {
      ...memoryRoute("/settings/memory?agent=research"),
      agentSelectionIntent: {
        owner: fixture.settingsAgentSelection,
        revision: fixture.settingsAgentSelection.intentRevision,
      },
    },
  });
  await waitForSolid(() =>
    expect(fixture.settingsAgentSelection.state.selectedId).toBe("research"),
  );
});
