import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { McpElicitationHandler } from "../agents/mcp-client-elicitation.js";
import type { NodeSession } from "./node-session.types.js";

const MAX_PENDING_QUESTIONS_PER_CALL = 4;

const identity = { id: z.string().min(1).max(256), requestId: z.uuid() };
const eventSchema = z.union([
  z.strictObject({ ...identity, params: z.record(z.string(), z.unknown()) }),
  z.strictObject({ ...identity, cancel: z.literal(true) }),
]);

type Grant = {
  node: NodeSession;
  handle: McpElicitationHandler;
  signal: AbortSignal;
  release: () => void;
  questions: Map<string, AbortController>;
};

/** Only the issuer knows the turn's requester. The paired node can name its grant. */
export class NodeMcpElicitationRegistry {
  private readonly grants = new Map<string, Grant>();

  register(params: {
    id: string;
    node: NodeSession;
    signal: AbortSignal;
    handle: McpElicitationHandler;
  }): () => void {
    const { id, node, handle } = params;
    const lifetime = new AbortController();
    const signal = AbortSignal.any(
      [params.signal, node.client.connectionSignal, lifetime.signal].filter((s) => s !== undefined),
    );
    signal.throwIfAborted();
    if (this.grants.has(id)) {
      throw new Error("MCP elicitation grant already registered");
    }
    const release = () => lifetime.abort();
    this.grants.set(id, {
      node,
      // An incoming node event runs outside the tool caller's async context.
      handle: AsyncLocalStorage.bind(handle),
      signal,
      release,
      questions: new Map(),
    });
    signal.addEventListener("abort", () => this.grants.delete(id), { once: true });
    return release;
  }

  retire(node: NodeSession | undefined): void {
    if (!node) {
      return;
    }
    for (const grant of this.grants.values()) {
      if (grant.node === node) {
        grant.release();
      }
    }
  }

  async receive(node: NodeSession, payload: unknown, current: () => Promise<boolean>) {
    const event = eventSchema.safeParse(payload);
    if (!event.success) {
      throw new Error("Invalid MCP elicitation event");
    }
    const { id, requestId } = event.data;
    const grant = this.grants.get(id);
    if (!grant || grant.node !== node) {
      throw new Error("MCP elicitation grant is unavailable");
    }
    if ("cancel" in event.data) {
      grant.questions.get(requestId)?.abort();
      return { action: "cancel" as const };
    }
    if (grant.questions.has(requestId) || grant.questions.size >= MAX_PENDING_QUESTIONS_PER_CALL) {
      throw new Error("MCP elicitation is already pending or at capacity");
    }
    const question = new AbortController();
    // Reserve before checking pairing so a subsequent cancellation reaches this request.
    grant.questions.set(requestId, question);
    const signal = AbortSignal.any([grant.signal, question.signal]);
    try {
      const assertCurrent = async () => {
        if (!(await current())) {
          throw new Error("MCP elicitation authority changed");
        }
        signal.throwIfAborted();
      };
      await assertCurrent();
      const { ElicitRequestParamsSchema } = await import("@modelcontextprotocol/core");
      const parsed = ElicitRequestParamsSchema.safeParse(event.data.params);
      if (!parsed.success) {
        throw new Error("Invalid MCP elicitation parameters");
      }
      signal.throwIfAborted();
      const result = await grant.handle({
        method: "elicitation/create",
        params: parsed.data,
        requestId,
        signal,
      });
      await assertCurrent();
      return result;
    } finally {
      grant.questions.delete(requestId);
    }
  }
}
