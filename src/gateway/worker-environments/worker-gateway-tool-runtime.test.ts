import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it, onTestFinished, vi } from "vitest";
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
import { createSessionsYieldTool } from "../../agents/tools/sessions-yield-tool.js";
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
  turnClaim: null,
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
const preparedTools = (tools: AnyAgentTool[]) => ({ tools, policy, presentation });

function tool(
  name = "remote",
  execute: AnyAgentTool["execute"] = async () => success,
  overrides: Partial<AnyAgentTool> = {},
): AnyAgentTool {
  const parameters = Type.Object({ value: Type.String() }, { additionalProperties: false });
  const result = {
    name,
    label: name,
    description: `Run ${name}`,
    parameters,
    execute,
    ...overrides,
  };
  bindAgentToolExecutionLocation(result, { kind: "gateway" });
  return result;
}

function fixture(tools: AnyAgentTool[], prepare = async () => preparedTools(tools)) {
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
  onTestFinished(() => runtime.close());
  return {
    runtime,
    controller,
    prepareTools,
    revoke: () => {
      current = false;
    },
  };
}

function controlledExecution(reportSteps = false) {
  const entered = createDeferredCore<AbortSignal>();
  const release = createDeferredCore();
  const execute = vi.fn<AnyAgentTool["execute"]>(async (_id, _args, signal, onUpdate) => {
    if (!signal) {
      throw new Error("Fixture requires a call signal");
    }
    entered.resolve(signal);
    if (reportSteps) {
      onUpdate?.({ ...success, details: { step: 1 } });
    }
    await release.promise;
    if (reportSteps) {
      onUpdate?.({ ...success, details: { step: 2 } });
    }
    return success;
  });
  return { entered, release, execute };
}

async function issued(tools: AnyAgentTool[]) {
  const f = fixture(tools);
  const surface = await f.runtime.getSurface(identity);
  const invocation = request(surface);
  const invoke = (
    params = invocation,
    output: Parameters<typeof f.runtime.invoke>[2] = sink,
    signal?: AbortSignal,
  ) => f.runtime.invoke(identity, params, output, signal);
  return { ...f, surface, invocation, invoke };
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
  const { generation } = surface;
  return { generation, toolId: entry.id, toolCallId: call, arguments: { value: "input" } };
}

it("prepares deferred discovery guidance with the model tool projection", async () => {
  const { runtime } = fixture([], async () => ({
    tools: [tool("web_fetch")],
    policy,
    presentation: createToolSurfacePresentationForTest({
      tools: { codeMode: false, toolSearch: { enabled: true, mode: "directory" } },
    }),
  }));
  const projection = await runtime.getPromptProjection(identity);
  expect(projection.tools.map(({ name }) => name)).toEqual([
    "tool_search",
    "tool_describe",
    "dispatch_action",
  ]);
  const guidance = projection.toolSchemaDirectoryPrompt;
  expect(guidance).toContain("Deferred names are not directly callable.");
  expect(guidance).not.toContain("Call a unique deferred tool name directly");
});

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
  const { runtime, prepareTools } = fixture([
    remote,
    placement,
    createSessionsYieldTool({ sessionId: "session" }),
  ]);
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
  expect(surface.tools[2]?.definition).toMatchObject({ name: "sessions_yield", async: false });
  const invocation = request(surface);
  for (const invalid of [
    { ...invocation, generation: "stale" },
    { ...invocation, toolId: "remote" },
    request(surface, "placement", 1),
  ]) {
    await expect(runtime.invoke(identity, invalid, sink)).rejects.toThrow("handle is unavailable");
  }
  for (const argumentsValue of [{ value: 1 }, { value: "input", unexpected: true }]) {
    await expect(
      runtime.invoke(identity, { ...invocation, arguments: argumentsValue }, sink),
    ).rejects.toThrow("arguments are invalid");
  }
  expect(execute).not.toHaveBeenCalled();
  await expect(runtime.invoke(identity, invocation, sink)).resolves.toEqual(success);
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each(["tool count", "definition bytes"] as const)(
  "rejects an oversized issued surface (%s)",
  async (kind) => {
    const tools =
      kind === "tool count"
        ? Array.from({ length: 257 }, (_, index) =>
            tool(`t${index}`, undefined, { description: "", parameters: Type.Object({}) }),
          )
        : [
            tool("remote", undefined, {
              description: "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES + 1),
            }),
          ];
    const { runtime } = fixture(tools);
    await expect(runtime.getSurface(identity)).rejects.toThrow();
  },
);

