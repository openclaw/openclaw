import type { AgentIdentityCapability } from "../agents/identity.ts";
import type { AgentCapability } from "../agents/index.ts";
import type { rosterActivityStore } from "../agents/roster-activity-store.ts";
import type { ChannelCapability } from "../channels/index.ts";
import type { RuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import type { SessionCapability, SessionListScope } from "../sessions/session-capability.ts";
import { projectEvents, projectSource } from "./projection.ts";

/** These owners mutate synchronously; every publication invalidates their projection. */
export function projectAgents(source: Pick<AgentCapability, "state" | "subscribe">) {
  return projectSource(source, {
    read: (agents) => agents.state,
    subscribe: (agents, notify) => agents.subscribe(notify),
    equality: "revision",
  });
}

export type AgentFilesProjectionSource = {
  agents: Pick<AgentCapability, "files" | "subscribe">;
  agentId: string | null | undefined;
};

export function projectAgentFiles(source: AgentFilesProjectionSource) {
  return projectSource(source, {
    read: ({ agents, agentId }) => agents.files(agentId),
    subscribe: ({ agents }, notify) => agents.subscribe(notify),
    equality: "revision",
  });
}

export type AgentIdentityProjectionSource = {
  identities: Pick<AgentIdentityCapability, "get" | "subscribe">;
  agentId: string | null | undefined;
};

export function projectAgentIdentity(source: AgentIdentityProjectionSource) {
  return projectSource(source, {
    read: ({ identities, agentId }) => identities.get(agentId),
    subscribe: ({ identities }, notify) => identities.subscribe(notify),
    equality: "revision",
  });
}

export function projectRosterActivity(
  source: Pick<ReturnType<typeof rosterActivityStore>, "snapshot" | "subscribe">,
) {
  return projectSource(source, {
    read: (roster) => roster.snapshot,
    subscribe: (roster, notify) => roster.subscribe(notify),
    equality: "revision",
  });
}

export function projectChannels(source: Pick<ChannelCapability, "state" | "subscribe">) {
  return projectSource(source, {
    read: (channels) => channels.state,
    subscribe: (channels, notify) => channels.subscribe(notify),
    equality: "revision",
  });
}

export function projectRuntimeConfig(
  source: Pick<
    RuntimeConfigCapability,
    "state" | "subscribe" | "canSet" | "canApply" | "canPatch" | "canOpenFile"
  >,
) {
  return projectSource(source, {
    read: (config) => ({
      state: config.state,
      canSet: config.canSet,
      canApply: config.canApply,
      canPatch: config.canPatch,
      canOpenFile: config.canOpenFile,
    }),
    subscribe: (config, notify) => config.subscribe(notify),
    equality: "revision",
  });
}

export function projectSessions(
  source: Pick<
    SessionCapability,
    | "state"
    | "presentation"
    | "revision"
    | "canonicalListRevision"
    | "eventSubscriptionError"
    | "subscribe"
  >,
) {
  return projectSource(source, {
    read: (sessions) => ({
      state: sessions.state,
      presentation: sessions.presentation,
      revision: sessions.revision,
      canonicalListRevision: sessions.canonicalListRevision,
      eventSubscriptionError: sessions.eventSubscriptionError,
    }),
    subscribe: (sessions, notify) => sessions.subscribe(notify),
    equality: "revision",
  });
}

export type SessionListProjectionSource = {
  sessions: Pick<SessionCapability, "listSnapshot" | "subscribeList">;
  scope: SessionListScope;
};

/** Query membership and admission remain with the session capability. */
export function projectSessionList(source: SessionListProjectionSource) {
  return projectSource(source, {
    read: ({ sessions, scope }) => sessions.listSnapshot(scope),
    subscribe: ({ sessions, scope }, notify) => sessions.subscribeList(scope, notify),
    equality: "revision",
  });
}

export function projectSessionCreated(source: Pick<SessionCapability, "subscribeCreated">) {
  return projectEvents<typeof source, string>(source, {
    subscribe: (sessions, listener) => sessions.subscribeCreated(listener),
  });
}
