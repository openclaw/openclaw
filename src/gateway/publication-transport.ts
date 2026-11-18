import type { PairedDeviceTokenIdentity } from "../infra/device-pairing-core.types.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../infra/device-pairing-identity.js";
import { isPublishedPairedDeviceTokenExact } from "../infra/device-pairing-publication.js";
import { readCurrentPairedDevice } from "../infra/device-pairing-store-readonly.js";
import { readGatewayDeviceSourceIdentity } from "./device-revocation.js";
import type { GatewayMethodRegistryView } from "./methods/descriptor.js";
import { PUBLICATION_READ_SCOPE, PUBLICATION_STEER_SCOPE } from "./operator-scopes.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/shared-types.js";

/** Opaque admission owned by the signed-device handshake, not a human identity. */
export type PublicationTransportScope =
  | typeof PUBLICATION_READ_SCOPE
  | typeof PUBLICATION_STEER_SCOPE;
export type PublicationTransportAdmission = Readonly<
  PairedDeviceTokenIdentity & {
    scope: PublicationTransportScope;
  }
>;

export function isPublicationTransportScope(scope: string): scope is PublicationTransportScope {
  return scope === PUBLICATION_READ_SCOPE || scope === PUBLICATION_STEER_SCOPE;
}
const admissions = new WeakSet<PublicationTransportAdmission>();

function isPublicationTransportAdmission(
  admission: PublicationTransportAdmission | undefined,
): admission is PublicationTransportAdmission {
  return admission !== undefined && admissions.has(admission);
}

export function isPublicationTransportCurrent(
  admission: PublicationTransportAdmission | undefined,
): admission is PublicationTransportAdmission {
  if (!isPublicationTransportAdmission(admission)) {
    return false;
  }
  try {
    return isPublishedPairedDeviceTokenExact(admission, "operator", [admission.scope]);
  } catch {
    return false;
  }
}

function isSingleton(scopes: readonly string[], scope: PublicationTransportScope): boolean {
  return scopes.length === 1 && scopes[0] === scope;
}

/** Classify before ordinary owner/profile admission or any hello/presence publication. */
export async function preparePublicationTransportAdmission(input: {
  role: string;
  authMethod?: string;
  scopes: readonly string[];
  requestedScopes: readonly string[];
  deviceId?: string;
  publicKey?: string | null;
  token?: string;
  hasHumanIdentity: boolean;
}): Promise<PublicationTransportAdmission | undefined> {
  const requested = input.requestedScopes.some(isPublicationTransportScope);
  const device =
    input.authMethod === "device-token" && input.deviceId
      ? await readCurrentPairedDevice(input.deviceId, (row) => row)
      : null;
  const storedScopes = device?.tokens?.[input.role]?.scopes ?? [];
  if (!requested && !storedScopes.some(isPublicationTransportScope)) {
    return undefined;
  }
  const scope = storedScopes.find(isPublicationTransportScope);
  // A broad token narrowed by client request is still broad. Conversely a restricted
  // token cannot opt back into the ordinary owner lane by omitting its scope.
  if (
    input.role !== "operator" ||
    input.authMethod !== "device-token" ||
    input.hasHumanIdentity ||
    !input.publicKey ||
    !input.token ||
    !scope ||
    !isSingleton(input.requestedScopes, scope) ||
    !isSingleton(input.scopes, scope) ||
    !isSingleton(storedScopes, scope)
  ) {
    throw new Error("publication transport requires an exact singleton paired device token");
  }
  const identity = resolveAuthenticatedDeviceTokenIdentity(device, {
    role: input.role,
    publicKey: input.publicKey,
    token: input.token,
    scopes: input.scopes,
  });
  if (!identity) {
    throw new Error("publication transport device authority changed");
  }
  const admission = Object.freeze({ ...identity, scope });
  admissions.add(admission);
  return admission;
}

export function isPublicationTransportMethod(
  registry: GatewayMethodRegistryView,
  method: string,
  scope: PublicationTransportScope,
): boolean {
  if (
    scope === PUBLICATION_STEER_SCOPE &&
    method !== "session-share.steer.target" &&
    method !== "session-share.steer.send"
  ) {
    return false;
  }
  const descriptor = registry.getDescriptor(method);
  if (
    scope === PUBLICATION_STEER_SCOPE &&
    (descriptor?.owner.kind !== "plugin" || descriptor.owner.pluginId !== "session-share")
  ) {
    return false;
  }
  return descriptor?.scope === scope && descriptor.profileAccess === "independent";
}

type GatewayPublicationTransportV1 = Readonly<{
  deviceId: string;
  /** Check after awaited source reads and immediately before disclosing their results. */
  assertCurrent: () => void;
}>;

/** Resolve only a real device admission with the dispatch owner's live authority. */
export function prepareGatewayPublicationTransportV1(
  request: GatewayRequestHandlerOptions,
  scope: PublicationTransportScope,
): GatewayPublicationTransportV1 {
  const { client } = request;
  const admission = client?.internal?.publicationTransport;
  const registry = request.context.getGatewayMethodRegistry?.();
  const assertCurrent = () => {
    request.assertHandlerCurrent?.();
    if (
      !client ||
      !isPublicationTransportCurrent(admission) ||
      client.internal?.publicationTransport !== admission ||
      client.internal?.operatorDeviceTokenIdentity?.key !== admission.key ||
      client.connect.device?.id !== admission.deviceId ||
      client.connect.role !== "operator" ||
      !client.isDeviceTokenAuth ||
      client.internal?.syntheticClient ||
      client.authenticatedUserProfile ||
      client.internal?.operatorRoleActor ||
      admission.scope !== scope ||
      !isSingleton(client.connect.scopes ?? [], scope) ||
      !registry ||
      !isPublicationTransportMethod(registry, request.req.method, scope) ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      request.signal?.aborted ||
      !readGatewayDeviceSourceIdentity(request.hasCurrentClientAuthority) ||
      request.hasCurrentClientAuthority?.() !== true
    ) {
      throw new Error("publication transport authority unavailable");
    }
  };
  assertCurrent();
  return Object.freeze({ deviceId: admission!.deviceId, assertCurrent });
}

export type GatewayPublicationReaderV1 = GatewayPublicationTransportV1;

/** Reader SDK remains limited to the reader purpose, even for a valid writer device. */
export function prepareGatewayPublicationReaderV1(
  request: GatewayRequestHandlerOptions,
): GatewayPublicationReaderV1 {
  return prepareGatewayPublicationTransportV1(request, PUBLICATION_READ_SCOPE);
}
