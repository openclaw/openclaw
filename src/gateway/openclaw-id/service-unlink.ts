// "Unlink from OpenClaw ID" (enrollment.md, "Unlinking a claw"; OCF-281): the service half of
// unlinking a claw from its own computer, only over direct loopback. It signs the ClawUnlink with
// K_gw and clears the link and every membership record, then, each independently of the others'
// failure: sends the unlink to Discovery, closes everyone's sessions and revokes their tokens,
// and restarts remote access without the link (the tunnel child and every tunnel session stop).
// The Discovery send starts first and runs alongside the teardown, so a browser that re-checks
// Discovery when its tunnel closes usually already finds the claw unlinked. If Discovery can't
// be reached the unlink stays pending and the pending-unlink sender delivers it later; the claw
// is unlinked here either way. A claw no registration was ever sent for is unlinked here only.
import type {
  AuthorityEvent,
  Channel,
  SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type { AuthorityRefusal } from "./authority-result.js";
import type { OpenClawIdAuthority } from "./authority.js";
import type { createPendingUnlinkSender } from "./pending-unlink.js";
import type { createServiceGatewayKey } from "./service-gateway-key.js";
import type { OpenClawIdStatus } from "./service-status.js";
import { pendingUnlinkHosts, type UnlinkPreview } from "./unlink-operations.js";

/** A committed unlink: what it cut (`Removal`, the service's removal summary), and what Discovery said. */
export type UnlinkResult<Removal = unknown> = {
  ok: true;
  unlinked: true;
  hostname: string;
  removed: UnlinkPreview;
  removal: Removal | null;
  /**
   * `confirmed`: Discovery retired the claw. `pending`: sent when Discovery is reachable.
   * `refused`: Discovery refused it (`discoveryCode`); the address was not retired.
   * `local_only`: no registration was ever sent, so Discovery never had the claw to retire.
   */
  discovery: "confirmed" | "local_only" | "pending" | "refused" | "unconfigured";
  discoveryCode?: string;
  /** Steps after the stored unlink that failed; the claw stays unlinked here. */
  followUpError?: string;
};

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

const localOnly = () =>
  refusal("not_local_operator", "Unlink only works on the computer that runs this claw");

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createServiceUnlink<Removal>(deps: {
  getConfig: () => GatewayOpenClawIdConfig | undefined;
  getAuthority: () => Promise<OpenClawIdAuthority>;
  gatewayKey: ReturnType<typeof createServiceGatewayKey>;
  /** Performs an accepted write's side effects; returns what a removal cut. */
  applyEvents: (events: AuthorityEvent[]) => Promise<Removal | undefined>;
  /** Restarts remote access: stops the tunnel child and its sessions, then starts unlinked. */
  restartRemoteAccess: () => Promise<OpenClawIdStatus>;
  /** Whether this Gateway's OpenClaw ID lifetime is on (Labs switch on, not stopped). */
  enabled: () => boolean;
  log: { info: (message: string) => void; warn: (message: string) => void };
}) {
  // Unlinks committed here that Discovery has not confirmed (pending-unlink.ts), loaded on use.
  let sender: ReturnType<typeof createPendingUnlinkSender> | undefined;

  // Resumes lifecycle delivery, or sends one newly committed unlink without waiting on older ones.
  const sendPending = async (flushed?: SignedStatement<"ClawUnlink">) => {
    const owner = await deps.getAuthority();
    if (!deps.enabled() || (!sender && !owner.current()?.pending_unlinks?.length)) {
      return;
    }
    if (!sender) {
      const { createPendingUnlinkSender } = await import("./pending-unlink.js");
      sender ??= createPendingUnlinkSender({
        current: () => owner.current(),
        settle: (statement, outcome) => owner.settlePendingUnlink(statement, outcome),
        signer: async () => (await deps.gatewayKey.load()).signer,
        log: deps.log,
      });
    }
    // A stop during the import leaves the sender idle.
    if (deps.enabled()) {
      await (flushed ? sender.flush(flushed) : sender.start());
    }
  };

  return {
    /** Sends pending unlinks at start; they carry their own Discovery URL. */
    resume: (): void => {
      void sendPending().catch((error: unknown) =>
        deps.log.warn(`openclaw-id: pending unlink failed: ${message(error)}`),
      );
    },

    /** Unlinked claws Discovery has not confirmed, for the link summary. */
    pendingHosts: pendingUnlinkHosts,

    /** Stops retrying pending unlinks for this lifetime. */
    stop: (): void => sender?.stop(),

    /** Who and what loses access, for the warning shown before the owner confirms. */
    preview: async (channel: Channel | undefined): Promise<UnlinkPreview | AuthorityRefusal> => {
      if (channel !== "local_operator") {
        return localOnly();
      }
      return await (await deps.getAuthority()).unlinkPreview();
    },

    /** Unlinks `clawId`, the claw whose warning the owner confirmed. */
    run: async (
      channel: Channel | undefined,
      clawId: unknown,
    ): Promise<UnlinkResult<Removal> | AuthorityRefusal> => {
      if (channel !== "local_operator") {
        return localOnly();
      }
      if (typeof clawId !== "string" || !/^[0-9a-f]{32}$/.test(clawId)) {
        return refusal("malformed", "clawId from the unlink warning is required");
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
      const result = await owner.commitUnlink(channel, clawId, key.signer, key.pub, discoveryUrl);
      if (!result.ok) {
        return result;
      }
      const failures: string[] = [];
      const attempt = async <T>(step: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await step();
        } catch (error) {
          failures.push(message(error));
          return undefined;
        }
      };
      const sent = discoveryUrl ? attempt(() => sendPending(result.unlink)) : Promise.resolve();
      const removal = await attempt(() => deps.applyEvents(result.events));
      await attempt(deps.restartRemoteAccess);
      await sent;
      const entry = owner
        .current()
        ?.pending_unlinks?.find((pending) => pending.statement.sig === result.unlink.sig);
      return {
        ok: true,
        unlinked: true,
        hostname: result.removed.hostname,
        removed: result.removed,
        removal: removal ?? null,
        ...(!discoveryUrl
          ? { discovery: "unconfigured" as const }
          : result.neverRegistered
            ? { discovery: "local_only" as const }
            : !entry
              ? { discovery: "confirmed" as const }
              : entry.refused
                ? { discovery: "refused" as const, discoveryCode: entry.refused }
                : { discovery: "pending" as const }),
        ...(failures.length ? { followUpError: failures.join("; ") } : {}),
      };
    },
  };
}
