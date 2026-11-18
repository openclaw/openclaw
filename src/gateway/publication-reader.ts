import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import { readRuntimeConfig } from "../config/runtime-snapshot.js";
import type { PairedDeviceTokenIdentity } from "../infra/device-pairing-core.types.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../infra/device-pairing-identity.js";
import { isPublishedPairedDeviceTokenExact } from "../infra/device-pairing-publication.js";
import { readCurrentPairedDevice } from "../infra/device-pairing-store-readonly.js";
import { readGatewayDeviceSourceIdentity } from "./device-revocation.js";
import type { GatewayMethodRegistryView } from "./methods/descriptor.js";
import { PUBLICATION_READ_SCOPE } from "./operator-scopes.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/shared-types.js";

/** Opaque admission owned by the signed-device handshake, not a human identity. */
export type PublicationReaderAdmission = Readonly<PairedDeviceTokenIdentity>;
const admissions = new WeakMap<PublicationReaderAdmission, () => void>();

function capturePublicationReaderEnablement(): () => void {
  const epoch = runtimeConfigPublication.publicationReadDisableEpoch;
  let revoked = false;
  const assertCurrent = () => {
    if (
      revoked ||
      epoch !== runtimeConfigPublication.publicationReadDisableEpoch ||
      readRuntimeConfig().gateway?.sessionControl?.publicationReadEnabled !== true
    ) {
      revoked = true;
      throw new Error("Gateway publication reads are disabled or this admission was revoked");
    }
  };
  assertCurrent();
  return assertCurrent;
}

function isPublicationReaderAdmission(
  admission: PublicationReaderAdmission | undefined,
): admission is PublicationReaderAdmission {
  return admission !== undefined && admissions.has(admission);
}

export function isPublicationReaderCurrent(
  admission: PublicationReaderAdmission | undefined,
): admission is PublicationReaderAdmission {
  if (!isPublicationReaderAdmission(admission)) {
    return false;
  }
  try {
    admissions.get(admission)!();
    return isPublishedPairedDeviceTokenExact(admission, "operator", [PUBLICATION_READ_SCOPE]);
  } catch {
    return false;
  }
}

function isSingleton(scopes: readonly string[]): boolean {
  return scopes.length === 1 && scopes[0] === PUBLICATION_READ_SCOPE;
}

/** Classify before ordinary owner/profile admission or any hello/presence publication. */
export async function preparePublicationReaderAdmission(input: {
  role: string;
  authMethod?: string;
  scopes: readonly string[];
  requestedScopes: readonly string[];
  deviceId?: string;
  publicKey?: string | null;
  token?: string;
  hasHumanIdentity: boolean;
}): Promise<PublicationReaderAdmission | undefined> {
  const requested = input.requestedScopes.includes(PUBLICATION_READ_SCOPE);
  // Capture before the paired-device read yields, not from a request-scoped config copy.
  const assertEnabled = requested ? capturePublicationReaderEnablement() : undefined;
  const device =
    input.authMethod === "device-token" && input.deviceId
      ? await readCurrentPairedDevice(input.deviceId, (row) => row)
      : null;
  const storedScopes = device?.tokens?.[input.role]?.scopes ?? [];
  if (!requested && !storedScopes.includes(PUBLICATION_READ_SCOPE)) {
    return undefined;
  }
  // A broad token narrowed by client request is still broad. Conversely a restricted
  // token cannot opt back into the ordinary owner lane by omitting its scope.
  if (
    input.role !== "operator" ||
    input.authMethod !== "device-token" ||
    input.hasHumanIdentity ||
    !input.publicKey ||
    !input.token ||
    !assertEnabled ||
    !isSingleton(input.requestedScopes) ||
    !isSingleton(input.scopes) ||
    !isSingleton(storedScopes)
  ) {
    throw new Error("publication reader requires an exact singleton paired device token");
  }
  const identity = resolveAuthenticatedDeviceTokenIdentity(device, {
    role: input.role,
    publicKey: input.publicKey,
    token: input.token,
    scopes: input.scopes,
  });
  if (!identity) {
    throw new Error("publication reader device authority changed");
  }
  assertEnabled();
  admissions.set(identity, assertEnabled);
  return identity;
}

export function isPublicationReaderMethod(
  registry: GatewayMethodRegistryView,
  method: string,
): boolean {
  const descriptor = registry.getDescriptor(method);
  return descriptor?.scope === PUBLICATION_READ_SCOPE && descriptor.profileAccess === "independent";
}

export type GatewayPublicationReaderV1 = Readonly<{
  deviceId: string;
  /** Check after awaited source reads and immediately before disclosing their results. */
  assertCurrent: () => void;
}>;

/** Resolve only a real device admission with the dispatch owner's live authority. */
export function prepareGatewayPublicationReaderV1(
  request: GatewayRequestHandlerOptions,
): GatewayPublicationReaderV1 {
  const { client } = request;
  const admission = client?.internal?.publicationReader;
  const registry = request.context.getGatewayMethodRegistry?.();
  const assertCurrent = () => {
    request.assertHandlerCurrent?.();
    if (
      !client ||
      !isPublicationReaderCurrent(admission) ||
      client.internal?.publicationReader !== admission ||
      client.internal?.operatorDeviceTokenIdentity?.key !== admission.key ||
      client.connect.device?.id !== admission.deviceId ||
      client.connect.role !== "operator" ||
      !client.isDeviceTokenAuth ||
      client.internal?.syntheticClient ||
      client.authenticatedUserProfile ||
      client.internal?.operatorRoleActor ||
      !isSingleton(client.connect.scopes ?? []) ||
      !registry ||
      !isPublicationReaderMethod(registry, request.req.method) ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      request.signal?.aborted ||
      !readGatewayDeviceSourceIdentity(request.hasCurrentClientAuthority) ||
      request.hasCurrentClientAuthority?.() !== true
    ) {
      throw new Error("publication reader authority unavailable");
    }
  };
  assertCurrent();
  return Object.freeze({ deviceId: admission!.deviceId, assertCurrent });
}
