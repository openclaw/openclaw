// Who may turn on OpenClaw ID remote access (the root ceremony "Make reachable", OCF-511):
// the direct-loopback operator, or an administrator whose connection carries a verified
// personal identity (Tailscale Serve, a trusted proxy, an enterprise principal). Such an
// admin can already change config and run commands on the host, so the ceremony adds little
// power; requiring the person and the admin role keeps other tailnet users from claiming
// the claw. Shared token or password connections, members, non-admins, host-bound ingress
// grants and anything relayed by the OpenClaw ID tunnel are refused.
//
// Only the link ceremony (check_name, prepare, commit), its link code and publishing with a
// link code use this gate. Owner checks, membership writes, Move to new keys and owner reset
// keep the loopback-only client channel (channel.ts): recovery stays on the machine.
import type { Channel } from "../../../packages/openclaw-id-protocol/src/index.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import { emitTrustedSecurityEvent } from "../../infra/diagnostic-events.js";
import type { AuthorityRefusal } from "../openclaw-id/authority-result.js";
import {
  resolveOpenClawIdClientChannel,
  resolveOpenClawIdSignInRoute,
} from "../openclaw-id/channel.js";
import type { GatewayClient } from "./client-types.js";
import { preparePersonalProfileAction } from "./personal-profile-authorization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** How a connection may run Turn on remote access, as `openclawId.status` reports it. */
export type RemoteAccessSetupRoute = "local" | "personal_admin";

/** An admitted ceremony caller. `assertCurrent` throws once its authority is gone. */
export type RemoteAccessSetup = {
  route: RemoteAccessSetupRoute;
  /**
   * The ceremony's write channel. The protocol runs root ceremonies only on `local_operator`;
   * a personal admin gets it for these actions alone, never as its client channel.
   */
  channel: Extract<Channel, "local_operator">;
  /** The caller's canonical profile; absent for the loopback operator. */
  profileId?: string;
  assertCurrent: () => void;
};

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

const isLabsOn = (opts: Pick<GatewayRequestHandlerOptions, "context">) =>
  opts.context.getRuntimeConfig().gateway?.openclawId?.enabled === true;

/**
 * The route only: loopback, or a verified personal connection (the OpenClaw ID device
 * sign-in route) that still holds `operator.admin` on its socket. The current role policy is
 * checked by `prepareRemoteAccessSetup`, which every ceremony action calls.
 */
export function resolveRemoteAccessSetupRoute(
  client: GatewayClient | null | undefined,
): RemoteAccessSetupRoute | null {
  if (resolveOpenClawIdClientChannel(client) === "local_operator") {
    return "local";
  }
  return resolveOpenClawIdSignInRoute(client) === "device" &&
    client?.connect.scopes?.includes("operator.admin")
    ? "personal_admin"
    : null;
}

/**
 * Admits a ceremony caller, or refuses: `not_local_operator` for a connection without a
 * verified personal identity (token, password, tunnel), `not_admin` for a person whose current
 * role is not an administrator. A personal admin's authority is captured here and rechecked
 * by `assertCurrent` (live connection, same profile, admin under the current role, Labs on).
 */
export async function prepareRemoteAccessSetup(
  opts: GatewayRequestHandlerOptions,
): Promise<RemoteAccessSetup | AuthorityRefusal> {
  const route = resolveRemoteAccessSetupRoute(opts.client);
  if (route === "local") {
    return { route, channel: "local_operator", assertCurrent: () => {} };
  }
  if (resolveOpenClawIdSignInRoute(opts.client) !== "device") {
    return refusal(
      "not_local_operator",
      "Turn on remote access from the computer that runs this claw, or as an admin signed in through a personal sign-in such as Tailscale",
    );
  }
  const changed = () => new Error("this connection changed");
  try {
    if (!route) {
      throw changed();
    }
    const action = await preparePersonalProfileAction(opts, "operator.admin");
    const client = opts.client;
    const assertCurrent = () => {
      action.assertCurrent();
      if (
        !isLabsOn(opts) ||
        resolveRemoteAccessSetupRoute(client) !== "personal_admin" ||
        client?.authenticatedUserProfile?.profileId !== action.owner
      ) {
        throw changed();
      }
    };
    assertCurrent();
    return { route, channel: "local_operator", profileId: action.owner, assertCurrent };
  } catch {
    return refusal(
      "not_admin",
      "Only an admin signed in through a personal sign-in can turn on remote access",
    );
  }
}

function hashed(value: string | undefined): string | undefined {
  return value ? `sha256:${sha256HexPrefixCore(value, 12)}` : undefined;
}

/**
 * Records who ran a step of the root ceremony and over which identity: a Gateway log line
 * (profile, auth method, verified user) and a trusted security event with hashed IDs.
 */
export function auditRemoteAccessSetup(
  opts: Pick<GatewayRequestHandlerOptions, "client" | "context">,
  params: {
    action: string;
    setup: RemoteAccessSetup | null;
    outcome: "success" | "denied" | "failure";
    code?: string;
  },
) {
  const client = opts.client;
  const route = params.setup?.route ?? resolveRemoteAccessSetupRoute(client) ?? "refused";
  const via =
    route === "local"
      ? "loopback"
      : resolveOpenClawIdClientChannel(client) === "tunnel"
        ? "openclaw-id-tunnel"
        : (client?.authPolicy?.authMethod ?? "unknown");
  const profileId = params.setup?.profileId ?? client?.authenticatedUserProfile?.profileId;
  const user = client?.authenticatedUserId;
  const line = [
    `openclaw-id: remote access ${params.action} ${params.outcome}`,
    params.code ? `code=${params.code}` : undefined,
    `route=${route}`,
    `via=${via}`,
    profileId ? `profile=${profileId}` : undefined,
    user ? `user=${user}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  if (params.outcome === "success") {
    opts.context.logGateway.info(line);
  } else {
    opts.context.logGateway.warn(line);
  }
  emitTrustedSecurityEvent({
    category: "auth",
    action: `openclaw_id.remote_access.${params.action}`,
    outcome: params.outcome,
    severity: params.outcome === "success" ? "medium" : "low",
    actor: {
      kind: "operator",
      ...(hashed(profileId) ? { idHash: hashed(profileId) } : {}),
      channel: via,
      ...(route === "personal_admin" ? { role: "admin" } : {}),
    },
    target: { kind: "gateway", name: "openclaw-id" },
    policy: {
      id: "openclaw_id.remote_access_setup",
      decision: params.outcome === "denied" ? "deny" : "allow",
      ...(params.code ? { reason: params.code } : {}),
    },
    control: { id: "openclaw_id.root_ceremony", family: "authorization" },
    attributes: { route },
  });
}
