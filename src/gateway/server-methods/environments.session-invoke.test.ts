import { beforeEach, expect, it, vi } from "vitest";
import type { NodeInvokeParams, NodeInvokeResult } from "../node-invoke.types.js";
const state = vi.hoisted(() => ({
  active: true,
  controller: new AbortController(),
  pause: undefined as Promise<void> | undefined,
  invoke: vi.fn<(request: NodeInvokeParams) => Promise<NodeInvokeResult>>(),
  respond: vi.fn<(ok: boolean, payload?: unknown, error?: unknown) => void>(),
  release: vi.fn(),
  node: {
    nodeId: "derived-node",
    connId: "connection",
    platform: "linux",
    commands: ["file.fetch", "browser.proxy", "browser.proxy.upload.v1", "computer.resource.fetch"],
  },
}));
vi.mock("./environments.session.js", () => ({
  resolveSessionEnvironmentCaller: async () => ({
    identity: {
      sessionId: "session-owned",
      sessionKey: "agent:main:owned",
      agentId: "main",
      principalId: "guest-owned",
      requiresIsolatedEnvironment: true,
    },
    signal: state.controller.signal,
    assertCurrent: () => {
      if (!state.active) {
        throw new Error("guest revoked");
      }
    },
    release: state.release,
  }),
}));
vi.mock("./environments.session-tool-policy.js", () => ({
  captureSessionEnvironmentToolPolicy: () => ({
    assertAllowed: () => {
      if (!state.active) {
        throw new Error("guest revoked");
      }
    },
  }),
}));
vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: async () => ({ key: "paired-generation" }),
}));
vi.mock("../node-command-policy.js", () => ({
  resolveNodeCommandAllowlist: () => new Set(state.node.commands),
  isNodeCommandAllowed: () => ({ ok: true }),
}));
vi.mock("../upload-policy.js", () => ({ captureGatewayClientUploadCommitGuard: () => () => {} }));
import { environmentsSessionInvokeHandlers } from "./environments.session-invoke.js";
const binding = {
  environmentId: "env-owned",
  ownerEpoch: 3,
  generation: 4,
  sessionId: "session-owned",
  sessionKey: "agent:main:owned",
  agentId: "main",
};
async function call(extra: Record<string, unknown> = {}): Promise<void> {
  const handler = environmentsSessionInvokeHandlers["environments.session.invoke"];
  if (!handler) {
    throw new Error("handler not registered");
  }
  const assertCurrent = () => {
    if (!state.active) {
      throw new Error("guest revoked");
    }
  };
  await Reflect.apply(handler, undefined, [
    {
      params: {
        environmentId: binding.environmentId,
        command: "file.fetch",
        params: { path: "/workspace/result.zip" },
        idempotencyKey: "binary-request",
        ...extra,
      },
      respond: state.respond,
      context: {
        getRuntimeConfig: () => ({}),
        workerEnvironmentService: {
          captureSessionAttachment: () => ({
            binding,
            signal: state.controller.signal,
            assertCurrent,
            touch: async () => {
              assertCurrent();
            },
          }),
          getSessionAttachmentStatus: () => ({
            environment: {
              environmentId: binding.environmentId,
              ownerEpoch: binding.ownerEpoch,
              sharedHost: false,
              state: "ready",
              nodeDeviceId: state.node.nodeId,
            },
          }),
        },
        nodeRegistry: { getForPairingGeneration: () => state.node, invoke: state.invoke },
      },
    },
  ]);
}
beforeEach(() => {
  state.active = true;
  state.pause = undefined;
  state.controller = new AbortController();
  state.respond.mockReset();
  state.release.mockClear();
  state.invoke.mockReset();
  state.invoke.mockImplementation(async (request) => {
    if (state.pause) {
      await state.pause;
    }
    if (!request.isDispatchAuthorized) {
      throw new Error("missing dispatch authority");
    }
    request.isDispatchAuthorized();
    return { ok: true, payload: { ok: true, base64: "AP+A", size: 3 } };
  });
});
it("dispatches to the server-derived node with an exact attachment receipt", async () => {
  await call();
  expect(state.invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      nodeId: "derived-node",
      expectedConnId: "connection",
      expectedPairingGeneration: "paired-generation",
      command: "file.fetch",
    }),
  );
  expect(state.respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      attachment: { environmentId: binding.environmentId, ownerEpoch: 3, generation: 4 },
    }),
  );
});
it("denies another conversation environment before node dispatch", async () => {
  await call({ environmentId: "env-foreign" });
  expect(state.invoke).not.toHaveBeenCalled();
  expect(state.respond.mock.calls[0]?.[0]).toBe(false);
});
it("rejects raw node substitution and unsupported command passthrough", async () => {
  await call({ nodeId: "foreign-node" });
  await call({ command: "system.run" });
  expect(state.invoke).not.toHaveBeenCalled();
});
it.each(["file.fetch", "computer.resource.fetch"])(
  "aborts and fences queued %s work when its guest is revoked",
  async (command) => {
    let resume = () => {};
    state.pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const pending = call({
      command,
      params:
        command === "file.fetch"
          ? { path: "/workspace/result.zip" }
          : { resourceHandle: "openclaw:computer-resource:v1:owned", maxBytes: 4096 },
    });
    await vi.waitFor(() => expect(state.invoke).toHaveBeenCalledOnce());
    const request = state.invoke.mock.calls[0]?.[0];
    state.active = false;
    state.controller.abort();
    if (!request?.signal) {
      throw new Error("missing cancellation signal");
    }
    expect(request.signal.aborted).toBe(true);
    resume();
    await pending;
    expect(state.respond.mock.calls[0]?.[0]).toBe(false);
  },
);

it("fences browser staging from a replaced attachment epoch", async () => {
  await call({ command: "browser.proxy.upload.v1", expectedOwnerEpoch: 2, expectedGeneration: 4 });
  expect(state.invoke).not.toHaveBeenCalled();
  expect(state.respond.mock.calls[0]?.[0]).toBe(false);
});

it("rejects recording resource epoch substitution before node dispatch", async () => {
  await call({
    command: "computer.resource.fetch",
    params: { resourceHandle: "openclaw:computer-resource:v1:owned", maxBytes: 4096 },
    expectedOwnerEpoch: 999,
  });
  expect(state.invoke).not.toHaveBeenCalled();
  expect(state.respond.mock.calls[0]?.[0]).toBe(false);
});
