import { Value } from "typebox/value";
import { WORKER_LOCAL_MCP_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS,
  isWorkerFrameWithinBudget,
} from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { logDebug } from "../logger.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import type { WorkerMcpResult, WorkerProcessMessage } from "../worker/worker-process-protocol.js";
import type { NodeHostMcpManager } from "./mcp.js";
import { warnNodeWorkerIdleCleanupFailure } from "./node-worker-output.js";
import type { NodeWorkerRunningChild } from "./node-worker-supervisor-ownership.js";

export type NodeWorkerMcpSession = Pick<NodeHostMcpManager, "callMcpTool" | "descriptors"> & {
  signal: AbortSignal;
};
type McpCall = Extract<WorkerProcessMessage, { type: "mcp-call" }>;

/** A turn keeps the generation it was granted, including across deny then allow. */
export class NodeWorkerMcpPolicy {
  #generation?: AbortController;
  #revoked = AbortSignal.abort();

  get signal(): AbortSignal {
    return this.#generation?.signal ?? this.#revoked;
  }

  session(manager: NodeHostMcpManager | undefined): NodeWorkerMcpSession | undefined {
    if (manager) {
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
          const raw = await session.callMcpTool({
            server: tool.server,
            tool: tool.tool,
            arguments: frame.arguments,
            signal: AbortSignal.any([lifetime.signal, session.signal, controller.signal]),
          });
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
      } catch {
        response = { ...reply, error: "Worker MCP call failed" };
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

/** The stdout reader must stay free to receive cancellations while an MCP call runs. */
export async function handleNodeWorkerMcpMessage({
  active,
  frame,
  isClosed,
  ownsChild,
  sendResult,
  stopChild,
}: {
  active: NodeWorkerRunningChild;
  frame: Extract<WorkerProcessMessage, { type: "mcp-call" | "mcp-cancel" }>;
  isClosed: boolean;
  ownsChild: () => boolean;
  sendResult: (response: WorkerMcpResult) => Promise<void>;
  stopChild: () => Promise<void>;
}): Promise<void> {
  const turn = active.turn;
  if (
    !ownsChild() ||
    !turn ||
    turn.claim.launchId !== frame.turnId ||
    turn.cancelled ||
    turn.settling ||
    active.retiring ||
    active.stopState ||
    isClosed
  ) {
    // A late cancellation from a settled turn must never affect a retained child's next turn.
    return;
  }
  if (!turn.mcp) {
    if (frame.type === "mcp-call") {
      await sendResult({
        type: "mcp-result",
        turnId: frame.turnId,
        requestId: frame.requestId,
        error: "Worker MCP execution is unavailable for this turn",
      });
    }
    return;
  }
  if (frame.type === "mcp-cancel") {
    turn.mcp.cancel(frame.requestId);
  } else {
    void turn.mcp
      .invoke(frame, sendResult)
      .catch(() => {
        if (active.turn === turn && ownsChild()) {
          return stopChild();
        }
      })
      .catch(warnNodeWorkerIdleCleanupFailure);
  }
}
