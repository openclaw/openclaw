import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
  isWorkerGatewayToolFrameWithinBudget,
  WorkerToolSurfaceSchema,
  type WorkerGatewayToolResult,
  type WorkerGatewayToolUpdateFrame,
  type WorkerToolSurface,
} from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS } from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { getAgentToolExecutionLocation } from "../../agents/agent-tool-metadata.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../agents/harness/tool-surface-bridge.js";
import { projectAgentToolDefinition } from "../../agents/prepared-tool-surface.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tool-metadata.js";
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
    presentation: WorkerToolSurface["presentation"];
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
  let modelTools: Awaited<ReturnType<WorkerGatewayToolRuntime["getPromptProjection"]>> | undefined;
  let issuedTools: Map<string, AnyAgentTool> | undefined;
  let preparedSurface: WorkerToolSurface | undefined;
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
    applyPromptToolsAllow(toolsAllow) {
      assertCurrent();
      const handles = issuedTools;
      if (!handles || !preparedSurface) {
        throw new Error("Worker tools have not been prepared");
      }
      if (toolsAllow === undefined) {
        return [...handles.values()].map((tool) => tool.name);
      }
      const allowed = new Set(
        applyEmbeddedAttemptToolsAllow([...handles.values()], toolsAllow).map((tool) => tool.name),
      );
      for (const [id, tool] of handles) {
        if (!allowed.has(tool.name)) {
          handles.delete(id);
        }
      }
      preparedSurface.tools = preparedSurface.tools.filter((tool) => handles.has(tool.id));
      modelTools = undefined;
      return [...allowed];
    },
    async getSurface(identity) {
      assertCurrent();
      const surface = await (prepared ??= params
        .prepare(identity)
        .then(({ tools, policy, presentation }) => {
          assertCurrent();
          const handles = new Map<string, AnyAgentTool>();
          const catalog = {
            generation,
            policy,
            presentation,
            tools: tools.map((tool, index) => {
              const location = getAgentToolExecutionLocation(tool);
              const plugin = getPluginToolMeta(tool);
              const id = String(index);
              handles.set(id, tool);
              return {
                id,
                execution: location.kind,
                plugin: plugin
                  ? Value.Clean(
                      WorkerToolSurfaceSchema.properties.tools.items.properties.plugin,
                      structuredClone(plugin),
                    )
                  : undefined,
                ...(location.kind === "gateway" && location.replay
                  ? { replay: true as const }
                  : {}),
                ...(location.kind === "gateway" && location.timeout
                  ? { timeout: location.timeout }
                  : {}),
                definition: {
                  ...projectAgentToolDefinition(tool),
                  outputSchema: tool.outputSchema,
                  catalogMode: tool.catalogMode,
                },
              };
            }),
          };
          if (!Value.Check(WorkerToolSurfaceSchema, catalog)) {
            throw new Error("Worker tool surface is invalid");
          }
          issuedTools = handles;
          preparedSurface = catalog;
          return catalog;
        }));
      assertCurrent();
      return surface;
    },
    async getPromptProjection(identity) {
      const surface = await this.getSurface(identity);
      assertCurrent();
      if (!modelTools) {
        const runtime = createAgentHarnessToolSurfaceRuntimeCore({
          presentation: surface.presentation,
          supportsDeferredToolCalls: false,
          modelToolsEnabled: surface.tools.length > 0,
          contextTokenBudget: surface.policy.modelContextWindowTokens,
        });
        try {
          const execute: AnyAgentTool["execute"] = () =>
            Promise.reject(new Error("Schema projection cannot execute tools"));
          const tools = surface.tools.map(({ definition, plugin }) => {
            const tool: AnyAgentTool = Object.assign({ execute }, definition);
            if (plugin) {
              setPluginToolMeta(tool, plugin);
            }
            return tool;
          });
          const projected = runtime
            .compactTools(tools, { prepared: { preserveToolNames: [] } })
            .promptToolPolicy.apply();
          modelTools = {
            tools: projected.tools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
            toolSchemaDirectoryPrompt: projected.toolSchemaDirectoryPrompt,
          };
        } finally {
          runtime.cleanup();
        }
      }
      return modelTools;
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
      if (calls.size >= WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS) {
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
      calls.set(request.toolCallId, { digest, controller, signal: callSignal, sinks, result });
      try {
        const value = await result;
        assertCurrent(callSignal);
        return value;
      } finally {
        calls.delete(request.toolCallId);
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
