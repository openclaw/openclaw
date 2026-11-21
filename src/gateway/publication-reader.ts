import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import { readRuntimeConfig } from "../config/runtime-snapshot.js";
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

export class PublicationTransportAdmissionError extends Error {
  constructor(
    readonly failure:
      | { reason: "purpose-disabled"; scope: PublicationTransportScope }
      | { reason: "invalid-admission" },
  ) {
    super(failure.reason);
  }
}

export function isPublicationTransportScope(scope: string): scope is PublicationTransportScope {
  return scope === PUBLICATION_READ_SCOPE || scope === PUBLICATION_STEER_SCOPE;
}
const admissions = new WeakMap<PublicationTransportAdmission, () => void>();

/** Reader epochs remain until the separate reader correction; writer checks only admission. */
function capturePublicationEnablement(scope: PublicationTransportScope): () => void {
  const reader = scope === PUBLICATION_READ_SCOPE;
  const config = readRuntimeConfig().gateway?.sessionControl;
  if ((reader ? config?.publicationReadEnabled : config?.publicationWriteEnabled) !== true) {
    return () => {
      throw new PublicationTransportAdmissionError({ reason: "purpose-disabled", scope });
    };
  }
  if (!reader) {
    return () => {};
  }
  const epoch = runtimeConfigPublication.publicationReadDisableEpoch;
  return () => {
    if (
      epoch !== runtimeConfigPublication.publicationReadDisableEpoch ||
      readRuntimeConfig().gateway?.sessionControl?.publicationReadEnabled !== true
    ) {
      throw new PublicationTransportAdmissionError({ reason: "invalid-admission" });
    }
  };
}

export function isPublicationTransportEnabled(scope: PublicationTransportScope): boolean {
  const config = readRuntimeConfig().gateway?.sessionControl;
  return (
    (scope === PUBLICATION_READ_SCOPE
      ? config?.publicationReadEnabled
      : config?.publicationWriteEnabled) === true
  );
}

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
    admissions.get(admission)!();
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
  const requestedScope = input.requestedScopes.find(isPublicationTransportScope);
  const requested = requestedScope !== undefined;
  const assertEnabled = requestedScope ? capturePublicationEnablement(requestedScope) : undefined;
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
    !assertEnabled ||
    !isSingleton(input.requestedScopes, scope) ||
    !isSingleton(input.scopes, scope) ||
    !isSingleton(storedScopes, scope)
  ) {
    throw new PublicationTransportAdmissionError({ reason: "invalid-admission" });
  }
  const identity = resolveAuthenticatedDeviceTokenIdentity(device, {
    role: input.role,
    publicKey: input.publicKey,
    token: input.token,
    scopes: input.scopes,
  });
  if (!identity) {
    throw new PublicationTransportAdmissionError({ reason: "invalid-admission" });
  }
  const admission = Object.freeze({ ...identity, scope });
  assertEnabled();
  admissions.set(admission, assertEnabled);
  return admission;
}

export function isPublicationTransportMethod(
  registry: GatewayMethodRegistryView,
  method: string,
  scope: PublicationTransportScope,
): boolean {
  // The fixed writer surface is documented in docs/gateway/protocol/rpc-session-control.md.
  // Only Session Share owns those methods; other plugins cannot claim its writer scope.
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
