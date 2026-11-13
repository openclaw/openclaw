import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ProjectsSearchRemoteResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";

function remoteSearch() {
  vi.useFakeTimers();
  const fixture = createRepositoryFixture();
  const { gateway, context, browser } = fixture;
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
  onTestFinished(() => browser.disconnect());
  return fixture;
}

const project: ProjectsSearchRemoteResult = {
  credential: "configured",
  projects: [
    {
      name: "current",
      fullName: "example/current",
      cloneUrl: "https://github.com/example/current.git",
      webUrl: "https://github.com/example/current",
      private: false,
    },
  ],
};

afterEach(() => vi.useRealTimers());

describe("remote project search", () => {
  it("keeps the current query's result when the replaced query fails later", async () => {
    const { browser, request } = remoteSearch();
    const previous = createDeferred<ProjectsSearchRemoteResult>();
    const current = createDeferred<ProjectsSearchRemoteResult>();
    request.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);

    browser.changeProjectQuery("previous");
    browser.searchRemoteProjects();
    const previousRead = browser.projectSearchRead!;
    browser.changeProjectQuery("current");
    expect(browser.projectSearchRead).toBeNull();
    // Retirement does not wait for a transport that ignores its AbortSignal.
    await expect(previousRead.completed).resolves.toBeNull();
    browser.searchRemoteProjects();
    const currentRead = browser.projectSearchRead!;
    current.resolve(project);
    await expect(currentRead.completed).resolves.toEqual({ result: project });
    previous.reject(new Error("previous query failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.projectSearchRead).toBe(currentRead);
    await expect(currentRead.completed).resolves.toEqual({ result: project });
  });

  it("records a current failure, recovers on another query, and retires disconnected reads", async () => {
    const { browser, request } = remoteSearch();
    const failure = new Error("remote search unavailable");
    request.mockRejectedValueOnce(failure);
    browser.changeProjectQuery("failed");
    browser.searchRemoteProjects();
    // Closed pickers do not consume the outcome, so failures must not reject here.
    await expect(browser.projectSearchRead!.completed).resolves.toEqual({ error: failure });

    request.mockResolvedValueOnce(project);
    browser.changeProjectQuery("current");
    browser.searchRemoteProjects();
    await expect(browser.projectSearchRead!.completed).resolves.toEqual({ result: project });

    const disconnected = createDeferred<ProjectsSearchRemoteResult>();
    request.mockReturnValueOnce(disconnected.promise);
    browser.changeProjectQuery("disconnected");
    browser.searchRemoteProjects();
    const disconnectedRead = browser.projectSearchRead!;
    browser.disconnect();
    expect(browser.projectSearchRead).toBeNull();
    await expect(disconnectedRead.completed).resolves.toBeNull();
    disconnected.resolve(project);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.projectSearchRead).toBeNull();
  });
});

it("filters typed queries without remote work until an explicit search", async () => {
  const { browser, request } = remoteSearch();
  request.mockResolvedValue(project);
  browser.changeProjectQuery("current");
  await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
  expect(request).not.toHaveBeenCalled();
  expect(browser.projectSearchRead).toBeNull();
  browser.searchRemoteProjects();
  await expect(browser.projectSearchRead!.completed).resolves.toEqual({ result: project });
  expect(request).toHaveBeenCalledExactlyOnceWith("projects.searchRemote", { query: "current" });
});

it("does not submit URL, short, disconnected or read-only remote searches", () => {
  const { browser, request, gateway, context } = remoteSearch();
  for (const query of ["", "x", "https://github.com/example/current.git"]) {
    browser.changeProjectQuery(query);
    browser.searchRemoteProjects();
  }
  browser.changeProjectQuery("current");
  Object.assign(gateway, { connected: false });
  browser.searchRemoteProjects();
  Object.assign(gateway, { connected: true });
  Object.assign(context.gateway.snapshot.hello!, {
    auth: { role: "operator", scopes: ["operator.read"] },
  });
  browser.searchRemoteProjects();
  expect(request).not.toHaveBeenCalled();
  expect(browser.projectSearchRead).toBeNull();
});
