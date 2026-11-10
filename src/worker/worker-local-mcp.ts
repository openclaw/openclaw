import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { projectMcpCallToolResult } from "../agents/mcp-content.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import type { WorkerLaunchPlan } from "./launch-descriptor.js";
import type { WorkerMcpResult, WorkerProcessMessage } from "./worker-process-protocol.js";

type McpResult = Extract<WorkerMcpResult, { result: unknown }>["result"];
export type WorkerLocalMcpCall = (
  toolId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<McpResult>;

/** Only an admitted tool handle crosses the private, turn-scoped supervisor pipe. */
export function createWorkerLocalMcpClient(
  turnId: string,
  write: (message: WorkerProcessMessage) => Promise<void>,
) {
  const pending = new Map<string, Deferred<McpResult>>();
  const call: WorkerLocalMcpCall = async (toolId, args, signal) => {
    signal?.throwIfAborted();
    if (pending.size >= WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS) {
      throw new Error("Worker MCP tool concurrency limit exceeded");
    }
    const requestId = randomUUID();
    const frame = { type: "mcp-call", turnId, requestId, toolId, arguments: args } as const;
    if (Buffer.byteLength(JSON.stringify(frame)) > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
      throw new Error("Worker MCP arguments exceed the tool payload limit");
    }
    const result = createDeferredCore<McpResult>();
    pending.set(requestId, result);
    const cancel = () => {
      result.reject(signal?.reason);
      void write({ type: "mcp-cancel", turnId, requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      void write(frame).catch(result.reject);
      return await result.promise;
    } finally {
      pending.delete(requestId);
      signal?.removeEventListener("abort", cancel);
    }
  };
  return {
    call,
    receive(frame: WorkerMcpResult) {
      const request = pending.get(frame.requestId);
      if (frame.turnId === turnId && request) {
        if ("error" in frame) {
          request.reject(new Error(frame.error));
        } else {
          request.resolve(frame.result);
        }
      }
    },
    close(this: void) {
      for (const request of pending.values()) {
        request.reject(new Error("Worker MCP turn ended"));
      }
      pending.clear();
    },
  };
}

export function createWorkerLocalMcpTool(
  entry: WorkerToolSurface["tools"][number],
  grants: WorkerLaunchPlan["assignment"]["toolAuthority"]["mcpTools"],
  call: WorkerLocalMcpCall | undefined,
): AnyAgentTool | undefined {
  const mcp = entry.plugin?.mcp;
  if (
    !call ||
    !mcp?.node ||
    mcp.operation !== "tool" ||
    entry.execution !== "placement" ||
    !grants?.some(
      (grant) =>
        grant.id === entry.id && grant.server === mcp.serverName && grant.tool === mcp.toolName,
    )
  ) {
    return undefined;
  }
  return {
    ...entry.definition,
    execute: async (_toolCallId, args, signal) => {
      if (!isRecord(args) || !Value.Check(entry.definition.parameters, args)) {
        throw new Error("Worker MCP tool arguments are invalid");
      }
      const result = await call(entry.id, args, signal);
      return projectMcpCallToolResult(result, { mcpServer: mcp.serverName, mcpTool: mcp.toolName });
    },
  };
}
