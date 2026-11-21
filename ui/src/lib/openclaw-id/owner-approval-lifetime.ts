// One local SAS reader per admitted Gateway client; no menu-open dependency or refresh timer.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewayPhase } from "../../app/gateway.ts";
import { openClawIdAccount, subscribeOpenClawIdAccount } from "./account.ts";
import { subscribeOwnerDeviceKey } from "./device-key.ts";
import { createOwnerApproval, type OwnerApproval } from "./owner-approval.ts";
import { thisOwnerDevice } from "./owner-devices.ts";
import type { OpenClawIdPeopleLink, OpenClawIdStatusResult } from "./types.ts";

const owners = new WeakMap<GatewayBrowserClient, OwnerApproval>();
// Transport-only phases of a client that is still trying to come back.
const RECONNECTING = new Set<ApplicationGatewayPhase>([
  "connecting",
  "starting",
  "reconnecting",
  "offline",
]);

/** The current connection's browser-owned approval reader, if this origin can approve. */
export function ownerApprovalFor(client: GatewayBrowserClient): OwnerApproval | undefined {
  return owners.get(client);
}

/**
 * Binds browser approval to the admitted local client and this origin's account/key lifecycle.
 * A reconnect to the same Gateway keeps the reader and its attempts, including when the
 * store replaces the client: each attempt has its own expiry, and the reader is admitted
 * again on the new connection before it continues. A different Gateway, account or owner
 * key starts over.
 */
export function bindOwnerApproval(
  gateway: ApplicationGateway,
  onRequest: (client: GatewayBrowserClient) => void,
  onKitUsed: (client: GatewayBrowserClient, device: string | undefined) => void,
  onMemberDeviceAdded: () => void,
) {
  let client: GatewayBrowserClient | null = null;
  let reader: { owner: OwnerApproval; client: GatewayBrowserClient; clawId: string } | null = null;
  let account = openClawIdAccount();
  let generation = 0;
  let disposed = false;
  const retire = () => {
    generation += 1;
    if (reader) {
      reader.owner.stop();
      owners.delete(reader.client);
      reader = null;
    }
  };
  const stop = () => {
    retire();
    client = null;
  };
  const admit = (next: GatewayBrowserClient) => {
    const epoch = generation;
    void (async () => {
      const status = await next.request<OpenClawIdStatusResult>("openclawId.status", {});
      const link =
        status.channel === "local_operator" && status.owner && status.link.linked
          ? (await next.request<{ link: OpenClawIdPeopleLink }>("openclawId.people", {})).link
          : null;
      const owned = Boolean(link && (await thisOwnerDevice(link)));
      if (disposed || epoch !== generation || client !== next) {
        return;
      }
      if (reader) {
        // The reconnected client must still be this owner on the same claw.
        if (!owned || link?.clawId !== reader.clawId) {
          retire();
          return;
        }
        owners.delete(reader.client);
        reader.client = next;
        owners.set(next, reader.owner);
        reader.owner.resume(next);
        return;
      }
      if (!owned || !link?.clawId) {
        return;
      }
      const owner = createOwnerApproval(
        next,
        () => onRequest(reader?.client ?? next),
        (device) => onKitUsed(reader?.client ?? next, device),
        onMemberDeviceAdded,
      );
      reader = { owner, client: next, clawId: link.clawId };
      owners.set(next, owner);
      owner.start();
    })().catch(() => {
      /* Normal disconnected, unlinked or keyless browsers own no SAS reader. */
    });
  };
  const reconcile = () => {
    if (disposed) {
      return;
    }
    const snapshot = gateway.snapshot;
    const next = snapshot.phase === "connected" && account ? snapshot.client : null;
    // A reconnect to the same Gateway keeps the reader; anything else retires it at once.
    const sameGateway = (candidate: GatewayBrowserClient | null) =>
      Boolean(reader && candidate?.gatewayUrl === reader.client.gatewayUrl);
    const keep =
      account &&
      (next ? sameGateway(next) : RECONNECTING.has(snapshot.phase) && sameGateway(snapshot.client));
    if (reader && !keep) {
      retire();
    }
    if (next === client) {
      return;
    }
    // Mail and decisions wait until the new connection is admitted below.
    reader?.owner.suspend();
    client = next;
    if (next) {
      admit(next);
    }
  };
  const restart = () => {
    stop();
    reconcile();
  };
  const stops = [
    gateway.subscribe(reconcile),
    subscribeOpenClawIdAccount((next) => {
      account = next;
      restart();
    }),
    subscribeOwnerDeviceKey(restart),
  ];
  reconcile();
  return () => {
    disposed = true;
    stops.forEach((dispose) => dispose());
    stop();
  };
}
