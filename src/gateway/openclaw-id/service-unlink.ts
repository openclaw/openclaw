// "Unlink from OpenClaw ID" (enrollment.md, "Unlinking a claw"; OCF-281): the service half of
// unlinking a claw from its own computer, only over direct loopback. It signs the ClawUnlink with
// K_gw and clears the link, removes everyone, closes their sessions and revokes their tokens,
// restarts remote access without the link (the tunnel child and every tunnel session stop), then
// sends the unlink to Discovery. If Discovery can't be reached the unlink stays pending and the
// pending-unlink sender delivers it later; the claw is unlinked here either way.
import type { AuthorityEvent, Channel } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type { AuthorityRefusal } from "./authority-result.js";
import type { OpenClawIdAuthority } from "./authority.js";
import type { createPendingUnlinkSender } from "./pending-unlink.js";
import type { createServiceGatewayKey } from "./service-gateway-key.js";
import type { OpenClawIdStatus } from "./service-status.js";
import type { OpenClawIdRemovalSummary } from "./service.js";
import type { UnlinkPreview } from "./unlink-operations.js";

/** A committed unlink: what it cut, and whether Discovery has confirmed it yet. */
export type UnlinkResult = {
  ok: true;
  unlinked: true;
  hostname: string;
  removed: UnlinkPreview;
  removal: OpenClawIdRemovalSummary | null;
  /** `confirmed`: Discovery retired the claw. `pending`: sent when Discovery is reachable. */
  discovery: "confirmed" | "pending" | "unconfigured";
  /** A step after the stored unlink failed; the claw stays unlinked here. */
  followUpError?: string;
};

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

const localOnly = () =>
  refusal("not_local_operator", "Unlink only works on the computer that runs this claw");

export function createServiceUnlink(deps: {
  getConfig: () => GatewayOpenClawIdConfig | undefined;
  getAuthority: () => Promise<OpenClawIdAuthority>;
  gatewayKey: ReturnType<typeof createServiceGatewayKey>;
  /** Performs an accepted write's side effects; returns what a removal cut. */
  applyEvents: (events: AuthorityEvent[]) => Promise<OpenClawIdRemovalSummary | undefined>;
  /** Restarts remote access: stops the tunnel child and its sessions, then starts unlinked. */
  restartRemoteAccess: () => Promise<OpenClawIdStatus>;
  /** Whether this Gateway's OpenClaw ID lifetime is on (Labs switch on, not stopped). */
  enabled: () => boolean;
  log: { info: (message: string) => void; warn: (message: string) => void };
}) {
  // Unlinks committed here that Discovery has not confirmed (pending-unlink.ts), loaded on use.
  let pending: ReturnType<typeof createPendingUnlinkSender> | undefined;

  // Sends pending unlinks now; resolves when that attempt ends.
  const sendPending = async () => {
    const owner = await deps.getAuthority();
    if (!deps.enabled()) {
      return;
    }
    if (!pending) {
      if (!owner.current()?.pending_unlinks?.length) {
        return;
      }
      const { createPendingUnlinkSender } = await import("./pending-unlink.js");
      pending ??= createPendingUnlinkSender({
        current: () => owner.current(),
        clear: (statement) => owner.clearPendingUnlink(statement),
        signer: async () => (await deps.gatewayKey.load()).signer,
        log: deps.log,
      });
    }
    await pending.start();
  };

  return {
    /** Sends pending unlinks at start; they carry their own Discovery URL. */
    resume: (): void => {
      void sendPending().catch((error: unknown) =>
        deps.log.warn(`openclaw-id: pending unlink failed: ${String(error)}`),
      );
    },

    /** Stops retrying pending unlinks for this lifetime. */
    stop: (): void => pending?.stop(),

    /** Who and what loses access, for the warning shown before the owner confirms. */
    preview: async (channel: Channel | undefined): Promise<UnlinkPreview | AuthorityRefusal> => {
      if (channel !== "local_operator") {
        return localOnly();
      }
      return await (await deps.getAuthority()).unlinkPreview();
    },

    run: async (channel: Channel | undefined): Promise<UnlinkResult | AuthorityRefusal> => {
      if (channel !== "local_operator") {
        return localOnly();
      }
      const owner = await deps.getAuthority();
      const key = await deps.gatewayKey.tryLoad();
      if (!key.ok) {
        return refusal(
          "keys_refused",
          `this computer's Gateway key can't sign for the claw (${key.refused.reason})`,
        );
      }
      const discoveryUrl = deps.getConfig()?.discoveryUrl;
      const result = await owner.commitUnlink(channel, key.signer, key.pub, discoveryUrl);
      if (!result.ok) {
        return result;
      }
      const committed = {
        ok: true as const,
        unlinked: true as const,
        hostname: result.removed.hostname,
        removed: result.removed,
      };
      let removal: OpenClawIdRemovalSummary | undefined;
      try {
        removal = await deps.applyEvents(result.events);
        await deps.restartRemoteAccess();
        if (discoveryUrl) {
          await sendPending();
        }
      } catch (error) {
        return {
          ...committed,
          removal: removal ?? null,
          discovery: discoveryUrl ? "pending" : "unconfigured",
          followUpError: error instanceof Error ? error.message : String(error),
        };
      }
      const unsent = owner
        .current()
        ?.pending_unlinks?.some((entry) => entry.statement.sig === result.unlink.sig);
      return {
        ...committed,
        removal: removal ?? null,
        discovery: !discoveryUrl ? "unconfigured" : unsent ? "pending" : "confirmed",
      };
    },
  };
}
