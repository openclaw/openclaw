import { afterEach, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  validateNodeInvokeProgressParams,
} from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS } from "../infra/node-commands.js";
import type { NodeHostClient } from "../node-host/client.js";
import { createNodeInvokeProgressWriter } from "../node-host/node-invoke-progress.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";
import { unwrapGatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";
import { respondUnavailableOnNodeInvokeErrorWithProvenance } from "./server-methods/nodes.helpers.js";
import type { RespondFn } from "./server-methods/types.js";
import { openOwnedGatewayNodeDuplex } from "./server-plugins-node-runtime.js";

const telemetry = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (name: string) => {
      const log = original.createSubsystemLogger(name);
      return name === "gateway/node-duplex" ? { ...log, info: telemetry.info } : log;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  "quiet",
  "withheld",
  "failed",
  "ignored",
  "queue-blocked",
  "policy",
  "completion",
  "disconnect",
  "cancel",
  "caller",
  "sink",
  "node-private",
  "framing",
] as const)("settles actual heartbeat/registry/duplex owners under %s", async (mode) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  telemetry.info.mockReset();
  const privateText = "synthetic-private-node-error-body";
  const config: OpenClawConfig = { gateway: { nodes: { commands: { allow: ["test.duplex"] } } } };
  const registry = new NodeRegistry({ getConfig: () => config });
  registerNodeSession(registry, makeClient("conn-1", "node-1", [], { commands: ["test.duplex"] }));
  const caller = new AbortController();
  const reply = createDeferred();
  const armed = createDeferred();
  const progressError = vi.fn();
  let invokeId = "";
  let currentCaller = true;
  let currentCompletion = true;
  let deliveryFault = false;
  let writer: ReturnType<typeof createNodeInvokeProgressWriter> | undefined;
  const invoke: Parameters<typeof openOwnedGatewayNodeDuplex>[0]["invokeNode"] = async (
    params,
    stream,
    signal,
  ) => {
    const result = registry.invokeLifecycle({
      ...params,
      onProgress: stream?.onProgress,
      idleTimeoutMs: stream?.idleTimeoutMs,
      signal,
      isDispatchAuthorized: () => currentCompletion && (stream?.isRuntimeCurrent() ?? true),
      onDispatchReady: (id) => {
        invokeId = id;
        stream?.onDispatchReady?.(id);
        armed.resolve();
      },
    });
    await armed.promise;
    const request = vi.fn(async (_method: string, payload: unknown) => {
      if (!validateNodeInvokeProgressParams(payload)) {
        throw new Error("invalid synthetic transport request");
      }
      if (deliveryFault && mode === "failed") {
        throw new Error("synthetic external progress RPC failure");
      }
      if (deliveryFault && mode === "withheld") {
        await reply.promise;
      }
      const accepted = registry.handleInvokeProgress({
        ...payload,
        chunk: deliveryFault && mode === "framing" ? "malformed private frame" : payload.chunk,
        connId: deliveryFault && mode === "ignored" ? "retired-connection" : "conn-1",
      });
      if (deliveryFault && mode === "queue-blocked") {
        await reply.promise;
      }
      return { ok: true, ignored: !accepted };
    });
    // SAFETY: The synthetic RPC leaf implements only the progress acknowledgement;
    // its schema and actual registry owner above decide acceptance, not the mock.
    const client = { request } as NodeHostClient;
    writer = createNodeInvokeProgressWriter({
      client,
      frame: {
        id: invokeId,
        nodeId: "node-1",
        command: "test.duplex",
        paramsJSON: null,
        timeoutMs: 0,
        idempotencyKey: null,
      },
      idleTimeoutMs: NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
      onError: progressError,
    });
    writer.startHeartbeats();
    await writer.write(JSON.stringify({ v: 1, kind: "ready" }));
    const settled = await result;
    let responseError: Parameters<RespondFn>[2];
    const respond: RespondFn = (_ok, _payload, error) => {
      responseError = error;
    };
    if (
      !respondUnavailableOnNodeInvokeErrorWithProvenance(respond, settled, {
        nodeCommandDispatched: true,
      })
    ) {
      return unwrapGatewayMethodDispatchResponse("node.invoke", {
        ok: false,
        error: responseError,
      });
    }
    return settled;
  };
  const channel = await openOwnedGatewayNodeDuplex({
    params: {
      nodeId: "node-1",
      command: "test.duplex",
      timeoutMs: 0,
      assertCurrent: () => {
        if (!currentCaller) {
          throw new Error("synthetic current caller retired");
        }
      },
    },
    invokeNode: invoke,
    context: { nodeRegistry: registry },
    signal: caller.signal,
    assertCurrent: () => {},
  });
  const messages = vi.fn();
  channel.onMessage(messages);
  const settled = vi.fn();
  const outcome = channel.closed.then(
    (value) => {
      settled();
      return { value };
    },
    (error: unknown) => {
      settled();
      return { error };
    },
  );
  try {
    deliveryFault = true;
    if (mode === "sink") {
      telemetry.info.mockImplementation(() => {
        throw new Error(privateText);
      });
    }
    if (mode === "policy") {
      registry.refreshRuntimePolicy({
        gateway: { nodes: { commands: { deny: ["test.duplex"] } } },
      });
    } else if (mode === "completion") {
      currentCompletion = false;
    } else if (mode === "disconnect") {
      registry.unregister("conn-1");
    } else if (mode === "cancel") {
      caller.abort(new Error("synthetic cancellation"));
    } else if (mode === "caller") {
      currentCaller = false;
    }
    await vi.advanceTimersByTimeAsync(NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS + 10_000);
    expect(messages).not.toHaveBeenCalled();
    if (mode === "quiet" || mode === "sink" || mode === "node-private") {
      expect(settled).not.toHaveBeenCalled();
      expect(
        registry.handleInvokeResult({
          id: invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          ok: mode === "quiet",
          ...(mode === "quiet"
            ? {}
            : {
                error: {
                  code: mode === "sink" ? "UNAVAILABLE" : privateText,
                  message: privateText,
                },
              }),
        }),
      ).toBe(true);
      if (mode === "quiet") {
        expect(await outcome).toMatchObject({ value: { ok: true } });
      } else {
        expect(await outcome).toMatchObject({
          error: {
            details: { nodeError: { code: mode === "sink" ? "UNAVAILABLE" : privateText } },
          },
        });
      }
    } else {
      const expectedCode =
        mode === "policy"
          ? "POLICY_CHANGED"
          : mode === "completion"
            ? "APPROVAL_AUTHORITY_CLOSED"
            : mode === "disconnect"
              ? "DISCONNECTED"
              : mode === "cancel" || mode === "caller" || mode === "framing"
                ? "ABORTED"
                : "IDLE_TIMEOUT";
      expect(await outcome).toMatchObject({
        error: {
          gatewayCode: ErrorCodes.UNAVAILABLE,
          details: { nodeError: { code: expectedCode }, nodeCommandDispatched: true },
        },
      });
      expect(settled).toHaveBeenCalledOnce();
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 100,
          chunk: "late",
        }),
      ).toBe(false);
      currentCaller = true;
      currentCompletion = true;
      expect(
        registry.handleInvokeResult({ id: invokeId, nodeId: "node-1", connId: "conn-1", ok: true }),
      ).toBe(false);
    }
    if (mode === "failed") {
      expect(progressError).toHaveBeenCalled();
    }
    const failures = telemetry.info.mock.calls.filter(
      ([message]) => message === "node invoke stream failed",
    );
    if (mode === "quiet") {
      expect(failures).toEqual([]);
    } else {
      const phase =
        mode === "policy"
          ? "policy"
          : mode === "completion"
            ? "completion_authority"
            : mode === "disconnect"
              ? "connection_lost"
              : mode === "cancel" || mode === "caller" || mode === "framing"
                ? "signal"
                : mode === "sink" || mode === "node-private"
                  ? "node_result"
                  : "idle_deadline";
      expect(failures).toHaveLength(1);
      expect(failures[0]?.[1]).toMatchObject({
        nodeId: "node-1",
        invokeId,
        phase,
        receivedProgress: true,
        bufferedProgressCount: 0,
      });
      if (phase === "idle_deadline") {
        expect(failures[0]?.[1]).toMatchObject({
          errorCode: "IDLE_TIMEOUT",
          lastOrderedProgressAgeMs: 30_000,
          idleTimeoutMs: 30_000,
        });
      }
      if (mode === "queue-blocked") {
        expect(failures[0]?.[1].nextProgressSeq).toBe(2);
      }
      if (mode === "withheld") {
        expect(failures[0]?.[1].nextProgressSeq).toBe(1);
      }
      if (mode === "node-private") {
        expect(failures[0]?.[1].errorCode).toBe("unclassified");
      }
      expect(telemetry.info).toHaveBeenCalledWith(
        "node duplex invocation closed",
        expect.objectContaining({ rejectionCategory: "gateway_response" }),
      );
    }
    expect(JSON.stringify(telemetry.info.mock.calls)).not.toContain(privateText);
  } finally {
    writer?.stop();
    reply.resolve();
    await writer?.flush();
    channel.close();
    registry.unregister("conn-1");
    await outcome;
  }
});
