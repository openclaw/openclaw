/* @vitest-environment jsdom */
import { createMemo, createSignal } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ProjectsSearchRemoteResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";
import { resolveProjectChip } from "./project-chip.ts";
import { ProjectChip } from "./project-chip.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

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

function mountSearch() {
  vi.useFakeTimers();
  const fixture = createRepositoryFixture();
  const { browser, state: place, context, gateway, changed } = fixture;
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
  Object.assign(context.gateway.snapshot, {
    hello: {
      ...context.gateway.snapshot.hello,
      features: { methods: ["projects.searchRemote"] },
    },
  });
  vi.spyOn(browser, "projects", "get").mockReturnValue(projects);
  vi.spyOn(browser, "popoverOpen").mockReturnValue(true);
  vi.spyOn(place, "folder", "get").mockReturnValue("");
  vi.spyOn(place, "workspacePath").mockReturnValue("/fixture");
  vi.spyOn(place, "browseAvailable").mockReturnValue(true);
  vi.spyOn(place, "isAdmin").mockReturnValue(true);
  vi.spyOn(place, "canWrite").mockReturnValue(true);
  vi.spyOn(place, "deviceFolderAvailable", "get").mockReturnValue(false);
  browser.selectProject({ kind: "local", id: "sample" });
  onTestFinished(() => browser.disconnect());
  const options: NewSessionPlaceControlsOptions = {
    place,
    gateway,
    context,
    data: undefined,
    submitting: false,
    pendingPlacement: false,
    onConnectMachine: vi.fn(),
    onNavigate: vi.fn(),
    onFocusComposer: vi.fn(),
    onChange: changed,
  };
  const view = mountSolid(() => {
    const [revision, setRevision] = createSignal(0);
    changed.mockImplementation(() => setRevision((value) => value + 1));
    const props = createMemo(() => {
      revision();
      return {
        params: { ...options },
        state: resolveProjectChip({
          folder: "",
          workspace: "/fixture",
          projectId: browser.projectId,
          selectedRemoteProject: browser.remoteProject,
          projects,
          recents: [],
          projectQuery: browser.projectQuery,
        }),
        nativeTerminal: false,
      };
    });
    return <ProjectChip {...props()} />;
  });
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
    const { browser, request, view, input, localRow, typeQuery } = mountSearch();
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
        view.container.querySelector('[data-value="remote-project:example/current"]'),
      ).not.toBeNull(),
    );

    request.mockRejectedValueOnce(new Error("Remote search unavailable"));
    typeQuery("failed");
    expect(
      view.container.querySelector('[data-value="remote-project:example/current"]'),
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
        view.container.querySelector('[data-value="remote-project:example/recovered"]'),
      ).not.toBeNull(),
    );
    expect(view.container.querySelector('input[type="search"]')).toBe(input);
    expect(input.value).toBe("recovered");
    expect(document.activeElement).toBe(input);
    expect(view.container.querySelector('[data-value="project:sample"]')).toBe(localRow);
    expect(localRow.getAttribute("aria-pressed")).toBe("true");
    expect(browser.projectId).toBe("sample");
  });

  it.each(["client", "epoch"] as const)(
    "retires the old read when the %s changes without resetting the query",
    async (scope) => {
      const { browser, context, gateway, request, changed, view, input, typeQuery } = mountSearch();
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
