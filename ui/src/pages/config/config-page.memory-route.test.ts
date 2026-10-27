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
  const fixture = createMemoryPage({
    configObject: {},
    agents: [{ id: "main" }, { id: "research" }],
    routeData: memoryRoute("/settings/memory?agent=research"),
    ...params,
  });
  const routeData = expectDefined(fixture.element.routeData, "Missing Memory route fixture");
  return {
    ...fixture,
    routeData,
    mount: () => mountConfigPage(fixture.context, { pageId: "memory", routeData }),
  };
}

it("normalizes a legacy Memory URL again after leaving and reentering Settings", () => {
  const replace = vi.fn();
  const fixture = createRoute({ replace, routeData: memoryRoute("/settings/memory?tab=dreaming") });
  const view = fixture.mount();
  const destination = { pathname: "/settings/memory/dreams", search: "", hash: "" };
  expect(replace).toHaveBeenCalledExactlyOnceWith("memory", destination);
  view.update({ pageId: "advanced", routeData: memoryRoute("/settings/advanced") });
  view.update({ pageId: "memory", routeData: { ...fixture.routeData } });
  expect(replace).toHaveBeenCalledTimes(2);
  expect(replace).toHaveBeenLastCalledWith("memory", destination);
});

it.each([undefined, "main"])(
  "applies URL intent unless superseded by sidebar selection %s before mounting",
  async (sidebar) => {
    const fixture = createRoute();
    if (sidebar) {
      fixture.settingsAgentSelection.set(sidebar);
    }
    const selectedId = sidebar ?? "research";
    fixture.mount();
    await waitForSolid(() =>
      expect(fixture.settingsViews.at(-1)?.snapshot.agentId).toBe(selectedId),
    );
    expect(fixture.settingsAgentSelection.state.selectedId).toBe(selectedId);
    expect(fixture.settingsViews.every((view) => view.snapshot.agentId === selectedId)).toBe(true);
  },
);

it("honors a fresh explicit Memory navigation after the sidebar changed the same URL's agent", async () => {
  const fixture = createRoute();
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
