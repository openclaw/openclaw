import type {
  ChannelIngressRouteAccess,
  ChannelIngressRouteDescriptor,
  ResolveChannelMessageIngressParams,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";
import type { AccessGraphGate, RouteGateFacts } from "./types.js";

function routeDescriptors(
  route: ResolveChannelMessageIngressParams["route"],
): ChannelIngressRouteDescriptor[] {
  if (!route) {
    return [];
  }
  return [route].flat();
}

/**
 * Collect optional route descriptors while dropping false, null, and undefined
 * entries.
 */
export function channelIngressRoutes(
  ...routes: Array<ChannelIngressRouteDescriptor | false | null | undefined>
): ChannelIngressRouteDescriptor[] {
  return routes.filter((route): route is ChannelIngressRouteDescriptor => Boolean(route));
}

export function routeFactsFromDescriptors(
  route: ResolveChannelMessageIngressParams["route"],
): RouteGateFacts[] {
  return routeDescriptors(route).flatMap((descriptor) => {
    if (descriptor.configured === false) {
      return [];
    }
    let kind = descriptor.kind ?? "route";
    let gate: RouteGateFacts["gate"] = "matched";
    let effect: RouteGateFacts["effect"] = "allow";
    if (descriptor.enabled === false) {
      gate = "disabled";
      effect = "block-dispatch";
    } else if (descriptor.allowed !== undefined) {
      gate = descriptor.allowed ? "matched" : "not-matched";
      effect = descriptor.allowed ? "allow" : "block-dispatch";
    } else if (
      descriptor.senderPolicy !== "deny-when-empty" &&
      descriptor.senderAllowFrom == null &&
      descriptor.senderAllowFromSource == null
    ) {
      return [];
    } else if (descriptor.senderPolicy !== "deny-when-empty") {
      kind = "routeSender";
    }
    const matched = descriptor.matched ?? descriptor.allowed ?? descriptor.enabled !== false;
    return [
      {
        id: descriptor.id,
        kind,
        gate,
        effect,
        precedence: descriptor.precedence ?? 0,
        senderPolicy: descriptor.senderPolicy ?? "inherit",
        senderAllowFrom:
          descriptor.senderAllowFrom == null ? undefined : [...descriptor.senderAllowFrom],
        senderAllowFromSource: descriptor.senderAllowFromSource,
        match: {
          matched,
          matchedEntryIds: matched && descriptor.matchId ? [descriptor.matchId] : [],
        },
      },
    ];
  });
}

function routeDescriptorForGate(params: {
  descriptors: readonly ChannelIngressRouteDescriptor[];
  gate: AccessGraphGate;
}): ChannelIngressRouteDescriptor | undefined {
  const senderSuffix = ":sender";
  const baseGateId = params.gate.id.endsWith(senderSuffix)
    ? params.gate.id.slice(0, -senderSuffix.length)
    : params.gate.id;
  return params.descriptors.find(
    (descriptor) => descriptor.id === params.gate.id || descriptor.id === baseGateId,
  );
}

export function projectRouteAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
  route: ResolveChannelMessageIngressParams["route"];
}): ChannelIngressRouteAccess {
  const descriptors = routeDescriptors(params.route);
  const routeBlock = params.ingress.graph.gates.find(
    (entry) => entry.phase === "route" && entry.effect === "block-dispatch",
  );
  if (routeBlock) {
    const descriptor = routeDescriptorForGate({ descriptors, gate: routeBlock });
    return {
      allowed: routeBlock.allowed,
      reasonCode: routeBlock.reasonCode,
      ...(descriptor?.blockReason ? { reason: descriptor.blockReason } : {}),
      gate: routeBlock,
    };
  }
  const routeSenderReplacement = descriptors.find(
    (descriptor) => descriptor.senderPolicy === "replace" && descriptor.blockReason,
  );
  const senderBlock = params.ingress.graph.gates.find(
    (entry) => entry.phase === "sender" && entry.effect === "block-dispatch",
  );
  if (routeSenderReplacement && senderBlock) {
    return {
      allowed: false,
      reasonCode: senderBlock.reasonCode,
      reason: routeSenderReplacement.blockReason,
      gate: senderBlock,
    };
  }
  const gate = params.ingress.graph.gates.find((entry) => entry.phase === "route");
  if (gate) {
    return {
      allowed: gate.allowed,
      reasonCode: gate.reasonCode,
      gate,
    };
  }
  return { allowed: true };
}
