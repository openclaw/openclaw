import type { ApplicationContext } from "../../app/context-types.ts";
import type { profileDirectory } from "../profile-directory.ts";
import type { SessionPullRequestSnapshotStore } from "../session-pull-requests.ts";
import { createSharedOwnerProjection } from "./shared-owner-projection.ts";

export const sharedThemeProjection = createSharedOwnerProjection(
  (theme: ApplicationContext["theme"]) => theme,
);

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

export const sharedPluginsProjection = createSharedOwnerProjection(
  (plugins: ApplicationContext["plugins"]) => plugins,
);

// Only the revision is projected; consumers keep their own session lookup and navigation intent.
export const sharedSessionsRevision = createSharedOwnerProjection(
  (_sessions: ApplicationContext["sessions"]) => undefined,
);

// Per-target watch custody stays with each consumer; this shares only publication of accepted facts.
export const sharedSessionPullRequestsProjection = createSharedOwnerProjection(
  (store: SessionPullRequestSnapshotStore) => store,
);
