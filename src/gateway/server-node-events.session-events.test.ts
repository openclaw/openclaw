import "./server-node-events.test-support.js";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as runtimeSnapshot from "../config/runtime-snapshot.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";
import type { NodeEventContext, NodeEventHandlerOptions } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";
const { buildNodeEventContext, runtimeMocks } =
  await import("./server-node-events.test-support.js");

const {
  enqueueSystemEventEntry: enqueue,
  captureSessionEventTargetForHost: captureTarget,
  enqueueSessionEventForHost: handoff,
} = runtimeMocks;
const target = (agentId: string, sessionKey: string) => ({
  agentId,
  sessionKey,
  sessionId: `sid-${sessionKey}`,
  generation: "node-event-test-generation",
});

beforeEach(() => {
  enqueue.mockReset().mockImplementation((text: string) => ({ id: "node-event", text }));
  captureTarget
    .mockReset()
    .mockImplementation(async (agentId, sessionKey) => target(agentId, sessionKey));
  handoff.mockClear();
});

function nodeFixture(nodeId: string, overrides: Partial<NodeEventContext> = {}) {
  const ctx = buildNodeEventContext(overrides);
  return (event: string, payload: unknown, opts?: NodeEventHandlerOptions) =>
    handleNodeEvent(ctx, nodeId, { event, payloadJSON: JSON.stringify(payload) }, opts);
}

it("holds an exec notice before target capture can settle its inline invocation", async () => {
  const registry = new NodeRegistry();
  onTestFinished(() => {
    registry.unregister("inline-conn");
  });
  const frames: string[] = [];
  registerNodeSession(
    registry,
    makeClient("inline-conn", "inline-node", frames, { commands: ["system.run"] }),
  );
  const sessionKey = "agent:main:inline";
  const invocation = registry.invoke({
    nodeId: "inline-node",
    command: "system.run",
    timeoutMs: 0,
    params: { runId: "inline-run", sessionKey },
  });
  const request = JSON.parse(frames[0]!).payload;
  const finish = () =>
    registry.handleInvokeResult({
      id: request.id,
      nodeId: "inline-node",
      connId: "inline-conn",
      ok: true,
      payloadJSON: JSON.stringify({ exitCode: 0, stdout: "inline result" }),
    });
  captureTarget.mockImplementationOnce(async () => {
    finish();
    return target("main", sessionKey);
  });
  const emit = nodeFixture("inline-node", {
    authorizeNodeSystemRunEvent: (params) =>
      registry.authorizeSystemRunEventWithState({
        ...params,
        terminal: params.event !== "exec.started",
      }) ?? false,
  });
  await emit(
    "exec.finished",
    { sessionKey, runId: "inline-run", output: "inline result" },
    { connId: "inline-conn" },
  );
  finish();
  await invocation;
  expectNoCalls(captureTarget, enqueue, handoff);
});

it.each([
  { event: "notifications.changed", changed: "connection" },
  { event: "exec.finished", changed: "connection" },
  { event: "notifications.changed", changed: "config" },
  { event: "exec.finished", changed: "config" },
])(
  "does not accept $event after its $changed changes during target capture",
  async ({ event, changed }) => {
    let publication = { revision: 1, fingerprint: "original", sourceFingerprint: null };
    using _ = vi
      .spyOn(runtimeSnapshot, "getRuntimeConfigSnapshotMetadata")
      .mockImplementation(() => publication);
    const capturing = createDeferred();
    const captured = createDeferred<Awaited<ReturnType<typeof captureTarget>>>();
    captureTarget.mockImplementationOnce(async () => {
      capturing.resolve();
      return captured.promise;
    });
    let current = true;
    const emit = nodeFixture("node-capture", { authorizeNodeSystemRunEvent: () => true });
    const sessionKey = "agent:main:capture";
    const request = emit(
      event,
      { sessionKey, change: "posted", key: "capture", runId: "capture", output: "done" },
      {
        isConnectionCurrent: () => true,
        assertSessionEventCurrent: () => {
          if (changed === "connection" && !current) {
            throw new Error("Node event connection changed during preparation");
          }
        },
      },
    );
    await capturing.promise;
    current = false;
    if (changed === "config") {
      publication = { revision: 2, fingerprint: "replacement", sourceFingerprint: null };
    }
    captured.resolve(target("main", sessionKey));
    await expect(request).rejects.toThrow(
      changed === "connection"
        ? "Node event connection changed during preparation"
        : "Node event configuration changed during preparation",
    );
    expectNoCalls(enqueue, handoff);
  },
);

it("keeps the invocation-owned delivery route instead of node payload hints", async () => {
  const deliveryContext = {
    channel: "telegram",
    to: "original-chat",
    accountId: "original-account",
    threadId: "original-topic",
  };
  const emit = nodeFixture("node-route", {
    authorizeNodeSystemRunEvent: () => ({ invocationDeliveryContext: deliveryContext }),
  });
  await emit("exec.finished", {
    sessionKey: "agent:main:route",
    runId: "route-run",
    exitCode: 0,
    output: "done",
    deliveryContext: { channel: "telegram", to: "untrusted-chat" },
  });
  expect(handoff).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    expect.objectContaining({ deliveryContext }),
  );
});
