import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
  isWorkerGatewayToolFrameWithinBudget,
  WorkerToolSurfaceSchema,
  type WorkerGatewayToolResult,
  type WorkerGatewayToolUpdateFrame,
  type WorkerToolSurface,
} from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { getAgentToolExecutionLocation } from "../../agents/agent-tool-metadata.js";
import { projectAgentToolDefinition } from "../../agents/prepared-tool-surface.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type {
  WorkerGatewayToolRuntime,
  WorkerGatewayToolSink,
} from "./worker-gateway-tool-contract.js";
import {
  boundWorkerToolResult as bounded,
  workerSessionToolErrorResult,
} from "./worker-session-tool-result.js";

/** Retained by the admitted turn owner; neither IDs nor a prepared catalog grant authority. */
export function createWorkerGatewayToolRuntime(params: {
  assertCurrent(): void;
  signal: AbortSignal;
  prepare(identity: WorkerConnectionIdentity): Promise<{
    tools: AnyAgentTool[];
    policy: WorkerToolSurface["policy"];
  }>;
}): WorkerGatewayToolRuntime {
  const generation = randomUUID();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([params.signal, lifetime.signal]);
  const assertCurrent = (callSignal?: AbortSignal) => {
    signal.throwIfAborted();
    params.assertCurrent();
    callSignal?.throwIfAborted();
  };
  let prepared: Promise<WorkerToolSurface> | undefined;
  let issuedTools: Map<string, AnyAgentTool> | undefined;
  const calls = new Map<
    string,
    {
      digest: string;
      controller: AbortController;
      signal: AbortSignal;
      sinks: Set<WorkerGatewayToolSink>;
      result: Promise<WorkerGatewayToolResult>;
    }
  >();
  let sequential: Promise<unknown> = Promise.resolve();
  return {
    async getSurface(identity) {
      assertCurrent();
      const surface = await (prepared ??= params.prepare(identity).then(({ tools, policy }) => {
        assertCurrent();
        const handles = new Map<string, AnyAgentTool>();
        const catalog = {
          generation,
          policy,
          tools: tools.map((tool, index) => {
            const location = getAgentToolExecutionLocation(tool);
            if (!location) {
              throw new Error("Worker tool has no execution owner");
            }
            const id = String(index);
            handles.set(id, tool);
            return {
              id,
              execution: location.kind,
              ...(location.kind === "gateway" && location.replay ? { replay: true as const } : {}),
              ...(location.kind === "gateway" && location.timeout
                ? { timeout: location.timeout }
                : {}),
              definition: projectAgentToolDefinition(tool),
            };
          }),
        };
        if (!Value.Check(WorkerToolSurfaceSchema, catalog)) {
          throw new Error("Worker tool surface is invalid");
        }
        issuedTools = handles;
        return catalog;
      }));
      assertCurrent();
      return surface;
    },
    async invoke(_identity, request, sink, connectionSignal) {
      // Admission issues handles; cancellation must see the call before its first yield.
      assertCurrent();
      const tool = issuedTools?.get(request.toolId);
      const location = tool && getAgentToolExecutionLocation(tool);
      if (request.generation !== generation || !tool || location?.kind !== "gateway") {
        throw new Error("Worker tool handle is unavailable");
      }
      if (!Value.Check(tool.parameters, request.arguments)) {
        throw new Error("Worker tool arguments are invalid");
      }
      const digest = JSON.stringify([request.toolId, request.arguments]);
      const prior = calls.get(request.toolCallId);
      if (prior && prior.digest !== digest) {
        throw new Error("Worker tool call id was reused with different arguments");
      }
      if (prior) {
        prior.sinks.add(sink);
        const result = await prior.result;
        assertCurrent(prior.signal);
        return result;
      }
      if (calls.size >= 4) {
        throw new Error("Too many worker tool operations are already in progress");
      }
      const controller = new AbortController();
      const callSignal = AbortSignal.any([
        signal,
        controller.signal,
        ...(location.connectionScoped && connectionSignal ? [connectionSignal] : []),
      ]);
      const sinks = new Set([sink]);
      let seq = 0;
      const execute = async () => {
        assertCurrent(callSignal);
        try {
          return bounded(
            await tool.execute(request.toolCallId, request.arguments, callSignal, (update) => {
              assertCurrent(callSignal);
              const frame: WorkerGatewayToolUpdateFrame = {
                type: "event",
                event: "worker.gatewayTool.update",
                payload: {
                  generation,
                  toolCallId: request.toolCallId,
                  seq: ++seq,
                  result: bounded(update),
                },
              };
              if (isWorkerGatewayToolFrameWithinBudget(frame, frame.payload.result)) {
                for (const listener of sinks) {
                  try {
                    listener.send(frame);
                  } catch {
                    sinks.delete(listener);
                  }
                }
              }
            }),
          );
        } catch (error) {
          return workerSessionToolErrorResult(error);
        } finally {
          assertCurrent();
        }
      };
      const predecessor =
        tool.executionMode === "parallel"
          ? sequential
          : Promise.allSettled([...calls.values()].map((call) => call.result));
      const result = predecessor.then(execute);
      if (tool.executionMode !== "parallel") {
        sequential = result.catch(() => undefined);
      }
      const call = { digest, controller, signal: callSignal, sinks, result };
      calls.set(request.toolCallId, call);
      try {
        const value = await result;
        assertCurrent(callSignal);
        return value;
      } finally {
        if (calls.get(request.toolCallId) === call) {
          calls.delete(request.toolCallId);
        }
      }
    },
    cancel(request) {
      assertCurrent();
      if (request.generation !== generation) {
        throw new Error("Worker tool generation is unavailable");
      }
      const call = calls.get(request.toolCallId);
      call?.controller.abort(new Error("Worker tool call cancelled"));
      return { cancelled: Boolean(call) };
    },
    abort() {
      lifetime.abort(new Error("Worker tool surface closed"));
    },
    async close() {
      lifetime.abort(new Error("Worker tool surface closed"));
      await Promise.allSettled([...calls.values()].map((call) => call.result));
    },
  };
}
