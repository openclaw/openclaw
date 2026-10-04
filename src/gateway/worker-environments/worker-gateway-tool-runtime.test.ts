import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  isWorkerGatewayToolFrameWithinBudget,
  WorkerToolSurfaceSchema,
  type WorkerGatewayToolInvokeParams,
  type WorkerGatewayToolUpdateFrame,
  type WorkerToolSurface,
} from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { bindAgentToolExecutionLocation } from "../../agents/agent-tool-metadata.js";
import { createToolSurfacePresentationForTest } from "../../agents/tool-surface-plan.test-support.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";

const identity: WorkerConnectionIdentity = {
  environmentId: "environment",
  credentialHash: "credential-hash",
  bundleHash: "a".repeat(64),
  sessionId: "session",
  runId: "run",
  turnClaim: {
    sessionId: "session",
    claimId: "claim",
    runId: "run",
    placementGeneration: 1,
    owner: { kind: "worker", environmentId: "environment", ownerEpoch: 1 },
  },
  ownerEpoch: 1,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-gateway-tools-v1"],
  credentialExpiresAtMs: 1,
};
const policy: WorkerToolSurface["policy"] = {
  workspaceOnly: true,
  readOnly: false,
  applyPatchEnabled: true,
  applyPatchWorkspaceOnly: true,
  imageSanitization: {},
};
const success = { content: [{ type: "text" as const, text: "done" }], details: { status: "ok" } };
const sink = { send: () => {} };
const presentation = createToolSurfacePresentationForTest();

function tool(
  name = "remote",
  execute: AnyAgentTool["execute"] = async () => success,
): AnyAgentTool {
  const result: AnyAgentTool = {
    name,
    label: name,
    description: `Run ${name}`,
    parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    execute,
  };
  bindAgentToolExecutionLocation(result, { kind: "gateway" });
  return result;
}

function fixture(tools: AnyAgentTool[], prepare = async () => ({ tools, policy, presentation })) {
  let current = true;
  const controller = new AbortController();
  const prepareTools = vi.fn(prepare);
  const assertCurrent = vi.fn(() => {
    if (!current) {
      throw new Error("turn authority lost");
    }
  });
  const runtime = createWorkerGatewayToolRuntime({
    assertCurrent,
    signal: controller.signal,
    prepare: prepareTools,
  });
  return {
    runtime,
    controller,
    prepareTools,
    revoke: () => {
      current = false;
    },
  };
}

function request(
  surface: WorkerToolSurface,
  call = "call",
  index = 0,
): WorkerGatewayToolInvokeParams {
  const entry = surface.tools[index];
  if (!entry) {
    throw new Error("Fixture tool is missing");
  }
  return {
    generation: surface.generation,
    toolId: entry.id,
    toolCallId: call,
    arguments: { value: "input" },
  };
}

