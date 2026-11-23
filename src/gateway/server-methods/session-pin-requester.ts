import { assertAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayPersonalToolParticipant,
} from "../../agents/tools/gateway-caller-context.js";
import { readProfileSidebarOrder } from "../../state/user-preferences.js";
import {
  readResidentUserProfileAliases,
  readResidentUserProfileId,
} from "../../state/user-profile-list.js";
import { usesLegacySessionPins } from "../session-pin-compatibility.js";
import {
  isIneligiblePersonalGatewayCaller,
  isSyntheticGatewayCaller,
} from "./gateway-personal-caller.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export const PERSONAL_PIN_PROFILE_REQUIRED =
  "Personal session pins require the requesting person's signed-in profile.";

// No RPC parameter can select this identity. A copied profile on a synthetic transport is not a grant.
export function sessionPinRequester(options: GatewayRequestHandlerOptions) {
  const { client } = options;
  const synthetic = isSyntheticGatewayCaller(client);
  const run = synthetic ? client?.internal?.operatorRunAuthority : undefined;
  const caller = getGatewayToolCallerIdentity();
  let participant: ReturnType<typeof resolveGatewayPersonalToolParticipant>;
  if (synthetic) {
    try {
      participant = resolveGatewayPersonalToolParticipant(client?.internal?.agentRuntimeIdentity, {
        requireSingleParticipant: true,
      });
    } catch {
      // An ambiguous participant set cannot provide personal pins, even for a named user.
      return undefined;
    }
  }
  const identity = () => {
    if (
      !client ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      client.connect.role !== "operator"
    ) {
      return undefined;
    }
    if (!synthetic) {
      return isIneligiblePersonalGatewayCaller(client)
        ? undefined
        : client.authenticatedUserProfile?.profileId;
    }
    if (participant) {
      participant.assertCurrent();
      if (participant.profileId !== run?.profileId) {
        return undefined;
      }
    }
    if (
      !run ||
      run !== client.internal?.operatorRunAuthority ||
      !caller?.operatorAuthority?.source ||
      caller.operatorAuthority.source !== run.source ||
      caller.operatorAuthority.profileId !== run.profileId
    ) {
      return undefined;
    }
    assertAdmittedRunOperatorAuthority(run);
    run.assertCurrent();
    caller.operatorAuthority.assertCurrent();
    return run.profileId;
  };
  const id = identity();
  const profileId = id && readResidentUserProfileId(id);
  if (!profileId) {
    return undefined;
  }
  const lifetime = readGatewayRequestMutationAuthority(options);
  // Identity was admitted for this operation. Keep Stop/caller lifetime and target/CAS
  // preconditions, not a second role or participant selection after an async read.
  lifetime.assertCurrent();
  return { profileId, assertCurrent: lifetime.assertCurrent };
}

async function readRequesterSessionPins(
  owner: NonNullable<ReturnType<typeof sessionPinRequester>>,
) {
  const order = await readProfileSidebarOrder(
    owner.profileId,
    readResidentUserProfileAliases(owner.profileId),
  );
  owner.assertCurrent();
  return new Map(order.map((key, index) => [key, order.length - index]));
}

/** Capture negotiation once at admission. An empty personal view never imports shared metadata. */
export function prepareSessionPinRead(options: GatewayRequestHandlerOptions) {
  const legacy = usesLegacySessionPins(options.client);
  const owner = legacy ? undefined : sessionPinRequester(options);
  return {
    canFilter: legacy || Boolean(owner),
    shareable: !owner,
    assertCurrent: owner?.assertCurrent,
    read: () =>
      legacy ? undefined : owner ? readRequesterSessionPins(owner) : new Map<string, number>(),
  };
}
