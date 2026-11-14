// The OpenClaw ID service's owner notices: mailed through Discovery, signed with K_gw, once the
// claw is registered there. The notice module loads only when a notice is sent.
import type { AuthorityEvent } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type { OpenClawIdAuthority } from "./authority.js";
import type { createServiceGatewayKey } from "./service-gateway-key.js";

export function createServiceOwnerNotices(deps: {
  /** The current remote-access lifetime; a stop aborts its notices. */
  signal: () => AbortSignal;
  getConfig: () => GatewayOpenClawIdConfig | undefined;
  getAuthority: () => Promise<OpenClawIdAuthority>;
  gatewayKey: ReturnType<typeof createServiceGatewayKey>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}) {
  return async (events: AuthorityEvent[]) => {
    // The admitting lifetime is captured before any await, so a stop during import ends the notice.
    const signal = deps.signal();
    const { sendOwnerNotices } = await import("./owner-notices.js");
    if (signal.aborted) {
      return;
    }
    await sendOwnerNotices({
      events,
      log: deps.log,
      target: async () => {
        const config = deps.getConfig();
        const record = (await deps.getAuthority()).current();
        if (!config?.discoveryUrl || !record?.discovery.owner_account_id) {
          return undefined;
        }
        const { createDiscoveryClient } = await import("./discovery-client.js");
        const key = await deps.gatewayKey.tryLoad();
        if (signal.aborted || !key.ok) {
          return undefined;
        }
        const { signer } = key;
        return {
          clawId: record.claw_id,
          client: createDiscoveryClient({ baseUrl: config.discoveryUrl, signer, signal }),
        };
      },
    });
  };
}