describe("worker Gateway tool runtime", () => {
  it("issues one finite surface and invokes only an issued Gateway handle with valid arguments", async () => {
    const execute = vi.fn(async () => success);
    const remote = tool("remote", execute);
    remote.outputSchema = Type.Object({ status: Type.String() });
    remote.catalogMode = "direct-only";
    setPluginToolMeta(remote, {
      pluginId: "fixture",
      optional: true,
      replaySafe: true,
      trustedLocalMedia: true,
    });
    bindAgentToolExecutionLocation(remote, {
      kind: "gateway",
      replay: true,
      timeout: { minimumMs: 1000 },
    });
    const placement = tool("read", execute);
    bindAgentToolExecutionLocation(placement, { kind: "placement" });
    const { runtime, prepareTools } = fixture([remote, placement]);
    const surface = await runtime.getSurface(identity);
    expect(Value.Check(WorkerToolSurfaceSchema, surface)).toBe(true);
    expect(await runtime.getSurface(identity)).toEqual(surface);
    expect(prepareTools).toHaveBeenCalledTimes(1);
    expect(surface.tools[0]?.plugin).not.toHaveProperty("trustedLocalMedia");
    expect(getPluginToolMeta(remote)?.trustedLocalMedia).toBe(true);
    expect(surface.tools[0]).toMatchObject({
      execution: "gateway",
      replay: true,
      timeout: { minimumMs: 1000 },
      plugin: { pluginId: "fixture", optional: true, replaySafe: true },
      definition: { outputSchema: remote.outputSchema, catalogMode: "direct-only" },
    });
    const invocation = request(surface);
    for (const invalid of [
      { ...invocation, generation: "stale" },
      { ...invocation, toolId: "remote" },
      request(surface, "placement", 1),
    ]) {
      await expect(runtime.invoke(identity, invalid, sink)).rejects.toThrow(
        "handle is unavailable",
      );
    }
    for (const argumentsValue of [{ value: 1 }, { value: "input", unexpected: true }]) {
      await expect(
        runtime.invoke(identity, { ...invocation, arguments: argumentsValue }, sink),
      ).rejects.toThrow("arguments are invalid");
    }
    expect(execute).not.toHaveBeenCalled();
    await expect(runtime.invoke(identity, invocation, sink)).resolves.toEqual(success);
    expect(execute).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it.each(["tool count", "definition bytes"] as const)(
    "rejects an oversized issued surface (%s)",
    async (kind) => {
      const tools =
        kind === "tool count"
          ? Array.from({ length: 257 }, (_, index) => {
              const entry = tool(`t${index}`);
              entry.description = "";
              entry.parameters = Type.Object({});
              return entry;
            })
          : [tool()];
      if (kind === "definition bytes") {
        tools[0]!.description = "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES + 1);
      }
      const { runtime } = fixture(tools);
      await expect(runtime.getSurface(identity)).rejects.toThrow();
      await runtime.close();
    },
  );

  it.each(["owner", "signal"] as const)(
    "rejects lost %s authority during preparation and later surface reads",
    async (authority) => {
      const prepared = createDeferredCore<{
        tools: AnyAgentTool[];
        policy: WorkerToolSurface["policy"];
        presentation: WorkerToolSurface["presentation"];
      }>();
      const f = fixture([], () => prepared.promise);
      const surface = f.runtime.getSurface(identity);
      const expected = authority === "owner" ? "turn authority lost" : "turn aborted";
      if (authority === "owner") {
        f.revoke();
      } else {
        f.controller.abort(new Error(expected));
      }
      prepared.resolve({ tools: [tool()], policy, presentation });
      await expect(surface).rejects.toThrow(expected);
      await expect(f.runtime.getSurface(identity)).rejects.toThrow(expected);
      expect(f.prepareTools).toHaveBeenCalledTimes(1);
      await f.runtime.close();
    },
  );

  it.each(["before execution", "during execution", "before publication"] as const)(
    "fences calls when authority is lost %s",
    async (stage) => {
      const entered = createDeferredCore();
      const completion = createDeferredCore<typeof success>();
      const execute = vi.fn(() => {
        entered.resolve();
        return completion.promise;
      });
      const f = fixture([tool("remote", execute)]);
      const surface = await f.runtime.getSurface(identity);
      const invocation = f.runtime.invoke(identity, request(surface), sink);
      if (stage !== "before execution") {
        await entered.promise;
      }
      if (stage !== "before publication") {
        f.revoke();
      }
      completion.resolve(success);
      // Let tool settlement run, then revoke before the caller's awaited result resumes.
      if (stage === "before publication") {
        queueMicrotask(f.revoke);
      }
      await expect(invocation).rejects.toThrow("turn authority lost");
      expect(execute).toHaveBeenCalledTimes(stage === "before execution" ? 0 : 1);
      await f.runtime.close();
    },
  );

  it("joins identical active calls and preserves update order despite a disconnected sink", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const execute = vi.fn<AnyAgentTool["execute"]>(async (_id, _args, _signal, onUpdate) => {
      onUpdate?.({ ...success, details: { step: 1 } });
      entered.resolve();
      await release.promise;
      onUpdate?.({ ...success, details: { step: 2 } });
      return success;
    });
    const { runtime } = fixture([tool("remote", execute), tool("other")]);
    const surface = await runtime.getSurface(identity);
    const invocation = request(surface);
    const first: WorkerGatewayToolUpdateFrame[] = [];
    const second: WorkerGatewayToolUpdateFrame[] = [];
    const result = runtime.invoke(identity, invocation, {
      send: (frame) => {
        first.push(frame);
        if (frame.payload.seq === 2) {
          throw new Error("fixture socket disconnected");
        }
      },
    });
    await entered.promise;
    const joined = runtime.invoke(identity, invocation, { send: (frame) => second.push(frame) });
    await expect(
      runtime.invoke(identity, { ...invocation, arguments: { value: "changed" } }, sink),
    ).rejects.toThrow("different arguments");
    await expect(runtime.invoke(identity, request(surface, "call", 1), sink)).rejects.toThrow(
      "different arguments",
    );
    release.resolve();
    await expect(Promise.all([result, joined])).resolves.toEqual([success, success]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.map(({ payload }) => payload.seq)).toEqual([1, 2]);
    expect(second.map(({ payload }) => payload.seq)).toEqual([2]);
    expect(first[1]).toEqual(second[0]);
    await runtime.close();
  });

  it("respects sequential barriers around parallel batches within the four-call bound", async () => {
    const gates = new Map(
      ["parallel-1", "parallel-2", "sequential", "parallel-3"].map(
        (id) => [id, { entered: createDeferredCore(), release: createDeferredCore() }] as const,
      ),
    );
    const order: string[] = [];
    const execute: AnyAgentTool["execute"] = async (id) => {
      const gate = gates.get(id);
      if (!gate) {
        throw new Error("Fixture call gate is missing");
      }
      order.push(id);
      gate.entered.resolve();
      await gate.release.promise;
      return success;
    };
    const parallel = tool("parallel", execute);
    parallel.executionMode = "parallel";
    const { runtime } = fixture([tool("sequential", execute), parallel]);
    const surface = await runtime.getSurface(identity);
    const calls = [
      runtime.invoke(identity, request(surface, "parallel-1", 1), sink),
      runtime.invoke(identity, request(surface, "parallel-2", 1), sink),
      runtime.invoke(identity, request(surface, "sequential"), sink),
      runtime.invoke(identity, request(surface, "parallel-3", 1), sink),
    ];
    await Promise.all([
      gates.get("parallel-1")!.entered.promise,
      gates.get("parallel-2")!.entered.promise,
    ]);
    await expect(runtime.invoke(identity, request(surface, "overflow", 1), sink)).rejects.toThrow(
      "Too many",
    );
    expect(order).toEqual(["parallel-1", "parallel-2"]);
    gates.get("parallel-1")!.release.resolve();
    await calls[0];
    expect(order).toEqual(["parallel-1", "parallel-2"]);
    gates.get("parallel-2")!.release.resolve();
    await gates.get("sequential")!.entered.promise;
    expect(order).toEqual(["parallel-1", "parallel-2", "sequential"]);
    gates.get("sequential")!.release.resolve();
    await gates.get("parallel-3")!.entered.promise;
    expect(order).toEqual(["parallel-1", "parallel-2", "sequential", "parallel-3"]);
    gates.get("parallel-3")!.release.resolve();
    await expect(Promise.all(calls)).resolves.toEqual([success, success, success, success]);
    await expect(
      runtime.invoke(identity, request(surface, "parallel-1", 1), sink),
    ).resolves.toEqual(success);
    expect(order).toHaveLength(5);
    await runtime.close();
  });

  it("cancels an active call and close waits for cooperative settlement while fencing queued work", async () => {
    const entered = createDeferredCore<AbortSignal>();
    const release = createDeferredCore();
    const execute = vi.fn<AnyAgentTool["execute"]>(async (_id, _args, signal) => {
      if (!signal) {
        throw new Error("Fixture needs its call signal");
      }
      entered.resolve(signal);
      await release.promise;
      return success;
    });
    const { runtime } = fixture([tool("remote", execute)]);
    const surface = await runtime.getSurface(identity);
    const invocation = request(surface);
    const active = runtime.invoke(identity, invocation, sink);
    const signal = await entered.promise;
    const queued = runtime.invoke(identity, request(surface, "queued"), sink);
    await runtime.getSurface(identity);
    expect(() =>
      runtime.cancel({ generation: "stale", toolCallId: invocation.toolCallId }),
    ).toThrow("generation");
    expect(runtime.cancel(invocation)).toEqual({ cancelled: true });
    expect(signal.aborted).toBe(true);
    expect(runtime.cancel({ generation: surface.generation, toolCallId: "missing" })).toEqual({
      cancelled: false,
    });
    const outcomes = Promise.allSettled([active, queued]);
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    expect((await outcomes).every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(runtime.getSurface(identity)).rejects.toThrow("surface closed");
  });

  it.each(["call", "socket read", "socket replay"] as const)(
    "fences cancelled calls while retaining socket-independent replays (%s)",
    async (cancellation) => {
      const connectionScoped = cancellation === "socket read";
      const entered = createDeferredCore<AbortSignal>();
      const release = createDeferredCore();
      const remote = tool("remote", async (_id, _args, signal) => {
        if (!signal) {
          throw new Error("Fixture requires a call signal");
        }
        entered.resolve(signal);
        await release.promise;
        return success;
      });
      bindAgentToolExecutionLocation(remote, {
        kind: "gateway",
        ...(connectionScoped ? { connectionScoped: true } : { replay: true }),
      });
      const { runtime } = fixture([remote]);
      const surface = await runtime.getSurface(identity);
      const socket = new AbortController();
      const active = runtime.invoke(identity, request(surface), sink, socket.signal);
      const callSignal = await entered.promise;
      const joined = runtime.invoke(identity, request(surface), sink);
      await runtime.getSurface(identity);
      if (cancellation === "call") {
        runtime.cancel(request(surface));
      } else {
        socket.abort(new Error("socket closed"));
      }
      expect(callSignal.aborted).toBe(cancellation !== "socket replay");
      release.resolve();
      const results = Promise.all([active, joined]);
      if (cancellation !== "socket replay") {
        await expect(results).rejects.toThrow(
          cancellation === "call" ? "cancelled" : "socket closed",
        );
        if (cancellation === "call") {
          await expect(active).rejects.toThrow("cancelled");
        }
      } else {
        await expect(results).resolves.toEqual([success, success]);
      }
      await runtime.close();
    },
  );

  it.each([false, true])("bounds result and update control bytes with images=%s", async (image) => {
    const oversized = {
      ...success,
      ...(image
        ? { content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }] }
        : {}),
      details: { data: "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) },
    };
    const { runtime } = fixture([
      tool("remote", async (_id, _args, _signal, update) => {
        update?.(oversized);
        update?.(success);
        return oversized;
      }),
    ]);
    const surface = await runtime.getSurface(identity);
    const updates: WorkerGatewayToolUpdateFrame[] = [];
    const result = await runtime.invoke(identity, request(surface), {
      send: (frame) => updates.push(frame),
    });
    expect(result).toMatchObject({
      details: { status: "error", error: expect.stringContaining("transport contract") },
    });
    expect(updates.map(({ payload }) => payload.seq)).toEqual([1, 2]);
    expect(updates[0]?.payload.result).toEqual(result);
    expect(updates[1]?.payload.result).toEqual(success);
    for (const frame of updates) {
      expect(isWorkerGatewayToolFrameWithinBudget(frame, frame.payload.result)).toBe(true);
    }
    await runtime.close();
  });
});
