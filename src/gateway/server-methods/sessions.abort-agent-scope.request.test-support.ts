// Session-method invocation for the agent-scope suite; context-only fixtures stay runtime-free.
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import { sessionCompactHandlers } from "./sessions-compact.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { sessionReadHandlers } from "./sessions-read.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const sessionHandlers = {
  ...sessionAbortHandlers,
  ...sessionCompactHandlers,
  ...sessionDeleteHandlers,
  ...sessionMutationHandlers,
  ...sessionReadHandlers,
  ...sessionSubscriptionHandlers,
};

export async function callSessions(
  method: keyof typeof sessionHandlers & string,
  params: Record<string, unknown>,
  options: {
    context: GatewayRequestContext;
    respond?: RespondFn;
    reqId?: string;
    client?: GatewayClient | null;
  },
): Promise<RespondFn> {
  const respond = options.respond ?? vi.fn<RespondFn>();
  await expectDefined(
    sessionHandlers[method],
    "sessionHandlers[method] test invariant",
  )({
    req: { type: "req", id: options.reqId ?? `req-${method}`, method },
    params,
    respond,
    context: options.context,
    client: options.client ?? null,
    isWebchatConnect: () => false,
  });
  await flushPendingSessionsChangedEvents(options.context);
  return respond;
}
