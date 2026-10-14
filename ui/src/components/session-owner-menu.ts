import { normalizeAgentTargetLabel } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { profileAvatarUrl, profileDirectory } from "../lib/profile-directory.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { projectAgents } from "../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../lib/reactive/gateway-page.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { sessionSelfOwner, type SessionOwnerOption } from "./session-owner-chip.ts";

/** Assignment uses the Gateway directory, independently of session filters and presence. */
export class SessionOwnerMenu {
  private readonly context = useOptionalApplication();
  private readonly agents = this.context ? projectAgents(this.context.agents) : undefined;
  private readonly profiles = this.context
    ? projectSource(profileDirectory(this.context.gateway), {
        read: (directory) => directory,
        subscribe: (directory, notify) => directory.subscribe(notify),
        equality: "revision",
      })
    : undefined;
  private readonly connection = useGatewayPage({
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.searchGeneration += 1;
    },
  });
  private searchGeneration = 0;
  private opened = false;

  constructor(private readonly host: { requestUpdate(): void }) {}

  private get directory() {
    return this.profiles?.read();
  }

  readonly load = () => {
    if (this.opened) {
      this.searchGeneration += 1;
    }
    this.opened = true;
    void this.directory?.load(true);
    this.host.requestUpdate();
  };

  private ownerOptions() {
    const context = this.context;
    const self = sessionSelfOwner(context?.gateway.snapshot.selfUser);
    // Keep a same-connection directory during refresh, never a previous Gateway's result.
    const directory = this.directory?.result;
    const owners: SessionOwnerOption[] = (directory?.profiles ?? [])
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
    for (const agent of this.agents?.read().agentsList?.agents ?? []) {
      const identity = context?.agentIdentity.get(agent.id);
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
      directory,
    };
  }

  get snapshot() {
    const directory = this.directory;
    return {
      ...this.ownerOptions(),
      searchGeneration: this.searchGeneration,
      connected: Boolean(this.connection.snapshot && this.connection.capture()),
      loading: Boolean(directory?.loading),
      error: directory?.error,
    };
  }

  get multipleOwners(): boolean {
    return this.ownerOptions().owners.length > 1;
  }
}
