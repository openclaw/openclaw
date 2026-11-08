import { isIrohEndpointKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { OpenClawIdAuthority } from "./authority.js";
import { clawOriginOfRecord, setOpenClawIdClawOriginResolver } from "./claw-origin.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdNodeDescriptionLookup,
  setOpenClawIdTunnelActivityRecorder,
  setOpenClawIdTunnelPrincipalResolver,
} from "./tunnel-principal.js";

/** Publishes local device authority independently of relay or Discovery availability. */
export function createTunnelPrincipalPublisher(params: {
  authority: () => Promise<OpenClawIdAuthority>;
  current: () => OpenClawIdAuthority | undefined;
  enabled: () => boolean;
  warn: (message: string) => void;
}) {
  return {
    publish(): void {
      if (!params.enabled()) {
        return;
      }
      setOpenClawIdTunnelPrincipalResolver(async (peerKey) => {
        const owner = await params.authority();
        if (!params.enabled()) {
          return undefined;
        }
        const principal = await owner.resolvePeer(peerKey);
        if (principal) {
          void owner
            .recordSeen(peerKey)
            .catch((error: unknown) =>
              params.warn(`openclaw-id: could not record device activity: ${String(error)}`),
            );
        }
        return principal;
      });
      setOpenClawIdTunnelPrincipalLookup(
        (peerKey) => (params.enabled() ? params.current()?.currentPeer(peerKey) : undefined),
        async () => {
          if (params.enabled()) {
            await params.authority();
          }
        },
      );
      setOpenClawIdNodeDescriptionLookup((peerKey) =>
        params.enabled() && isIrohEndpointKey(peerKey)
          ? params.current()?.current()?.authority?.nodes[peerKey]?.description
          : undefined,
      );
      setOpenClawIdTunnelActivityRecorder((peerKey) => {
        if (params.enabled()) {
          void params
            .current()
            ?.recordSeen(peerKey)
            .catch((error: unknown) =>
              params.warn(`openclaw-id: could not record device activity: ${String(error)}`),
            );
        }
      });
      setOpenClawIdClawOriginResolver(() =>
        params.enabled() ? clawOriginOfRecord(params.current()?.current()) : undefined,
      );
    },
    stop(): void {
      setOpenClawIdNodeDescriptionLookup(undefined);
      setOpenClawIdTunnelActivityRecorder(undefined);
      setOpenClawIdTunnelPrincipalResolver(undefined);
      setOpenClawIdTunnelPrincipalLookup(undefined);
      setOpenClawIdClawOriginResolver(undefined);
    },
  };
}
