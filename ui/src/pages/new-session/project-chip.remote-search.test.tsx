/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ProjectsSearchRemoteResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";
import { mountProjectChip } from "./project-chip.test-support.tsx";

async function openProjectSearch(container: ParentNode) {
  await waitForSolid(() => expect(container.querySelector(".header-search")).not.toBeNull());
  if (!container.querySelector('input[type="search"]')) {
    container.querySelector<HTMLButtonElement>(".header-search__toggle")?.click();
    flush();
  }
  await waitForSolid(() => expect(container.querySelector('input[type="search"]')).not.toBeNull());
}

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
  const fixture = createRepositoryFixture();
  const { browser, state: place, context, gateway } = fixture;
  const projects = [
    {
      id: "sample",
      displayName: "Current Failed Recovered Scope",
      repoRoot: "/fixture/sample",
      source: "registered" as const,
    },
  ];
  Object.assign(gateway, {
    connected: true,
    client: context.gateway.snapshot.client,
    connectionEpoch: 1,
  });
  const methods = [...(context.gateway.snapshot.hello?.features?.methods ?? [])];
  Object.assign(context.gateway.snapshot, {
    hello: {
      ...context.gateway.snapshot.hello,
      features: { ...context.gateway.snapshot.hello?.features, methods },
    },
  });
  vi.spyOn(browser, "projects", "get").mockReturnValue(projects);
  vi.spyOn(browser, "projectsReady", "get").mockReturnValue(true);
  vi.spyOn(browser, "popoverOpen").mockReturnValue(true);
  vi.spyOn(place, "folder", "get").mockReturnValue("");
  vi.spyOn(place, "workspacePath").mockReturnValue("/fixture");
  vi.spyOn(place, "browseAvailable").mockReturnValue(true);
  vi.spyOn(place, "isAdmin").mockReturnValue(true);
  vi.spyOn(place, "canWrite").mockReturnValue(true);
  vi.spyOn(place, "deviceFolderAvailable", "get").mockReturnValue(false);
  browser.selectProject({ kind: "local", id: "sample" });
  onTestFinished(() => browser.disconnect());
  const view = mountProjectChip(fixture, () => ({
    folder: "",
    workspace: "/fixture",
    projectId: browser.projectId,
    selectedRemoteProject: browser.remoteProject,
    projects,
    recents: [],
    projectQuery: browser.projectQuery,
  }));
  await openProjectSearch(view.container);
  const input = view.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const localRow = view.container.querySelector('[data-value="project:sample"]')!;
  const typeQuery = (query: string) => {
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
  };
  return { ...fixture, view, input, localRow, typeQuery };
}

afterEach(() => vi.useRealTimers());

