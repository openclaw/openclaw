import { SdkHttpError } from "@modelcontextprotocol/client";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Value } from "typebox/value";
import { WORKER_LOCAL_MCP_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS,
  isWorkerFrameWithinBudget,
} from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { redactMcpDiagnosticError } from "../agents/mcp-error.js";
import {
  McpSdkCompatibilityError,
  toLegacyMcpCallToolResult,
} from "../agents/mcp-sdk-compatibility.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../infra/node-commands.js";
import { logDebug } from "../logger.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import type { WorkerMcpResult, WorkerProcessMessage } from "../worker/worker-process-protocol.js";
import { NODE_MCP_ERROR_MAX_CHARS, NodeHostMcpError, type NodeHostMcpManager } from "./mcp.js";

export type NodeWorkerMcpSession = Pick<NodeHostMcpManager, "callMcpTool" | "descriptors"> & {
  signal: AbortSignal;
};
type McpCall = Extract<WorkerProcessMessage, { type: "mcp-call" }>;

function workerMcpErrorMessage(error: unknown): string {
  if (!(error instanceof NodeHostMcpError || error instanceof McpSdkCompatibilityError)) {
    return "Worker MCP call failed";
  }
  // Only the original HTTP error carries the status needed for reauthentication guidance.
  const diagnostic =
    error.code === "MCP_TOOL_ERROR" && error.cause instanceof SdkHttpError
      ? error.cause
      : error.message;
  const message = truncateUtf16Safe(redactMcpDiagnosticError(diagnostic), NODE_MCP_ERROR_MAX_CHARS);
  return `${error.code}: ${message}`;
}

/** A turn keeps the generation it was granted, including across deny then allow. */
export class NodeWorkerMcpPolicy {
  #generation?: AbortController;
  #revoked = AbortSignal.abort();

  get signal(): AbortSignal {
    return this.#generation?.signal ?? this.#revoked;
  }

  sessionForCommand(
    command: string,
    manager?: NodeHostMcpManager,
  ): NodeWorkerMcpSession | undefined {
    if (command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND && manager) {
      return {
        callMcpTool: manager.callMcpTool,
        descriptors: manager.descriptors,
        signal: this.signal,
      };
    }
    return undefined;
  }

  setAllowed(allowed: boolean): void {
    if (allowed) {
      this.#generation ??= new AbortController();
    } else {
      this.#generation?.abort();
      this.#generation = undefined;
    }
  }
}

/** Only handles admitted to this turn can use the node's existing MCP sessions. */
export function createNodeWorkerMcpTurn(
  descriptor: WorkerLaunchDescriptor,
  session?: NodeWorkerMcpSession,
) {
  const { turnId: admittedTurnId, toolAuthority } = descriptor.assignment;
  const handles = toolAuthority.mcpTools;
  if (
    !session ||
    !handles?.length ||
    !descriptor.admission.handshake.protocolFeatures.includes(WORKER_LOCAL_MCP_PROTOCOL_FEATURE)
  ) {
    return undefined;
  }
  const tools = new Map(handles.map((tool) => [tool.id, tool]));
  const lifetime = new AbortController();
  const pending = new Map<string, AbortController>();
  const seen = new Set<string>();
  return {
    async invoke(frame: McpCall, send: (reply: WorkerMcpResult) => Promise<void>): Promise<void> {
      const { turnId, requestId } = frame;
      const reply = { type: "mcp-result", turnId, requestId } as const;
      if (turnId !== admittedTurnId || lifetime.signal.aborted || seen.has(requestId)) {
        return;
      }
      // Exactly-once within this turn, including side-effecting tools. Bound the replay index.
      if (seen.size >= 4096) {
        return send({ ...reply, error: "Worker MCP call limit reached for this turn" });
      }
      seen.add(requestId);
      const tool = tools.get(frame.toolId);
      if (!tool || session.signal.aborted) {
        return send({ ...reply, error: "Worker MCP tool is unavailable for this turn" });
      }
      if (pending.size >= WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS) {
        return send({ ...reply, error: "Worker MCP concurrency limit reached" });
      }
      const controller = new AbortController();
      pending.set(requestId, controller);
      let response: WorkerMcpResult;
      try {
        const toolDescriptor = session.descriptors.find(
          ({ mcp }) => mcp?.server === tool.server && mcp.tool === tool.tool,
        );
        if (
          !toolDescriptor?.parameters ||
          !Value.Check(toolDescriptor.parameters, frame.arguments)
        ) {
          response = { ...reply, error: "Worker MCP tool arguments or descriptor are invalid" };
        } else {
          logDebug(`node-host: invoking local MCP tool ${tool.id} on turn ${turnId}`);
          const raw = toLegacyMcpCallToolResult(
            await session.callMcpTool({
              server: tool.server,
              tool: tool.tool,
              ...(tool.allowElicitation === true && { elicitationId: tool.id }),
              arguments: frame.arguments,
              signal: AbortSignal.any([lifetime.signal, session.signal, controller.signal]),
            }),
          );
          // Only forward the MCP fields consumed by the model and its Code Mode guest.
          const result = {
            content: raw.content,
            ...(raw.structuredContent !== undefined && {
              structuredContent: raw.structuredContent,
            }),
            ...(raw.isError !== undefined && { isError: raw.isError }),
          };
          response = { ...reply, result };
          if (
            !isWorkerFrameWithinBudget(response, () =>
              raw.content.flatMap((block) => (block.type === "image" ? [block.data] : [])),
            )
          ) {
            response = { ...reply, error: "Worker MCP result exceeds the size limit" };
          }
        }
      } catch (error) {
        response = { ...reply, error: workerMcpErrorMessage(error) };
      } finally {
        pending.delete(requestId);
      }
      if (!lifetime.signal.aborted && !controller.signal.aborted) {
        await send(
          session.signal.aborted
            ? { ...reply, error: "Worker MCP admission was revoked" }
            : response,
        );
      }
    },
    cancel(requestId: string) {
      pending.get(requestId)?.abort();
    },
    close() {
      lifetime.abort();
    },
  };
}
