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
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(browser.projectSearchLoading).toBe(true);
    browser.changeProjectQuery("current");
    expect(browser.projectSearchResult).toBeNull();
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    current.resolve(project);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.projectSearchResult?.projects.map((entry) => entry.fullName)).toEqual([
      "example/current",
    ]);
    previous.reject(new Error("previous query failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.projectSearchLoading).toBe(false);
    expect(browser.projectSearchError).toBeNull();
    expect(browser.projectSearchResult?.projects[0]?.fullName).toBe("example/current");
  });

  it("shows a current failure, recovers on another query, and retires disconnected results", async () => {
    const { browser, request } = remoteSearch();
    request.mockRejectedValueOnce(new Error("remote search unavailable"));
    browser.changeProjectQuery("failed");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(browser.projectSearchLoading).toBe(false);
    expect(browser.projectSearchError).toBe("remote search unavailable");

    request.mockResolvedValueOnce(project);
    browser.changeProjectQuery("current");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(browser.projectSearchError).toBeNull();
    expect(browser.projectSearchResult?.projects[0]?.fullName).toBe("example/current");

    const disconnected = createDeferred<ProjectsSearchRemoteResult>();
    request.mockReturnValueOnce(disconnected.promise);
    browser.changeProjectQuery("disconnected");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    browser.disconnect();
    disconnected.resolve(project);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.projectSearchResult).toBeNull();
    expect(browser.projectSearchError).toBeNull();
    expect(browser.projectSearchLoading).toBe(false);
  });
});
