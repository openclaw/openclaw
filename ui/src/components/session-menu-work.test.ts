import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";
import { isLoopbackHostname } from "../lib/gateway-locality.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";
import { fetchSessionMenuWork } from "./session-menu-work.ts";

const pullRequest: ControlUiSessionPullRequest = {
  number: 1,
  owner: "openclaw",
  repo: "openclaw",
  branch: "feature/demo",
  title: "Demo",
  url: "https://example.test/pr",
  state: "open",
};
const snapshot = { pullRequests: [pullRequest], rateLimited: false, status: "ready" as const };
const noWork = { pullRequestUrl: null, worktreePath: null };

function loadWork(
  request: GatewayRequestHandler,
  options: Omit<Parameters<typeof fetchSessionMenuWork>[0], "client" | "worktreeId"> = {},
) {
  return fetchSessionMenuWork({
    client: createTestGatewayClient(request),
    worktreeId: "wt-1",
    ...options,
  });
}

afterEach(clearNativeGatewayTestState);

it.each([
  ["127.0.0.5", true],
  ["[::1]", true],
  ["127.0.0.1.evil.com", false],
])("classifies %s as loopback: %s", (hostname, expected) => {
  expect(isLoopbackHostname(hostname)).toBe(expected);
});

it.each([
  [null, undefined, null],
  ["local", undefined, "/work/trees/demo"],
  ["remote", undefined, null],
  ["local", "build-mac", null],
] as const)(
  "exposes editor paths only for native-local files: %s / %s",
  async (nativeGateway, execNode, expectedPath) => {
    setNativeGatewayTestState(nativeGateway);
    const request = vi.fn(async () => ({ worktrees: [{ id: "wt-1", path: "/work/trees/demo" }] }));
    await expect(
      loadWork(request, {
        loadPullRequests: async () => snapshot,
        execNode,
      }),
    ).resolves.toEqual({
      pullRequestUrl: "https://example.test/pr",
      worktreePath: expectedPath,
    });
    expect(request).toHaveBeenCalledTimes(expectedPath ? 1 : 0);
  },
);

it("returns nulls when the PR surface is absent, the worktree is removed, or requests fail", async () => {
  setNativeGatewayTestState("local");
  const failing = vi.fn(() => Promise.reject(new Error("offline")));
  await expect(loadWork(failing, { loadPullRequests: failing })).resolves.toEqual(noWork);

  const request = vi.fn(async () => ({ worktrees: [{ id: "wt-1", path: "/gone", removedAt: 5 }] }));
  await expect(loadWork(request)).resolves.toEqual(noWork);
  expect(request.mock.calls).toEqual([["worktrees.list", {}]]);
});
