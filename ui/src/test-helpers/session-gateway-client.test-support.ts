import type { TestAPI } from "vitest";
import type { sessionGatewayTest } from "./control-ui-e2e.sessions.test-support.ts";
import { flushMockTimers } from "./mock-gateway-page.test-support.ts";

type Row = Record<string, unknown>;
type Fixtures = typeof sessionGatewayTest extends TestAPI<infer F> ? F : never;
type Connection = Awaited<ReturnType<Fixtures["connect"]>>;

export function sessionClient(connection: Connection, key: string) {
  const { request, controls, send, frames } = connection;
  const payload = async (method: string, params?: Row) => (await request(method, params)).payload;
  return {
    ...connection,
    payload,
    rows: async () => (await payload("sessions.list")).sessions,
    session: async () => (await payload("sessions.describe", { key })).session,
    patch: (params: Row) => request("sessions.patch", { key, ...params }),
    abort: (params: Row = {}) => payload("chat.abort", { sessionKey: key, ...params }),
    transcript: (method = "chat.startup", params: Row = {}) =>
      payload(method, { sessionKey: key, ...params }),
    chatEvents: () =>
      frames.filter((frame) => frame.event === "chat").map((frame) => frame.payload),
    emitChat: (runId: string, state: string, errorMessage?: string) =>
      controls.emit("chat", {
        sessionKey: key,
        runId,
        state,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      }),
    sendChat: (runId: string, message = "Start") =>
      send("chat.send", { sessionKey: key, message, idempotencyKey: runId }),
    resolve: async (method: string, response?: unknown) => {
      controls.resolveDeferred(method, response);
      await flushMockTimers();
    },
  };
}
