/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
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
  const routeData = expectDefined(fixture.element.routeData, "Missing Memory route fixture");
  return {
    ...fixture,
    routeData,
    mount: () => mountConfigPage(fixture.context, { pageId: "memory", routeData }),
  };
}

const agentRoute = () =>
  createRoute({
    agents: [{ id: "main" }, { id: "research" }],
    routeData: memoryRoute("/settings/memory?agent=research"),
  });

it.each([
  ["/settings/memory?tab=dreaming", "/settings/memory/dreams"],
  ["/settings/memory?tab=search", "/settings/memory/settings"],
  ["/settings/memory?section=memory", "/settings/memory/settings"],
  ["/settings/memory#config-section-memory", "/settings/memory/settings#config-section-memory"],
] as const)(
  "normalizes %s once per Settings visit without oscillating back to a query tab",
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
    for (const tab of ["overview", "dreams"]) {
      view.page
        .querySelector(`#memory-tab-${tab}`)
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    }
    expect(navigate).not.toHaveBeenCalled();
    const canonical = memoryRoute(expectedUrl);
    const { pathname, search, hash } = canonical;
    expect(replace).toHaveBeenCalledExactlyOnceWith("memory", { pathname, search, hash });
    view.update({ pageId: "advanced", routeData: memoryRoute("/settings/advanced") });
    view.update({ pageId: "memory", routeData: { ...fixture.routeData } });
    expect(replace).toHaveBeenCalledTimes(2);

    view.update({ routeData: canonical });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      view.update({ routeData: { ...canonical } });
    }
    expect(replace).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ["URL", [], "research"],
  ["newer sidebar", ["main"], "main"],
  ["restored sidebar", ["research", "main"], "main"],
] as const)(
  "applies %s intent before mounting the first Memory presentation",
  async (_intent, choices, selectedId) => {
    const fixture = agentRoute();
    for (const agentId of choices) {
      fixture.settingsAgentSelection.set(agentId);
    }
    fixture.mount();
    await waitForSolid(() =>
      expect(fixture.settingsViews.at(-1)?.snapshot.agentId).toBe(selectedId),
    );
    expect(fixture.settingsAgentSelection.state.selectedId).toBe(selectedId);
    expect(fixture.settingsViews.every((view) => view.snapshot.agentId === selectedId)).toBe(true);
  },
);

it("honors a fresh explicit Memory navigation after the sidebar changed the same URL's agent", async () => {
  const fixture = agentRoute();
  const selection = fixture.settingsAgentSelection;
  const view = fixture.mount();
  await waitForSolid(() => expect(selection.state.selectedId).toBe("research"));
  selection.set("main");
  view.update({
    routeData: {
      ...fixture.routeData,
      agentSelectionIntent: { owner: selection, revision: selection.intentRevision },
    },
  });
  await waitForSolid(() => expect(selection.state.selectedId).toBe("research"));
});
