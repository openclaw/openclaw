import { ContextConsumer } from "@lit/context";
import type { ReactiveControllerHost } from "lit";
import { applicationContext } from "../app/context.ts";
import { normalizeAgentTargetLabel } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { profileAvatarUrl, profileDirectory } from "../lib/profile-directory.ts";
import { GatewayPageController } from "../lit/gateway-page-controller.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { sessionSelfOwner, type SessionOwnerOption } from "./session-owner-chip.ts";

/** Assignment uses the Gateway directory, independently of session filters and presence. */
export class SessionOwnerMenu {
  private readonly context;
  private readonly connection;
  private searchGeneration = 0;
  private opened = false;

  constructor(host: ReactiveControllerHost & HTMLElement) {
    this.context = new ContextConsumer(host, { context: applicationContext, subscribe: true });
    this.connection = new GatewayPageController(host, {
      getGateway: () => this.context.value?.gateway,
      invalidateRequests: () => {
        this.searchGeneration += 1;
      },
    });
    new SubscriptionsController(host).watchStore(() => this.context.value?.agents);
    new SubscriptionsController(host).watchStore(() => this.directory);
  }

  private get directory() {
    const gateway = this.context.value?.gateway;
    return gateway ? profileDirectory(gateway) : undefined;
  }

  readonly load = () => {
    if (this.opened) {
      this.searchGeneration += 1;
    }
    this.opened = true;
    void this.directory?.load(true);
  };

  private ownerOptions() {
    const context = this.context.value;
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
    for (const agent of context?.agents.state.agentsList?.agents ?? []) {
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
      connected: Boolean(this.connection.capture()),
      loading: Boolean(directory?.loading),
      error: directory?.error,
    };
  }

  get multipleOwners(): boolean {
    return this.ownerOptions().owners.length > 1;
  }
}
