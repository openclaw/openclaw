/** Gateway request surface and bound replies used by the node-host runtime. */
import type { GatewayClientRequestOptions } from "../gateway/client.js";
import type { NodeInvokeRequestPayload } from "./invoke-types.js";

export type NodeHostClient = {
  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T>;
};

export function createNodeInvokeResponder(client: NodeHostClient, frame: NodeInvokeRequestPayload) {
  const send = async (result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  }) => {
    try {
      await client.request("node.invoke.result", {
        id: frame.id,
        nodeId: frame.nodeId,
        ok: result.ok,
        ...(result.payload !== undefined ? { payload: result.payload } : {}),
        ...(typeof result.payloadJSON === "string" ? { payloadJSON: result.payloadJSON } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
    } catch {
      // Node invoke responses are best-effort.
    }
  };
  const error = async (code: string, message: string) =>
    await send({ ok: false, error: { code, message } });
  return {
    send,
    error,
    async json(payload: unknown) {
      await send({ ok: true, payloadJSON: JSON.stringify(payload) });
    },
    async invalid(err: unknown) {
      await error("INVALID_REQUEST", String(err));
    },
  };
}

export type NodeInvokeResponder = ReturnType<typeof createNodeInvokeResponder>;
