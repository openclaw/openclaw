import type { NodePermissionDetails } from "../../packages/gateway-protocol/src/node-permissions.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import type { GatewayClient } from "../gateway/client.js";
import type { NodeInvokeRequestPayload } from "./invoke-types.js";

/** Gateway request surface and bound replies used by the node-host runtime. */
export type NodeHostClient = Pick<GatewayClient, "request"> & {
  readonly serverCapabilities?: ReadonlySet<string>;
};

export function createNodeInvokeResponder(client: NodeHostClient, frame: NodeInvokeRequestPayload) {
  const send = async (result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string; details?: NodePermissionDetails } | null;
  }) => {
    try {
      await client.request("node.invoke.result", {
        id: frame.id,
        nodeId: frame.nodeId,
        ok: result.ok,
        ...(result.payload !== undefined ? { payload: result.payload } : {}),
        ...(typeof result.payloadJSON === "string" ? { payloadJSON: result.payloadJSON } : {}),
        ...(result.error
          ? {
              error: client.serverCapabilities?.has(GATEWAY_SERVER_CAPS.NODE_PERMISSION_ERRORS)
                ? result.error
                : { code: result.error.code, message: result.error.message },
            }
          : {}),
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
