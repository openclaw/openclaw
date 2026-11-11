/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ProjectsSearchRemoteResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";
import { mountProjectChip, openProjectSearch } from "./project-chip.test-support.tsx";

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

async function mountSearch(openSearch = true) {
  vi.useFakeTimers();
  const fixture = createRepositoryFixture();
  const { browser, state: place, context, gateway } = fixture;
  const projects = [
    {
      id: "sample",
      displayName: "Empty Current Registered Missing Failed Recovered Scope",
      repositoryIdentity: "example/registered",
      repoRoot: "/fixture/sample",
      source: "registered" as const,
    },
  ];
  Object.assign(gateway, {
    connected: true,
    client: context.gateway.snapshot.client,
    connectionEpoch: 1,
  });
  Object.assign(context.gateway.snapshot, {
    hello: {
      ...context.gateway.snapshot.hello,
      features: { methods: ["projects.searchRemote", "sessions.create"] },
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
  if (openSearch) {
    await openProjectSearch(view.container);
  } else {
    await waitForSolid(() => expect(view.container.querySelector(".header-search")).not.toBeNull());
  }
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
  it("exposes source choices and search immediately for a small catalog without an empty-query RPC", async () => {
    const { browser, request, view, typeQuery, context, changed } = await mountSearch(false);
    expect(view.container.querySelector('input[type="search"]')).not.toBeNull();
    const search = view.getByRole<HTMLButtonElement>("button", {
      name: "Search GitHub",
      exact: true,
    });
    expect(search.disabled).toBe(true);
    expect(view.getByText("Open project", { exact: true })).not.toBeNull();
    expect(view.getByText("Open a local folder", { exact: true })).not.toBeNull();
    expect(view.getByText("Paste a Git URL, or enter a name to search GitHub.")).not.toBeNull();
    search.click();
    expect(
      request.mock.calls.filter(([method]) => method === "projects.searchRemote"),
    ).toHaveLength(0);
    expect(browser.projectQuery).toBe("");
    typeQuery("x");
    expect(search.disabled).toBe(true);
    typeQuery("example");
    expect(search.disabled).toBe(false);
    expect(view.getByText("Typing filters local projects. Search GitHub for more.")).not.toBeNull();
    expect(view.queryByText("Paste a Git URL, or enter a name to search GitHub.")).toBeNull();
    typeQuery("https://github.com/synthetic/project.git");
    expect(view.queryByRole("button", { name: "Search GitHub", exact: true })).toBeNull();
    expect(view.queryByText("Typing filters local projects. Search GitHub for more.")).toBeNull();
    const cloneRow = view.container.querySelector('[data-value="project-clone-url"]')!;
    expect(cloneRow).not.toBeNull();
    expect(
      view.getByText("Open project", { exact: true }).compareDocumentPosition(cloneRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    typeQuery("");
    Object.assign(context.gateway.snapshot.hello!, {
      auth: { role: "operator", scopes: ["operator.read"] },
    });
    changed();
    await waitForSolid(() =>
      expect(view.queryByRole("button", { name: "Search GitHub", exact: true })).toBeNull(),
    );
    expect(view.queryByText("Paste a Git URL, or enter a name to search GitHub.")).toBeNull();
    expect(
      request.mock.calls.filter(([method]) => method === "projects.searchRemote"),
    ).toHaveLength(0);
  });

  it("keeps input and local selection live through explicit search, loading, empty results, failure, and recovery", async () => {
    const { browser, request, view, input, localRow, typeQuery } = await mountSearch();
    const empty = () => view.queryByText("No additional GitHub repositories", { exact: true });
    input.focus();
    for (const [query, response, expectedRows, missingCredential, priorCalls] of [
      ["empty", { credential: "configured", projects: [] }, [], false, 0],
      [
        "current",
        {
          ...result("current"),
          projects: [...result("current").projects, ...result("registered").projects],
        },
        ["remote-project:example/current"],
        false,
        1,
      ],
      ["registered", result("registered"), [], false, 2],
      ["missing", { credential: "missing", projects: [] }, [], true, 3],
    ] as const) {
      const pending = createDeferred<ProjectsSearchRemoteResult>();
      request.mockReturnValueOnce(pending.promise);
      typeQuery(query);
      expect(empty()).toBeNull();
      expect(view.container.querySelectorAll('[data-value^="remote-project:"]')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
      expect(request).toHaveBeenCalledTimes(priorCalls);
      expect(view.container.querySelector(".new-session-page__project-status")).toBeNull();
      view.getByRole("button", { name: "Search GitHub", exact: true }).click();
      await waitForSolid(() => expect(view.getByRole("status").textContent).toContain("Loading"));
      expect(input.disabled).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(view.container.querySelector('[data-value="project:sample"]')).toBe(localRow);
      pending.resolve({ ...response, projects: [...response.projects] });
      await waitForSolid(() => expect(view.queryByRole("status")).toBeNull());
      expect(Boolean(empty())).toBe(expectedRows.length === 0);
      expect(
        Array.from(view.container.querySelectorAll('[data-value^="remote-project:"]'), (row) =>
          row.getAttribute("data-value"),
        ),
      ).toEqual(expectedRows);
      expect(view.container.textContent?.includes("No GitHub account is configured")).toBe(
        missingCredential,
      );
      expect(view.getByText("Local projects", { exact: true })).not.toBeNull();
      expect(view.container.querySelector('input[type="search"]')).toBe(input);
    }

    request.mockRejectedValueOnce(new Error("Remote search unavailable"));
    typeQuery("failed");
    view.getByRole("button", { name: "Search GitHub", exact: true }).click();
    await waitForSolid(() =>
      expect(view.getByRole("alert").textContent).toBe("Remote search unavailable"),
    );

    const recovered = createDeferred<ProjectsSearchRemoteResult>();
    request.mockReturnValueOnce(recovered.promise);
    typeQuery("recovered");
    expect(view.queryByRole("alert")).toBeNull();
    view.getByRole("button", { name: "Search GitHub", exact: true }).click();
    await waitForSolid(() => expect(view.getByRole("status").textContent).toContain("Loading"));
    recovered.resolve(result("recovered"));
    await waitForSolid(() =>
      expect(
        view.container.querySelector('[data-value="remote-project:example/recovered"]'),
      ).not.toBeNull(),
    );
    expect(view.container.querySelector('input[type="search"]')).toBe(input);
    expect(input.value).toBe("recovered");
    expect(document.activeElement).toBe(input);
    expect(view.container.querySelector('[data-value="project:sample"]')).toBe(localRow);
    expect(localRow.getAttribute("aria-pressed")).toBe("true");
    expect(browser.projectId).toBe("sample");
    typeQuery("absent");
    expect(view.container.querySelector('[data-value="project:sample"]')).toBeNull();
    expect(view.getByText("No local projects match", { exact: true })).not.toBeNull();
  });

  it.each(["client", "epoch"] as const)(
    "retires the old read when the %s changes without resetting the query",
    async (scope) => {
      const { browser, context, gateway, request, changed, view, input, typeQuery } =
        await mountSearch();
      const previous = createDeferred<ProjectsSearchRemoteResult>();
      const current = createDeferred<ProjectsSearchRemoteResult>();
      request.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
      typeQuery("scope");
      view.getByRole("button", { name: "Search GitHub", exact: true }).click();
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
      await waitForSolid(() =>
        expect(
          view.container.querySelector('[data-value="remote-project:example/current"]'),
        ).not.toBeNull(),
      );
      previous.resolve(result("stale"));
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(
        view.container.querySelector('[data-value="remote-project:example/stale"]'),
      ).toBeNull();
      expect(view.container.querySelector('input[type="search"]')).toBe(input);
      expect(input.value).toBe("scope");
      browser.disconnect();
      changed();
      await waitForSolid(() =>
        expect(
          view.container.querySelector('[data-value="remote-project:example/current"]'),
        ).toBeNull(),
      );
      expect(input.value).toBe("scope");
    },
  );
});

it("keeps typing local and searches GitHub only on the native action or Enter", async () => {
  const { request, browser, view, input, typeQuery } = await mountSearch();
  request.mockResolvedValue(result("current"));
  typeQuery("current");
  await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
  expect(request).not.toHaveBeenCalled();
  expect(view.container.querySelector('[data-value="project:sample"]')).not.toBeNull();
  view.getByRole("button", { name: "Search GitHub", exact: true }).click();
  await waitForSolid(() =>
    expect(
      view.container.querySelector('[data-value="remote-project:example/current"]'),
    ).not.toBeNull(),
  );
  typeQuery("another");
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("projects.searchRemote", { query: "another" }),
  );
  typeQuery("https://github.com/example/pasted.git");
  const calls = request.mock.calls.length;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  flush();
  expect(browser.remoteProject?.cloneUrl).toBe("https://github.com/example/pasted.git");
  expect(request).toHaveBeenCalledTimes(calls);
});
