// Time-driven owner allowlist upkeep: the configured inactivity windows, and the
// side effects of dropping unused keys and of owner certificates that expired.
import type {
  AuthorityEvent,
  InactivityWindows,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";
import type { OpenClawIdAuthority } from "./authority.js";
import { createOwnerExpiryTimer } from "./owner-expiry.js";

const DAY_SECONDS = 86400;

/** The configured inactivity windows in seconds; unset ones keep the protocol defaults. */
export function inactivityWindows(
  config: GatewayOpenClawIdConfig | undefined,
): Partial<InactivityWindows> {
  const owner = config?.ownerDeviceInactivityDays;
  const member = config?.memberDeviceInactivityDays;
  return {
    ...(owner ? { ownerDeviceSeconds: owner * DAY_SECONDS } : {}),
    ...(member ? { memberPeerKeySeconds: member * DAY_SECONDS } : {}),
  };
}

/**
 * Drops keys unused past the inactivity windows and finds owner devices whose
 * certificates expired. Returns the events that cut them off (dropped keys also lose
 * their device tokens), or undefined when nothing changed.
 */
export async function ownerLifecycleEvents(
  owner: OpenClawIdAuthority,
  config: GatewayOpenClawIdConfig | undefined,
  log: { info: (message: string) => void },
): Promise<AuthorityEvent[] | undefined> {
  const dropped = await owner.dropInactive(inactivityWindows(config));
  const expired = await owner.expiredOwnerPeers();
  if (dropped.length === 0 && expired.length === 0) {
    return undefined;
  }
  if (dropped.length > 0) {
    log.info(`openclaw-id: dropped ${dropped.length} device key(s) unused too long`);
  }
  if (expired.length > 0) {
    log.info(`openclaw-id: closing sessions of ${expired.length} expired owner device key(s)`);
  }
  return [
    { type: "disconnect", peer_keys: [...new Set([...dropped, ...expired])] },
    ...(dropped.length > 0 ? [{ type: "invalidate_tokens" as const, peer_keys: dropped }] : []),
    { type: "publish_snapshot" },
  ];
}

/** Arms the existing local expiry timer only while its observed authority still owns the service. */
export async function armLocalExpiry(
  owner: OpenClawIdAuthority,
  readObserver: () => object | undefined,
  getConfig: () => GatewayOpenClawIdConfig | undefined,
  timer: Pick<ReturnType<typeof createOwnerExpiryTimer>, "arm">,
): Promise<void> {
  const observing = readObserver();
  const deadline = await owner.nextOwnerExpiry(inactivityWindows(getConfig()));
  // A disabled or replaced local owner cannot publish a delayed timer arm.
  if (observing && observing === readObserver() && isOpenClawIdEnabled(getConfig())) {
    timer.arm(deadline);
  }
}

/** Re-arms the single People deadline from the committed record after each expiry. */
export function createPeopleExpiry(params: {
  next: () => number | undefined;
  enabled: () => boolean;
  changed: () => void;
}) {
  const timer = createOwnerExpiryTimer({
    onExpired: async () => {
      params.changed();
      arm();
    },
  });
  const arm = () => {
    if (params.enabled()) {
      timer.arm(params.next());
    }
  };
  return { arm, stop: () => timer.stop() };
}
