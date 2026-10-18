import { createProjection, createSignal } from "solid-js";
import { normalizeAgentTargetLabel } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { profileAvatarUrl, profileDirectory } from "../lib/profile-directory.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { projectAgents } from "../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../lib/reactive/gateway-page.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { sessionSelfOwner, type SessionOwnerOption } from "../lib/session-owner.ts";

/** Assignment uses the Gateway directory, independently of session filters and presence. */
export function createSessionOwnerMenu(
  presented: () => boolean = () => true,
  prepare?: () => unknown,
) {
  const context = useOptionalApplication();
  const agents = context ? projectAgents(context.agents) : undefined;
  const identities = context ? projectOwner(context.agentIdentity, (owner) => owner) : undefined;
  const profiles = context
    ? projectOwner(profileDirectory(context.gateway), (directory) => directory)
    : undefined;
  const connection = useGatewayPage({ getGateway: () => context?.gateway });
  const [searchGeneration, setSearchGeneration] = createSignal(0);
  let opened = false;
  const load = () => {
    if (opened) {
      setSearchGeneration((value) => value + 1);
    }
    opened = true;
    void profiles?.read().load(true);
  };
  const readSnapshot = () => {
    const self = sessionSelfOwner(connection.snapshot?.selfUser);
    // Keep a same-connection directory during refresh, never a previous Gateway's result.
    const directory = profiles?.read();
    const owners: SessionOwnerOption[] = (directory?.result?.profiles ?? [])
      .filter((profile) => !profile.mergedInto && profile.id !== self?.id)
      .map((profile) => ({
        type: "human",
        id: profile.id,
        identity: { type: "profile", id: profile.id },
        label:
          profile.displayName?.trim() ||
          profile.githubIdentity?.login ||
          profile.emails[0] ||
          profile.id,
        avatarUrl: profileAvatarUrl(profile),
      }));
    const identityOwner = identities?.read();
    for (const agent of agents?.read().agentsList?.agents ?? []) {
      const identity = identityOwner?.get(agent.id);
      owners.push({
        type: "agent",
        id: agent.id,
        identity: { type: "agent", id: agent.id },
        label: normalizeAgentTargetLabel(agent, identity),
        avatarUrl: resolveAgentAvatarUrl(agent, identity) ?? undefined,
      });
    }
    owners.sort(
      (left, right) =>
        left.type.localeCompare(right.type) ||
        (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
        left.id.localeCompare(right.id),
    );
    if (self) {
      owners.unshift(self);
    }
    return {
      self,
      owners: [...new Map(owners.map((owner) => [owner.type + ":" + owner.id, owner])).values()],
      directory: directory?.result,
      searchGeneration: connection.epoch + searchGeneration(),
      connected: Boolean(connection.snapshot && connection.capture()),
      loading: Boolean(directory?.loading),
      error: directory?.error,
    };
  };
  const snapshot = createParkedProjection(readSnapshot, presented, prepare);
  const rows = createProjection(
    snapshot,
    {},
    {
      key: (row: { type?: string; id?: string }) => `${row.type}:${row.id}`,
    },
  );
  return { load, snapshot: () => rows, multipleOwners: () => rows.owners.length > 1 };
}
