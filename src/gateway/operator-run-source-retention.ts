import { readGatewayDeviceReconnectSourceIdentity } from "./device-revocation.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/shared-types.js";

export type OperatorSource = {
  owners: readonly [
    gateway: object,
    resolver: GatewayRequestContext["resolveGatewayContext"],
    config: GatewayRequestContext["getRuntimeConfig"],
    device: object | undefined,
    access: object | null | undefined,
    ingress: object | undefined,
    invocation: object | undefined,
    githubCredential: object | undefined,
  ];
  membership: string | undefined;
  token: object;
  references: number;
};

// Comparison records live only while captured work retains their original authority.
type OperatorSourceBucket = {
  owner: object;
  entries: Set<OperatorSource>;
};
const operatorSources = new WeakMap<object, OperatorSourceBucket>();
function getOperatorSources(owner: object): OperatorSourceBucket {
  let sources = operatorSources.get(owner);
  if (!sources) {
    sources = { owner, entries: new Set() };
    operatorSources.set(owner, sources);
  }
  return sources;
}

/** A captured transport principal keeps its source's comparison identity, not new authority. */
export function transferGatewayOperatorSourceIdentity(
  source: GatewayClient,
  target: GatewayClient,
): void {
  operatorSources.set(target, getOperatorSources(source));
}

export function retainOperatorSource(
  client: GatewayClient,
  owners: OperatorSource["owners"],
  membership: string | undefined,
  callerGuard: (() => boolean) | undefined,
) {
  const clientSources = getOperatorSources(client);
  const deviceSource = readGatewayDeviceReconnectSourceIdentity(callerGuard, clientSources.owner);
  // A reconnect joins comparison records, never either request's live authority.
  const sources = deviceSource ? getOperatorSources(deviceSource).entries : clientSources.entries;
  let source =
    membership === undefined
      ? undefined
      : [...sources].find(
          (entry) =>
            entry.membership === membership &&
            entry.owners.every((owner, index) => owner === owners[index]),
        );
  if (!source) {
    source = { owners, membership, token: Object.freeze({}), references: 0 };
    sources.add(source);
  }
  const retained = source;
  const bucket = sources;
  retained.references += 1;
  return {
    token: retained.token,
    release: () => {
      if (--retained.references === 0) {
        bucket.delete(retained);
      }
    },
  };
}
