import { isDeepStrictEqual } from "node:util";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  onUserProfilesChanged,
  readUserProfileAliasRevision,
} from "../state/user-profile-events.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import {
  onGatewayDeviceSourceRevoked,
  readGatewayDeviceSourceAuthority,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import {
  authorizeCurrentOperatorRoleScopes,
  onOperatorRolePolicyChanged,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/shared-types.js";

// Equal source tokens describe one authenticated connection, without retaining its socket or auth.
const operatorSources = new WeakMap<GatewayClient, object>();

/** Transfers the original operator restriction into accepted work, independently of its request. */
export function captureGatewayOperatorRunAuthority(params: {
  client: GatewayClient | null;
  context: Pick<
    GatewayRequestContext,
    "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext"
  >;
  hasCurrentClientAuthority?: () => boolean;
  sourceAuthority?: Readonly<{ assertCurrent: () => void; signal?: AbortSignal }>;
}): { authority: AdmittedRunOperatorAuthority; release: () => void } | undefined {
  const inherited = params.client?.internal?.operatorRunAuthority;
  if (inherited !== undefined) {
    assertAdmittedRunOperatorAuthority(inherited);
    inherited.assertCurrent();
    const scopes = intersectOperatorScopes(inherited.scopes, params.client?.connect.scopes ?? []);
    const authority = roleScopesAllow({
      role: "operator",
      requestedScopes: inherited.scopes,
      allowedScopes: scopes,
    })
      ? inherited
      : createAdmittedRunOperatorAuthority({ ...inherited, scopes });
    return { authority, release: inherited.retain?.() ?? (() => {}) };
  }
  const actor = resolveGatewayOperatorRoleActor(params.client);
  const client = params.client;
  if (!client || actor?.kind !== "operator") {
    return undefined;
  }
  const profileId = actor.profileId;
  let aliasRevision = readUserProfileAliasRevision();
  if (params.hasCurrentClientAuthority?.() === false) {
    throw new Error("Gateway caller authority is no longer active.");
  }
  const releaseDevice = retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const isSourceCurrent = readGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority);
  const resolveGatewayContext = params.context.resolveGatewayContext;
  const gatewayContext = resolveGatewayContext?.();
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  const isGatewayCurrent = () =>
    !resolveGatewayContext ||
    (gatewayContext !== undefined && resolveGatewayContext() === gatewayContext);
  const sourceAuthority = params.sourceAuthority;
  const scopes = Object.freeze([...(client.connect.scopes ?? [])]);
  const policyClient: GatewayClient = {
    connect: {
      minProtocol: client.connect.minProtocol,
      maxProtocol: client.connect.maxProtocol,
      client: client.connect.client,
      role: "operator",
      scopes: [...scopes],
    },
    internal: { operatorRoleActor: { kind: "operator", profileId } },
  };
  let source = operatorSources.get(client);
  if (!source) {
    source = Object.freeze({});
    operatorSources.set(client, source);
  }
  let references = 1;
  let revoked = false;
  const revocation = new AbortController();
  const subscriptions: Array<(() => void) | undefined> = [];
  const assertProfileCurrent = () => {
    const currentAliasRevision = readUserProfileAliasRevision();
    if (currentAliasRevision !== aliasRevision) {
      if (resolveUserProfileId(profileId) !== profileId) {
        throw new Error("operator source identity changed; start a new request");
      }
      aliasRevision = currentAliasRevision;
    }
  };
  const assertRoleCurrent = () => {
    const error = authorizeCurrentOperatorRoleScopes(policyClient, getConfig());
    if (error) {
      throw new Error(error.message);
    }
  };
  const revoke = (reason: unknown) => {
    if (references > 0 && isGatewayCurrent()) {
      revoked = true;
      revocation.abort(reason);
    }
  };
  const recheck = (check: () => void) => {
    if (!revoked && references > 0 && isGatewayCurrent()) {
      try {
        check();
      } catch (error) {
        revoke(error);
      }
    }
  };
  const assertCurrent = () => {
    if (revoked || references === 0) {
      throw new Error("operator execution authority is no longer active");
    }
    try {
      if (isSourceCurrent?.() === false || !isGatewayCurrent()) {
        throw new Error("operator source authority is no longer active");
      }
      sourceAuthority?.signal?.throwIfAborted();
      sourceAuthority?.assertCurrent();
      assertProfileCurrent();
      assertRoleCurrent();
    } catch (error) {
      revoked = true;
      throw error;
    }
  };
  const releaseHold = () => {
    let released = false;
    return () => {
      if (!released) {
        released = true;
        if (--references === 0) {
          for (const unsubscribe of subscriptions.splice(0)) {
            unsubscribe?.();
          }
          releaseDevice?.();
        }
      }
    };
  };
  const release = releaseHold();
  try {
    const capturedRole = structuredClone(
      resolveOperatorRolePolicyForProfile(profileId, getConfig()),
    );
    subscriptions.push(
      onGatewayDeviceSourceRevoked(params.hasCurrentClientAuthority, () =>
        revoke(new Error("operator source authority is no longer active")),
      ),
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "assignment" && change.profileId === profileId) {
          revoke(new Error("Your operator role changed; reconnect before continuing."));
        } else if (
          change.kind === "config" &&
          change.context === (gatewayContext ?? params.context)
        ) {
          recheck(() => {
            const currentRole = resolveOperatorRolePolicyForProfile(profileId, getConfig());
            if (!isDeepStrictEqual(capturedRole, currentRole)) {
              throw new Error("Your operator role changed; reconnect before continuing.");
            }
          });
        }
      }),
      onUserProfilesChanged(() => recheck(assertProfileCurrent)),
    );
    const sourceSignal = sourceAuthority?.signal;
    if (sourceSignal) {
      const onAbort = () => revoke(sourceSignal.reason);
      sourceSignal.addEventListener("abort", onAbort, { once: true });
      subscriptions.push(() => sourceSignal.removeEventListener("abort", onAbort));
    }
    assertCurrent();
    return {
      authority: createAdmittedRunOperatorAuthority({
        profileId,
        scopes,
        source,
        assertCurrent,
        signal: revocation.signal,
        retain: () => {
          assertCurrent();
          references += 1;
          return releaseHold();
        },
      }),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
