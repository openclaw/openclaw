import type { ApplicationContext } from "../../app/context-types.ts";
import type { profileDirectory } from "../profile-directory.ts";
import { createSharedOwnerProjection } from "./shared-owner-projection.ts";

export const sharedRuntimeConfigProjection = createSharedOwnerProjection(
  (config: ApplicationContext["runtimeConfig"]) => ({
    state: config.state,
    canSet: config.canSet,
    canApply: config.canApply,
    canPatch: config.canPatch,
    canOpenFile: config.canOpenFile,
  }),
);

export const sharedAgentsProjection = createSharedOwnerProjection(
  (agents: ApplicationContext["agents"]) => agents.state,
);

// Agent selection remains local; this fixed contract shares only the identity owner's revision.
export const sharedAgentIdentityProjection = createSharedOwnerProjection(
  (identities: ApplicationContext["agentIdentity"]) => identities,
);

export const sharedProfileDirectoryProjection = createSharedOwnerProjection(
  (directory: ReturnType<typeof profileDirectory>) => directory,
);