it.each(["owner", "signal"] as const)(
  "rejects lost %s authority during preparation and later surface reads",
  async (authority) => {
    const prepared = createDeferredCore<ReturnType<typeof preparedTools>>();
    const f = fixture([], () => prepared.promise);
    const surface = f.runtime.getSurface(identity);
    const expected = authority === "owner" ? "turn authority lost" : "turn aborted";
    if (authority === "owner") {
      f.revoke();
    } else {
      f.controller.abort(new Error(expected));
    }
    prepared.resolve(preparedTools([tool()]));
    await expect(surface).rejects.toThrow(expected);
    await expect(f.runtime.getSurface(identity)).rejects.toThrow(expected);
    expect(f.prepareTools).toHaveBeenCalledTimes(1);
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
    const f = await issued([tool("remote", execute)]);
    const invocation = f.invoke();
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
  },
);

it("joins identical active calls and preserves update order despite a disconnected sink", async () => {
  const { entered, release, execute } = controlledExecution(true);
  const { invoke, surface, invocation } = await issued([tool("remote", execute), tool("other")]);
  const first: WorkerGatewayToolUpdateFrame[] = [];
  const second: WorkerGatewayToolUpdateFrame[] = [];
  const result = invoke(invocation, {
    send: (frame) => {
      first.push(frame);
      if (frame.payload.seq === 2) {
        throw new Error("fixture socket disconnected");
      }
    },
  });
  await entered.promise;
  const joined = invoke(invocation, { send: (frame) => second.push(frame) });
  await expect(invoke({ ...invocation, arguments: { value: "changed" } })).rejects.toThrow(
    "different arguments",
  );
  await expect(invoke(request(surface, "call", 1))).rejects.toThrow("different arguments");
  release.resolve();
  await expect(Promise.all([result, joined])).resolves.toEqual([success, success]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(first.map(({ payload }) => payload.seq)).toEqual([1, 2]);
  expect(second.map(({ payload }) => payload.seq)).toEqual([2]);
  expect(first[1]).toEqual(second[0]);
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
  const parallel = tool("parallel", execute, { executionMode: "parallel" });
  const { invoke, surface } = await issued([tool("sequential", execute), parallel]);
  const calls = [...gates.keys()].map((id) =>
    invoke(request(surface, id, id === "sequential" ? 0 : 1)),
  );
  await Promise.all([
    gates.get("parallel-1")!.entered.promise,
    gates.get("parallel-2")!.entered.promise,
  ]);
  await expect(invoke(request(surface, "overflow", 1))).rejects.toThrow("Too many");
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
  await expect(invoke(request(surface, "parallel-1", 1))).resolves.toEqual(success);
  expect(order).toHaveLength(5);
});

it("cancels an active call and close waits for cooperative settlement while fencing queued work", async () => {
  const { entered, release, execute } = controlledExecution();
  const { runtime, surface, invocation, invoke } = await issued([tool("remote", execute)]);
  const active = invoke();
  const signal = await entered.promise;
  const queued = invoke(request(surface, "queued"));
  await runtime.getSurface(identity);
  expect(() => runtime.cancel({ generation: "stale", toolCallId: invocation.toolCallId })).toThrow(
    "generation",
  );
  expect(runtime.cancel(invocation)).toEqual({ cancelled: true });
  expect(signal.aborted).toBe(true);
  expect(runtime.cancel({ generation: surface.generation, toolCallId: "missing" })).toEqual({
    cancelled: false,
  });
  const outcomes = Promise.allSettled([active, queued]);
  const closed = vi.fn();
  const closing = runtime.close().then(closed);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
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
    const { entered, release, execute } = controlledExecution();
    const remote = tool("remote", execute);
    bindAgentToolExecutionLocation(remote, {
      kind: "gateway",
      ...(connectionScoped ? { connectionScoped: true } : { replay: true }),
    });
    const { runtime, invocation, invoke } = await issued([remote]);
    const socket = new AbortController();
    const active = invoke(invocation, sink, socket.signal);
    const callSignal = await entered.promise;
    const joined = invoke();
    await runtime.getSurface(identity);
    if (cancellation === "call") {
      runtime.cancel(invocation);
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
  },
);

it("preserves error text through worker tool execution", async () => {
  const message = "API_TOKEN = computeToken(); Authorization: Bearer sk-fixture1234567890";
  const execute = vi.fn(async () => {
    throw new Error(message);
  });
  const { invoke } = await issued([tool("remote", execute)]);
  const result = await invoke();
  expect(result).toEqual({
    content: [{ type: "text", text: JSON.stringify({ status: "error", error: message }, null, 2) }],
    details: { status: "error", error: message },
  });
  expect(execute).toHaveBeenCalledOnce();
});

it.each([false, true])("bounds result and update control bytes with images=%s", async (image) => {
  const oversized = {
    ...success,
    ...(image
      ? { content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }] }
      : {}),
    details: { data: "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) },
  };
  const { invoke, invocation } = await issued([
    tool("remote", async (_id, _args, _signal, update) => {
      update?.(oversized);
      update?.(success);
      return oversized;
    }),
  ]);
  const updates: WorkerGatewayToolUpdateFrame[] = [];
  const result = await invoke(invocation, {
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
});
