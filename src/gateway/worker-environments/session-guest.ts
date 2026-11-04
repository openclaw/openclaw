import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.js";
import type { GatewayAccessGrantRef } from "../../plugins/gateway-access-policy.types.js";
import type { WorkerLease, WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { onUserProfilesChanged } from "../../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../../state/user-profile-list.js";
import { UserProfileNotFoundError } from "../../state/user-profiles-schema.js";
import {
  GatewayOperatorAccessDeniedError,
  resumeGatewayOperatorAccessGrant,
} from "../operator-access-policy.js";
import {
  onOperatorRolePolicyChanged,
  resolveOperatorRolePolicyForAssignment,
} from "../operator-role-policy.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";

/** Host-captured ownership, persisted with the existing environment intent. */
export type SessionGuestBinding = Readonly<{
  profileId: string;
  sessionId: string;
  grant: GatewayAccessGrantRef | null;
}>;

export class SessionGuestAccessRevokedError extends Error {
  constructor() {
    super("The guest authority that owns this environment has ended");
  }
}

export function readSessionGuestBinding(profile: WorkerProfile): SessionGuestBinding | undefined {
  const value = profile.sessionGuest;
  if (value === undefined) {
    return undefined;
  }
  const message = "The environment has an invalid guest authority binding";
  if (
    !isRecord(value) ||
    typeof value.profileId !== "string" ||
    !value.profileId ||
    typeof value.sessionId !== "string" ||
    !value.sessionId
  ) {
    throw new Error(message);
  }
  const { profileId, sessionId } = value;
  const grant = value.grant;
  if (grant === null) {
    return { profileId, sessionId, grant };
  }
  if (
    !isRecord(grant) ||
    typeof grant.pluginId !== "string" ||
    !grant.pluginId ||
    typeof grant.grantId !== "string" ||
    !grant.grantId
  ) {
    throw new Error(message);
  }
  return { profileId, sessionId, grant: { pluginId: grant.pluginId, grantId: grant.grantId } };
}

/** Resume the existing admission policy; an unavailable policy is not a revocation. */
export async function prepareSessionGuestAuthority(
  binding: SessionGuestBinding,
  getConfig: () => OpenClawConfig,
) {
  const identity = await prepareUserProfileIdentity(binding.profileId).catch((error: unknown) => {
    if (error instanceof UserProfileNotFoundError) {
      throw new SessionGuestAccessRevokedError();
    }
    throw error;
  });
  const controller = new AbortController();
  const subscriptions: Array<() => void> = [];
  let revoked: SessionGuestAccessRevokedError | undefined;
  let released = false;
  const revoke = (error = new SessionGuestAccessRevokedError()) => {
    revoked ??= error;
    controller.abort(revoked);
    return revoked;
  };
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    for (const unsubscribe of subscriptions.splice(0)) {
      unsubscribe();
    }
    revoke();
    identity.release();
  };
  try {
    const read = () => {
      const { profile } = identity.readCurrentFacts();
      const config = getConfig();
      const role = resolveOperatorRolePolicyForAssignment(
        profile.profileId,
        profile.assignedRole,
        config,
        profile.githubLogin ?? null,
      );
      if (
        profile.profileId !== binding.profileId ||
        !role ||
        !roleScopesAllow({
          role: "operator",
          requestedScopes: ["operator.sessions.write"],
          allowedScopes: role.scopes,
        })
      ) {
        throw new SessionGuestAccessRevokedError();
      }
      return { profile, config };
    };
    const { profile, config } = read();
    const access = resumeGatewayOperatorAccessGrant(profile, config, binding.grant);
    const assertCurrent = () => {
      if (revoked) {
        throw revoked;
      }
      try {
        const current = read();
        resumeGatewayOperatorAccessGrant(current.profile, current.config, binding.grant, access);
        access?.assertCurrent();
      } catch (error) {
        if (
          error instanceof SessionGuestAccessRevokedError ||
          error instanceof GatewayOperatorAccessDeniedError ||
          error instanceof UserProfileNotFoundError
        ) {
          throw revoke(error instanceof SessionGuestAccessRevokedError ? error : undefined);
        }
        throw error;
      }
    };
    const recheck = () => {
      // Definite denials latch and abort; temporarily unavailable policy remains recoverable.
      try {
        assertCurrent();
      } catch {
        /* The next operation still receives the current policy error. */
      }
    };
    subscriptions.push(onUserProfilesChanged(recheck), onOperatorRolePolicyChanged(recheck));
    if (access) {
      const onAbort = () => {
        revoke();
      };
      access.signal.addEventListener("abort", onAbort, { once: true });
      subscriptions.push(() => access.signal.removeEventListener("abort", onAbort));
      if (access.signal.aborted) {
        onAbort();
      }
    }
    assertCurrent();
    return { assertCurrent, signal: controller.signal, release };
  } catch (error) {
    release();
    if (
      error instanceof GatewayOperatorAccessDeniedError ||
      error instanceof UserProfileNotFoundError
    ) {
      throw new SessionGuestAccessRevokedError();
    }
    throw error;
  }
}

/** Guest policy constrains a provider capability; it never grants operator authority. */
export function requireSessionGuestProvider(
  record: WorkerEnvironmentRecord,
  provider: WorkerProvider,
) {
  const guest = readSessionGuestBinding(record.profileSnapshot);
  if (
    guest &&
    (!provider.supportsUntrustedWorkloads ||
      !provider.requiresNodeEnrollment ||
      record.retention ||
      record.profileSnapshot.inference ||
      (record.profileSnapshot.executionMode &&
        record.profileSnapshot.executionMode !== "remote-exec"))
  ) {
    throw new Error("Guest environments require disposable tool-only provider execution");
  }
  return guest;
}

export function sessionGuestLeaseTransportError(
  record: WorkerEnvironmentRecord,
  lease: WorkerLease,
): Error | undefined {
  return record.profileSnapshot.sessionGuest && (lease.sharedHost !== false || !lease.node)
    ? new Error("Guest environments require a dedicated tool node lease")
    : undefined;
}