describe("remote project search slot", () => {
  it("keeps input and local selection live through debounce, loading, failure, and a new query", async () => {
    const { browser, request, view, input, localRow, typeQuery } = await mountSearch();
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
    expect(view.container.querySelector('[data-value="project:sample"]')).toBe(localRow);
    current.resolve(result("current"));
    await waitForSolid(() =>
      expect(
        view.container.querySelector(
          '[data-value="remote-project:fixture/repos:https://github.com/example/current.git"]',
        ),
      ).not.toBeNull(),
    );

    request.mockRejectedValueOnce(new Error("Remote search unavailable"));
    typeQuery("failed");
    expect(
      view.container.querySelector(
        '[data-value="remote-project:fixture/repos:https://github.com/example/current.git"]',
      ),
    ).toBeNull();
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
    await waitForSolid(() =>
      expect(
        view.container.querySelector(
          '[data-value="remote-project:fixture/repos:https://github.com/example/recovered.git"]',
        ),
      ).not.toBeNull(),
    );
    expect(view.container.querySelector('input[type="search"]')).toBe(input);
    expect(input.value).toBe("recovered");
    expect(document.activeElement).toBe(input);
    expect(view.container.querySelector('[data-value="project:sample"]')).toBe(localRow);
    expect(localRow.getAttribute("aria-pressed")).toBe("true");
    expect(browser.projectId).toBe("sample");
  });

  it("renders independent repository sources and retains the source on selection", async () => {
    const { browser, context, request, view, typeQuery } = await mountSearch();
    Object.assign(context, {
      plugins: {
        registryStatus: "complete",
        repositorySources: [
          ...context.plugins.repositorySources,
          {
            pluginId: "forge",
            id: "repositories",
            key: "forge/repositories",
            label: "Example Forge",
            searchMethod: "forge.repositories.search",
          },
        ],
        subscribe: () => () => undefined,
      },
    });
    context.gateway.snapshot.hello!.features!.methods = [
      "fixture.repositories.search",
      "forge.repositories.search",
    ];
    const native = createDeferred<ProjectsSearchRemoteResult>();
    const contributed = createDeferred<ProjectsSearchRemoteResult>();
    request.mockImplementation((method) =>
      method === "forge.repositories.search" ? contributed.promise : native.promise,
    );
    typeQuery("sample");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    contributed.resolve(result("contributed"));
    await waitForSolid(() => expect(view.queryByText("example/contributed")).not.toBeNull());
    expect(view.queryByText("Example Forge")).not.toBeNull();
    // A slow source cannot hide a completed independent source.
    expect(view.queryByText("example/native")).toBeNull();
    native.resolve(result("native"));
    await waitForSolid(() => expect(view.queryByText("example/native")).not.toBeNull());
    view.getByText("example/contributed").click();
    flush();
    expect(browser.remoteProject).toMatchObject({
      sourceId: "forge/repositories",
      identity: "example/contributed",
      cloneUrl: "https://github.com/example/contributed.git",
    });
    expect(browser.repositorySourceStatus).toBeUndefined();
    Object.assign(context.plugins, { repositorySources: [] });
    browser.synchronize();
    expect(browser.repositorySourceStatus).toBe("unavailable");
  });

  it("starts a query typed before its only repository source becomes available", async () => {
    const { browser, context, request, view, typeQuery } = await mountSearch();
    context.gateway.snapshot.hello!.features!.methods = [];
    Object.assign(context, {
      plugins: {
        registryStatus: "pending",
        repositorySources: [],
        subscribe: () => () => undefined,
      },
    });
    typeQuery("available");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(request).not.toHaveBeenCalled();
    Object.assign(context.plugins, {
      registryStatus: "complete",
      repositorySources: [
        {
          pluginId: "forge",
          id: "repositories",
          key: "forge/repositories",
          label: "Example Forge",
          searchMethod: "forge.repositories.search",
        },
      ],
    });
    context.gateway.snapshot.hello!.features!.methods = ["forge.repositories.search"];
    request.mockResolvedValue(result("available"));
    browser.synchronize();
    await waitForSolid(() => expect(view.queryByText("example/available")).not.toBeNull());
    expect(request.mock.calls.filter(([method]) => method === "projects.searchRemote")).toEqual([]);
  });

  it.each(["client", "epoch"] as const)(
    "retires the old read when the %s changes without resetting the query",
    async (scope) => {
      const { browser, context, gateway, request, changed, view, input, typeQuery } =
        await mountSearch();
      const previous = createDeferred<ProjectsSearchRemoteResult>();
      const current = createDeferred<ProjectsSearchRemoteResult>();
      const defaultRequest = request.getMockImplementation()!;
      let searchCount = 0;
      request.mockImplementation((method, params) => {
        if (method === "projects.list") {
          return Promise.resolve({ projects: [] });
        }
        if (method === "fixture.repositories.search") {
          return searchCount++ === 0 ? previous.promise : current.promise;
        }
        return defaultRequest(method, params);
      });
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
      await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
      current.resolve(result("current"));
      await waitForSolid(() =>
        expect(
          view.container.querySelector(
            '[data-value="remote-project:fixture/repos:https://github.com/example/current.git"]',
          ),
        ).not.toBeNull(),
      );
      previous.resolve(result("stale"));
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(
        view.container.querySelector(
          '[data-value="remote-project:fixture/repos:https://github.com/example/stale.git"]',
        ),
      ).toBeNull();
      expect(view.container.querySelector('input[type="search"]')).toBe(input);
      expect(input.value).toBe("scope");
      browser.disconnect();
      changed();
      await waitForSolid(() =>
        expect(
          view.container.querySelector(
            '[data-value="remote-project:fixture/repos:https://github.com/example/current.git"]',
          ),
        ).toBeNull(),
      );
      expect(input.value).toBe("scope");
    },
  );
});
