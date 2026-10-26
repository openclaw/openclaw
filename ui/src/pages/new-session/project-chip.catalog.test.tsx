import { expect, it } from "vitest";
import type { ProjectsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { projectChipFixture, projectChipQueries } from "./project-chip-view.test-support.ts";

it("keeps project search live through catalog reads and retires invalidated rows", async () => {
  const fixture = projectChipFixture("/home/openclaw/.openclaw/workspace", "projects.list");
  const { browser, changed, request, popoverOpen } = fixture;
  const first = createDeferred<ProjectsListResult>();
  const refreshed = createDeferred<ProjectsListResult>();
  const replacement = createDeferred<ProjectsListResult>();
  request
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => refreshed.promise)
    .mockImplementationOnce(() => replacement.promise);
  popoverOpen.mockReturnValue(false);
  browser.synchronize();
  let nativeTerminal = false;
  const mountPicker = () => fixture.mount(() => nativeTerminal);
  let view = mountPicker();
  let query = projectChipQueries(view);
  expect(query.input()).toBeNull();
  popoverOpen.mockReturnValue(true);
  changed();
  await waitForSolid(() => expect(query.input()).not.toBeNull());
  let input = query.input()!;
  const rows = () => Array.from(view.container.querySelectorAll('[data-value^="project:"]'));
  const type = (value: string) => query.type(value);
  input.focus();
  type("alpha");
  popoverOpen.mockReturnValue(false);
  changed();
  await waitForSolid(() =>
    expect(
      view.container
        .querySelector(".new-session-page__project-popover")
        ?.getAttribute("data-phase"),
    ).toBe("hidden"),
  );
  expect(query.input()).toBe(input);
  popoverOpen.mockReturnValue(true);
  changed();
  await waitForSolid(() =>
    expect(
      view.container
        .querySelector(".new-session-page__project-popover")
        ?.getAttribute("data-phase"),
    ).toBe("open"),
  );
  expect(input.value).toBe("alpha");
  input.focus();
  expect(rows()).toHaveLength(0);
  expect(request).toHaveBeenCalledExactlyOnceWith("projects.list", {});
  const alpha = {
    id: "alpha",
    displayName: "Alpha project",
    repoRoot: "/home/openclaw/.openclaw/projects/alpha",
    originUrl: "https://github.com/openclaw/alpha.git",
    source: "registered" as const,
  };
  const beta = {
    id: "beta",
    displayName: "Beta project",
    repoRoot: "/home/openclaw/.openclaw/projects/beta",
    originUrl: "https://github.com/openclaw/beta.git",
    source: "registered" as const,
  };
  first.resolve({ projects: [alpha, beta] });
  await waitForSolid(() => expect(rows()).toHaveLength(1));
  const alphaRow = rows()[0];
  expect(alphaRow?.textContent).toContain("Alpha project");
  expect(query.input()).toBe(input);
  expect(document.activeElement).toBe(input);
  type("");
  expect(rows()).toHaveLength(2);
  type("  ALPHA  ");
  expect(rows()).toEqual([alphaRow]);
  type("openclaw");
  expect(rows()).toHaveLength(0);
  expect(view.container.querySelector('[data-value="workspace"]')).toBeNull();
  type("worksp");
  expect(view.container.querySelector('[data-value="workspace"]')).not.toBeNull();
  type("alpha");
  expect(rows()).toEqual([alphaRow]);
  const refresh = browser.refreshProjects();
  nativeTerminal = true;
  changed();
  await waitForSolid(() => expect(rows()).toHaveLength(0));
  nativeTerminal = false;
  changed();
  await waitForSolid(() => expect(rows()[0]?.textContent).toContain("Alpha project"));
  expect(query.input()).toBe(input);
  expect(document.activeElement).toBe(input);
  type("beta");
  expect(rows()[0]?.textContent).toContain("Beta project");
  type("alpha");
  expect(rows()[0]?.textContent).toContain("Alpha project");
  expect(document.activeElement).toBe(input);
  view.unmount();
  view = mountPicker();
  query = projectChipQueries(view);
  await waitForSolid(() => expect(query.input()).not.toBeNull());
  input = query.input()!;
  input.focus();
  await waitForSolid(() => expect(rows()[0]?.textContent).toContain("Alpha project"));
  type("beta");
  await waitForSolid(() => expect(rows()[0]?.textContent).toContain("Beta project"));
  type("alpha");
  await waitForSolid(() => expect(rows()[0]?.textContent).toContain("Alpha project"));
  const refreshedAlphaRow = rows()[0];
  refreshed.reject(new Error("Fixture catalog unavailable"));
  await refresh;
  await waitForSolid(() => expect(rows()).toEqual([refreshedAlphaRow]));
  expect(view.container.querySelector(".new-session-page__project-error")).toBeNull();
  const replace = browser.refreshProjects(true);
  await waitForSolid(() => expect(rows()).toHaveLength(0));
  expect(input.value).toBe("alpha");
  expect(document.activeElement).toBe(input);
  replacement.resolve({ projects: [beta] });
  await replace;
  await waitForSolid(() => expect(rows()).toHaveLength(0));
  type("beta");
  await waitForSolid(() => expect(rows()[0]?.textContent).toContain("Beta project"));
  expect(view.container.querySelector('[data-value="project:alpha"]')).toBeNull();
  expect(request).toHaveBeenCalledTimes(3);
});
