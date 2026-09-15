import { setGatewayPluginSuspensionParticipants } from "../infra/gateway-suspension-participants.js";
import type { PluginRegistry } from "./registry-types.js";

type RegistryOwner = { activeRegistry: PluginRegistry };

export type SuspensionParticipantProjection = {
  activeRegistry?: PluginRegistry | null;
  stagedPreviousRegistry?: PluginRegistry | null;
  ownerReplacement?: { owner: RegistryOwner; registry: PluginRegistry };
  registrationReplacement?: {
    registry: PluginRegistry;
    registrations: PluginRegistry["gatewaySuspensionParticipants"];
  };
  extraRegistries?: readonly PluginRegistry[];
};

export function publishPluginSuspensionParticipants(params: {
  activeRegistry: PluginRegistry | null;
  stagedPreviousRegistry?: PluginRegistry | null;
  owners: Iterable<RegistryOwner>;
  projection?: SuspensionParticipantProjection;
}): void {
  const projection = params.projection ?? {};
  const activeRegistry =
    "activeRegistry" in projection ? projection.activeRegistry : params.activeRegistry;
  const stagedPreviousRegistry =
    "stagedPreviousRegistry" in projection
      ? projection.stagedPreviousRegistry
      : params.stagedPreviousRegistry;
  const registries = [
    stagedPreviousRegistry,
    activeRegistry,
    ...[...params.owners].map((owner) =>
      projection.ownerReplacement?.owner === owner
        ? projection.ownerReplacement.registry
        : owner.activeRegistry,
    ),
    ...(projection.extraRegistries ?? []),
  ];
  const participants = registries.flatMap((registry) => {
    if (!registry) {
      return [];
    }
    const registrations =
      projection.registrationReplacement?.registry === registry
        ? projection.registrationReplacement.registrations
        : registry.gatewaySuspensionParticipants;
    return registrations.map((entry) => entry.participant);
  });
  setGatewayPluginSuspensionParticipants([...new Set(participants)]);
}
