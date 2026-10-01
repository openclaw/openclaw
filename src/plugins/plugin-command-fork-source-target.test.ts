import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(async (params?: { assertActive?: () => void }) => {
    params?.assertActive?.();
    return {
      agentId: "main",
      canonicalKey: "agent:main:source",
      storePath: "/tmp/fork-source.sqlite",
      storeKeys: ["agent:main:source"],
      store: {
        "agent:main:source": {
          sessionId: "source-session",
          lifecycleRevision: "source-revision",
        },
      },
    };
  }),
}));

vi.mock("../gateway/session-utils-store-worker.js", () => ({
  resolveGatewaySessionStoreTargetInWorker: mocks.resolve,
}));

import { loadPluginForkSourceTarget } from "./plugin-command-fork-source-target.js";

beforeEach(() => mocks.resolve.mockClear());

it("reads persistent fork source metadata through the worker-backed resolver", async () => {
  const assertCurrent = vi.fn();
  const selected = await loadPluginForkSourceTarget({
    config: {},
    agentId: "main",
    sessionKey: "agent:main:source",
    assertCurrent,
  });
  expect(mocks.resolve).toHaveBeenCalledWith({
    cfg: {},
    key: "agent:main:source",
    agentId: "main",
    assertActive: assertCurrent,
  });
  expect(selected.entry).toMatchObject({
    sessionId: "source-session",
    lifecycleRevision: "source-revision",
  });
  expect(assertCurrent).toHaveBeenCalled();
});

it("rechecks owner authority after the awaited metadata read", async () => {
  let current = true;
  mocks.resolve.mockImplementationOnce(async () => {
    current = false;
    return {
      agentId: "main",
      canonicalKey: "agent:main:source",
      storePath: "/tmp/fork-source.sqlite",
      storeKeys: ["agent:main:source"],
      store: {
        "agent:main:source": {
          sessionId: "source-session",
          lifecycleRevision: "source-revision",
        },
      },
    };
  });
  await expect(
    loadPluginForkSourceTarget({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      assertCurrent: () => {
        if (!current) {
          throw new Error("owner revoked");
        }
      },
    }),
  ).rejects.toThrow("owner revoked");
});
