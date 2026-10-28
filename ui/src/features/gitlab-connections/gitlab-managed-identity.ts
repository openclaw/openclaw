import type { ToolsGitLabStatusResult } from "../../../../packages/gateway-protocol/src/schema/gitlab.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import { gitLabServerOrigin, isGitLabAuthorizationUrl } from "./gitlab-connections-state.ts";

export type GitLabManagedTarget = { scope: "system" | "agent"; agentId: string };
type Pending = { requestId: string; authorizationUrl: string; expiresAtMs: number };
export type GitLabManagedIdentityView = {
  eligible: boolean;
  canAdmin: boolean;
  loading: boolean;
  busy: boolean;
  status: ToolsGitLabStatusResult | null;
  pending: Pending | null;
  error: string | null;
};
const empty = (): GitLabManagedIdentityView => ({
  eligible: false,
  canAdmin: false,
  loading: false,
  busy: false,
  status: null,
  pending: null,
  error: null,
});

/** One managed target owner; all writes remain authenticated Gateway decisions. */
export class GitLabManagedIdentityState {
  view = empty();
  private client: GatewayBrowserClient | null = null;
  private profileId: string | null = null;
  private target: GitLabManagedTarget | null = null;
  private generation = 0;
  private sequence = 0;
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish() {
    for (const listener of this.listeners) {
      listener();
    }
  }
  private current(client: GatewayBrowserClient, generation: number, sequence: number) {
    return client === this.client && generation === this.generation && sequence === this.sequence;
  }
  sync(snapshot: ApplicationGatewaySnapshot, target: GitLabManagedTarget | null) {
    const eligible =
      snapshot.phase === "connected" &&
      Boolean(snapshot.client && snapshot.selfUser?.id && snapshot.hello?.auth) &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null) &&
      target !== null;
    const client = eligible ? snapshot.client : null;
    const profile = eligible ? snapshot.selfUser!.id : null;
    const canAdmin = eligible && hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    if (
      client === this.client &&
      profile === this.profileId &&
      canAdmin === this.view.canAdmin &&
      target?.scope === this.target?.scope &&
      target?.agentId === this.target?.agentId &&
      eligible === this.view.eligible
    ) {
      return;
    }
    this.client = client;
    this.profileId = profile;
    this.target = target;
    this.generation++;
    this.sequence++;
    this.view = { ...empty(), eligible, canAdmin };
    this.publish();
    if (eligible) {
      void this.verify();
    }
  }
  async verify() {
    const client = this.client,
      target = this.target;
    if (!client || !target || this.view.busy) {
      return;
    }
    const generation = this.generation,
      sequence = ++this.sequence;
    this.view = { ...this.view, loading: true, error: null };
    this.publish();
    try {
      const status = await client.request<ToolsGitLabStatusResult>("tools.gitlab.status", {
        agentId: target.agentId,
        selectedScope: target.scope,
      });
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = { ...this.view, status, loading: false };
    } catch {
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        loading: false,
        error: "Could not verify this GitLab connection. Try again.",
      };
    }
    this.publish();
  }
  async start(serverUrl?: string) {
    const client = this.client,
      target = this.target;
    if (
      !client ||
      !target ||
      !this.view.canAdmin ||
      this.view.busy ||
      !this.view.status?.configured
    ) {
      return;
    }
    const issuer = this.view.status.issuer;
    const selectedIssuer = serverUrl === undefined ? issuer : gitLabServerOrigin(serverUrl);
    if (!selectedIssuer || selectedIssuer !== issuer) {
      this.view = {
        ...this.view,
        pending: null,
        error: "This GitLab server needs administrator OAuth setup before connecting.",
      };
      this.publish();
      return;
    }
    const generation = this.generation,
      sequence = ++this.sequence;
    this.view = { ...this.view, busy: true, pending: null, error: null };
    this.publish();
    try {
      const pending = await client.request<Pending>("tools.gitlab.authorize.start", target);
      if (!this.current(client, generation, sequence)) {
        return;
      }
      if (!isGitLabAuthorizationUrl(pending.authorizationUrl, issuer)) {
        throw new Error("Invalid authorization URL");
      }
      this.view = { ...this.view, busy: false, pending };
    } catch {
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        busy: false,
        error: "Could not start GitLab authorization for this target. Try again.",
      };
    }
    this.publish();
  }
  async inherit() {
    const client = this.client,
      target = this.target;
    if (!client || !target || !this.view.canAdmin || this.view.busy) {
      return;
    }
    const generation = this.generation,
      sequence = ++this.sequence;
    this.view = { ...this.view, busy: true, error: null };
    this.publish();
    try {
      await client.request("tools.gitlab.configure", { ...target, mode: "inherit" });
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = { ...this.view, busy: false, pending: null };
      await this.verify();
      return;
    } catch {
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        busy: false,
        error: "Could not change this GitLab selection. Verify its current state before retrying.",
      };
    }
    this.publish();
  }
  async cancel() {
    const client = this.client,
      requestId = this.view.pending?.requestId;
    if (!client || !requestId || !this.view.canAdmin || this.view.busy) {
      return;
    }
    const generation = this.generation,
      sequence = ++this.sequence;
    this.view = { ...this.view, busy: true, error: null };
    this.publish();
    try {
      const result = await client.request<{ cancelled: boolean }>("tools.gitlab.authorize.cancel", {
        requestId,
      });
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        busy: false,
        pending: result.cancelled ? null : this.view.pending,
        error: result.cancelled
          ? null
          : "Connection activation is already in progress. Verify its result.",
      };
    } catch {
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        busy: false,
        error: "Could not cancel authorization. Verify its current state.",
      };
    }
    this.publish();
  }
  dispose() {
    this.generation++;
    this.sequence++;
    this.client = null;
    this.profileId = null;
    this.target = null;
    this.view = empty();
    this.listeners.clear();
  }
}
