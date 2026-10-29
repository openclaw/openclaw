import "./server-node-events.test-support.js";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import * as runtimeSnapshot from "../config/runtime-snapshot.js";
import * as pairing from "../infra/device-pairing-node-state.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";
import { nodeInvokeHandlers } from "./server-methods/nodes.invoke.js";
import {
  bindNodeRegistry,
  createNodeInvokeTestHarness,
} from "./server-methods/nodes.invoke.test-support.js";
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

it.each(["live", "revoked", "inline", "unscoped"])(
  "keeps original caller custody and delivery for remote exec: %s",
  async (mode) => {
    const registry = new NodeRegistry();
    onTestFinished(() => {
      registry.unregister("guest-conn");
    });
    const frames: string[] = [];
    const nodeId = "guest-node";
    const sessionKey = mode === "unscoped" ? "agent:main:node" : `agent:main:guest-${mode}`;
    registerNodeSession(
      registry,
      makeClient("guest-conn", nodeId, frames, { commands: ["system.run"] }),
      { pairingGeneration: "guest-generation" },
    );
    using pairingCapture = vi.spyOn(pairing, "captureNodePairingGeneration");
    pairingCapture.mockResolvedValue({ nodeId, key: "guest-generation" });
    using pairingCurrent = vi.spyOn(pairing, "isNodePairingGenerationCurrent");
    pairingCurrent.mockResolvedValue(true);
    let current = true;
    const release = vi.fn();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "original-guest",
      scopes: ["operator.write"],
      gatewayAccessGrant: null,
      assertCurrent: () => {
        if (!current) {
          throw new Error("original guest revoked");
        }
      },
      retain: () => release,
    });
    const producerTarget = {
      ...target("main", sessionKey),
      toolsAllow: ["sessions_spawn"],
      assertCurrent: authority.assertCurrent,
    };
    let finish = () => {};
    captureTarget.mockImplementation(async () => {
      finish();
      return producerTarget;
    });
    const deliveryContext = {
      channel: "telegram",
      to: "original-chat",
      accountId: "original-account",
      threadId: "original-topic",
    };
    const invoke = createNodeInvokeTestHarness({
      nodeHandlers: nodeInvokeHandlers,
      getRuntimeConfig: () => ({
        ...runtimeMocks.getRuntimeConfig(),
        gateway: { nodes: { commands: { allow: ["system.run"] } } },
      }),
    });
    const invocation = invoke({
      nodeRegistry: bindNodeRegistry(registry),
      client: {
        connect: { role: "operator", scopes: ["operator.write"] },
        internal: {
          operatorRunAuthority: authority,
          agentRuntimeIdentity: { kind: "agentRuntime", agentId: "main", sessionKey },
        },
      },
      validateAgentRuntimeApprovalAuthority: () => true,
      requestParams: {
        nodeId,
        command: "system.run",
        params: {
          command: ["true"],
          runId: "guest-run",
          ...(mode !== "unscoped" && { sessionKey }),
        },
        timeoutMs: 0,
        turnSourceChannel: deliveryContext.channel,
        turnSourceTo: deliveryContext.to,
        turnSourceAccountId: deliveryContext.accountId,
        turnSourceThreadId: deliveryContext.threadId,
      },
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    finish = () => {
      registry.handleInvokeResult({
        id: JSON.parse(frames[0]!).payload.id,
        nodeId,
        connId: "guest-conn",
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, stdout: "inline result" }),
      });
    };
    if (mode !== "inline") {
      finish();
    }
    current = mode !== "revoked";
    const emit = nodeFixture(nodeId, {
      authorizeNodeSystemRunEvent: (params) =>
        registry.authorizeSystemRunEventWithState({ ...params, terminal: true }) ?? false,
    });
    const completion = emit(
      "exec.finished",
      {
        sessionKey: mode === "unscoped" ? "node" : sessionKey,
        runId: "guest-run",
        output: "delayed result",
        deliveryContext: { channel: "telegram", to: "untrusted-chat" },
      },
      { connId: "guest-conn" },
    );
    if (mode === "revoked") {
      await expect(completion).rejects.toThrow("original guest revoked");
      expectNoCalls(enqueue, handoff);
    } else {
      await completion;
      if (mode === "inline") {
        expectNoCalls(enqueue, handoff);
      } else {
        expect(handoff).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          expect.objectContaining({
            expectedTarget: producerTarget,
            sessionKey,
            deliveryContext: mode === "unscoped" ? undefined : deliveryContext,
          }),
        );
      }
    }
    finish();
    expect((await invocation).mock.calls[0]?.[0]).toBe(true);
    expect(captureTarget).toHaveBeenCalledExactlyOnceWith(
      "main",
      sessionKey,
      expect.objectContaining({ operatorAuthority: authority }),
    );
    expect(release).toHaveBeenCalledOnce();
  },
);

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
