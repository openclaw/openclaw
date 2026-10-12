import type { AgentCapability } from "../agents/index.ts";
import type { rosterActivityStore } from "../agents/roster-activity-store.ts";
import type { ChannelCapability } from "../channels/index.ts";
import type { RuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import type { SessionCapability, SessionListScope } from "../sessions/session-capability.ts";
import { projectOwner, projectSource } from "./projection.ts";

/** These owners mutate synchronously; every publication invalidates their projection. */
export function projectAgents(source: Pick<AgentCapability, "state" | "subscribe">) {
  return projectOwner(source, (agents) => agents.state);
}

export function projectRosterActivity(
  source: Pick<ReturnType<typeof rosterActivityStore>, "snapshot" | "subscribe">,
) {
  return projectOwner(source, (roster) => roster.snapshot);
}

export function projectChannels(source: Pick<ChannelCapability, "state" | "subscribe">) {
  return projectOwner(source, (channels) => channels.state);
}

export function projectRuntimeConfig(
  source: Pick<
    RuntimeConfigCapability,
    "state" | "subscribe" | "canSet" | "canApply" | "canPatch" | "canOpenFile"
  >,
) {
  return projectOwner(source, (config) => ({
    state: config.state,
    canSet: config.canSet,
    canApply: config.canApply,
    canPatch: config.canPatch,
    canOpenFile: config.canOpenFile,
  }));
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
