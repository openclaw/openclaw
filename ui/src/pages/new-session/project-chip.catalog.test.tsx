/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  ProjectsListResult,
  ProjectsSearchRemoteResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";
import { mountProjectChip } from "./project-chip.test-support.tsx";

function projectChipFixture(workspace: string, method: string) {
  const fixture = createRepositoryFixture();
  const { browser, state: place, context, gateway } = fixture;
  Object.assign(gateway, {
    connected: true,
    client: context.gateway.snapshot.client,
    connectionEpoch: 1,
  });
  Object.assign(context.gateway.snapshot.hello!, { features: { methods: [method] } });
  const popoverOpen = vi.spyOn(browser, "popoverOpen").mockReturnValue(true);
  vi.spyOn(place, "folder", "get").mockReturnValue("");
  vi.spyOn(place, "workspacePath").mockReturnValue(workspace);
  vi.spyOn(place, "browseAvailable").mockReturnValue(true);
  vi.spyOn(place, "isAdmin").mockReturnValue(true);
  vi.spyOn(place, "canWrite").mockReturnValue(true);
  vi.spyOn(place, "deviceFolderAvailable", "get").mockReturnValue(false);
  onTestFinished(() => browser.disconnect());
  const mount = (nativeTerminal = () => false) =>
    mountProjectChip(
      fixture,
      () => ({
        folder: "",
        workspace,
        projectId: browser.projectId,
        selectedRemoteProject: browser.remoteProject,
        projects: browser.projects,
        recents: [],
        projectQuery: browser.projectQuery,
      }),
      nativeTerminal,
    );
  return { ...fixture, popoverOpen, mount };
}

function projectChipQueries(view: ReturnType<typeof mountProjectChip>) {
  const input = () => view.container.querySelector<HTMLInputElement>('input[type="search"]');
  return {
    input,
    phase: () =>
      view.container
        .querySelector(".new-session-page__project-popover")
        ?.getAttribute("data-phase"),
    remote: (name: string) =>
      view.container.querySelector(`[data-value="remote-project:example/${name}"]`),
    local: () => view.container.querySelector('[data-value="project:sample"]'),
    type(query: string) {
      input()!.value = query;
      input()!.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
    },
  };
}

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
  await waitForSolid(() => expect(query.phase()).toBe("hidden"));
  expect(query.input()).toBe(input);
  popoverOpen.mockReturnValue(true);
  changed();
  await waitForSolid(() => expect(query.phase()).toBe("open"));
  expect(input.value).toBe("alpha");
  input.focus();
  expect(rows()).toHaveLength(0);
  const project = (id: string, displayName: string) => ({
    id,
    displayName,
    repoRoot: `/home/openclaw/.openclaw/projects/${id}`,
    originUrl: `https://github.com/openclaw/${id}.git`,
    source: "registered" as const,
  });
  const alpha = project("alpha", "Alpha project");
  const beta = project("beta", "Beta project");
  first.resolve({ projects: [alpha, beta] });
  await waitForSolid(() => expect(rows()).toHaveLength(1));
  browser.selectProject({ kind: "local", id: alpha.id });
  const alphaRow = rows()[0];
  expect(alphaRow?.textContent).toContain("Alpha project");
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
  expect(browser.selectedProject()).toEqual(alpha);
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
});

function result(name: string): ProjectsSearchRemoteResult {
  return {
    credential: "configured",
    projects: [
      {
        name,
        fullName: `example/${name}`,
        cloneUrl: `https://github.com/example/${name}.git`,
        webUrl: `https://github.com/example/${name}`,
        private: false,
      },
    ],
  };
}

async function mountSearch() {
  vi.useFakeTimers();
  const fixture = projectChipFixture("/fixture", "projects.searchRemote");
  const { browser } = fixture;
  const projects = [
    {
      id: "sample",
      displayName: "Current Failed Recovered Scope",
      repoRoot: "/fixture/sample",
      source: "registered" as const,
    },
  ];
  vi.spyOn(browser, "projects", "get").mockReturnValue(projects);
  vi.spyOn(browser, "projectsReady", "get").mockReturnValue(true);
  browser.selectProject({ kind: "local", id: "sample" });
  const view = fixture.mount();
  const query = projectChipQueries(view);
  await waitForSolid(() => expect(query.input()).not.toBeNull());
  return {
    ...fixture,
    view,
    query,
    input: query.input()!,
    localRow: query.local()!,
    typeQuery: query.type,
  };
}

describe("remote project search slot", () => {
  afterEach(() => vi.useRealTimers());
  it("keeps input and local selection live through debounce, loading, failure, and a new query", async () => {
    const { browser, request, view, query, input, localRow, typeQuery } = await mountSearch();
    const current = createDeferred<ProjectsSearchRemoteResult>();
    request.mockReturnValueOnce(current.promise);
    input.focus();
    typeQuery("current");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS - 1);
    expect(request).not.toHaveBeenCalled();
    expect(view.container.querySelector(".new-session-page__project-status")).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await waitForSolid(() => expect(view.getByRole("status").textContent).toContain("Loading"));
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(query.local()).toBe(localRow);
    current.resolve(result("current"));
    await waitForSolid(() => expect(query.remote("current")).not.toBeNull());

    request.mockRejectedValueOnce(new Error("Remote search unavailable"));
    typeQuery("failed");
    expect(query.remote("current")).toBeNull();
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    await waitForSolid(() =>
      expect(view.getByRole("alert").textContent).toBe("Remote search unavailable"),
    );

    const recovered = createDeferred<ProjectsSearchRemoteResult>();
    request.mockReturnValueOnce(recovered.promise);
    typeQuery("recovered");
    expect(view.queryByRole("alert")).toBeNull();
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    await waitForSolid(() => expect(view.getByRole("status").textContent).toContain("Loading"));
    recovered.resolve(result("recovered"));
    await waitForSolid(() => expect(query.remote("recovered")).not.toBeNull());
    expect(query.input()).toBe(input);
    expect(input.value).toBe("recovered");
    expect(document.activeElement).toBe(input);
    expect(query.local()).toBe(localRow);
    expect(localRow.getAttribute("aria-pressed")).toBe("true");
    expect(browser.projectId).toBe("sample");
  });

  it.each(["client", "epoch"] as const)(
    "retires the old read when the %s changes without resetting the query",
    async (scope) => {
      const { browser, context, gateway, request, changed, view, query, input, typeQuery } =
        await mountSearch();
      const previous = createDeferred<ProjectsSearchRemoteResult>();
      const current = createDeferred<ProjectsSearchRemoteResult>();
      request.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
      typeQuery("scope");
      await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
      await waitForSolid(() => expect(view.queryByRole("status")).not.toBeNull());
      if (scope === "client") {
        const replacement = {
          request: (method: string, params?: Record<string, unknown>) => request(method, params),
        };
        Object.assign(context.gateway.snapshot, { client: replacement });
        Object.assign(gateway, { client: replacement });
      } else {
        Object.assign(gateway, { connectionEpoch: gateway.connectionEpoch + 1 });
      }
      browser.synchronize();
      changed();
      current.resolve(result("current"));
      await waitForSolid(() => expect(query.remote("current")).not.toBeNull());
      previous.resolve(result("stale"));
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(query.remote("stale")).toBeNull();
      expect(query.input()).toBe(input);
      expect(input.value).toBe("scope");
      browser.disconnect();
      changed();
      await waitForSolid(() => expect(query.remote("current")).toBeNull());
      expect(input.value).toBe("scope");
    },
  );
});
