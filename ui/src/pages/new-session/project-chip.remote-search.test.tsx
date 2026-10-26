/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectsSearchRemoteResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";
import { projectChipFixture, projectChipQueries } from "./project-chip-view.test-support.ts";

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

afterEach(() => vi.useRealTimers());

describe("remote project search slot", () => {
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
