import {
  acceptGatewayDeviceSourceAuthority,
  bindGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";

/** Retain the authenticated source at ingress; audio replacement is not revocation. */
export async function retainTalkClientRunAuthority(
  params: Pick<GatewayRequestHandlerOptions, "client" | "context" | "hasCurrentClientAuthority">,
) {
  const captured = await captureGatewayOperatorRunAuthority({
    ...params,
    client: params.client ?? null,
  });
  let releaseDevice: ReturnType<typeof retainGatewayDeviceRevocation>;
  try {
    releaseDevice = retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  } catch (error) {
    captured?.release();
    throw error;
  }
  const sourceCurrent =
    readGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority) ??
    params.hasCurrentClientAuthority;
  const committedSource =
    sourceCurrent && bindGatewayDeviceRevocation(sourceCurrent, params.hasCurrentClientAuthority);
  const client =
    params.client && captured
      ? {
          ...params.client,
          internal: { ...params.client.internal, operatorRunAuthority: captured.authority },
        }
      : params.client;
  let released = false;
  return {
    operatorAuthority: captured?.authority,
    accept() {
      // Retention during provider setup is not acceptance. The logical voice
      // owner calls this only after its final request/target commit checks.
      if (released || params.hasCurrentClientAuthority?.() === false) {
        throw new Error("Talk caller source is no longer current for admission");
      }
      captured?.authority.assertCurrent();
      acceptGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority);
    },
    async retainRun(runId: string) {
      if (released) {
        throw new Error("Talk caller source has closed");
      }
      const retained = await retainGatewayOperatorRun({
        client: client ?? null,
        context: params.context,
        hasCurrentClientAuthority: committedSource,
        runId,
        entry: params.context.chatAbortControllers.get(runId),
      });
      const assertSourceCurrent = () => {
        retained.authority?.assertCurrent();
        if (sourceCurrent?.() === false) {
          throw new Error("Talk caller source authority is no longer active");
        }
      };
      try {
        assertSourceCurrent();
        retained.armCancellation();
        return { ...retained, assertSourceCurrent };
      } catch (error) {
        retained.release();
        throw error;
      }
    },
    release() {
      if (!released) {
        released = true;
        captured?.release();
        releaseDevice?.();
      }
    },
  };
}

export type TalkClientRunAuthority = Awaited<ReturnType<typeof retainTalkClientRunAuthority>>;
