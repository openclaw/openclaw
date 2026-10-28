import { managedGitLabCallbackRequestId } from "../../../../src/shared/gitlab-oauth-callback.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { takeGitLabOAuthCallback } from "./gitlab-oauth-callback.ts";

export type GitLabConnectionStatus = {
  configured: boolean;
  issuer?: string;
  connected?: boolean;
  pendingRequestId?: string;
  account?: {
    accountId: number;
    login: string;
  } | null;
  scopes?: string[];
  reconnectRequired?: boolean;
  verificationUnavailable?: boolean;
};

type PendingAuthorization = {
  requestId: string;
  authorizationUrl: string;
  expiresAtMs: number;
};

export type GitLabConnectionView = {
  eligible: boolean;
  loading: boolean;
  busy: boolean;
  status: GitLabConnectionStatus | null;
  pending: PendingAuthorization | null;
  error: string | null;
};

/** A server selection is an HTTPS origin, never a repository or authorization URL. */
export function gitLabServerOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function isGitLabAuthorizationUrl(raw: string, issuer: string | undefined): boolean {
  try {
    const url = new URL(raw);
    const authority = new URL(issuer ?? "");
    return (
      url.protocol === "https:" &&
      url.origin === authority.origin &&
      url.pathname === "/oauth/authorize" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Presentation owner only. The Gateway owns tokens, identity, and authorization. */
export class GitLabConnectionsState {
  constructor(private readonly onManagedComplete?: () => void | Promise<void>) {}
  view: GitLabConnectionView = {
    eligible: false,
    loading: false,
    busy: false,
    status: null,
    pending: null,
    error: null,
  };
  private client: GatewayBrowserClient | null = null;
  private profileId: string | null = null;
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
    return this.client === client && this.generation === generation && this.sequence === sequence;
  }

  sync(snapshot: ApplicationGatewaySnapshot): boolean {
    const eligible =
      snapshot.phase === "connected" &&
      Boolean(snapshot.client && snapshot.selfUser?.id && snapshot.hello?.auth) &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    const client = eligible ? snapshot.client : null;
    const profileId = eligible ? (snapshot.selfUser?.id ?? null) : null;
    if (client === this.client && profileId === this.profileId && eligible === this.view.eligible) {
      return false;
    }
    this.generation += 1;
    this.sequence += 1;
    this.client = client;
    this.profileId = profileId;
    this.view = {
      eligible,
      loading: eligible,
      busy: false,
      status: null,
      pending: null,
      error: null,
    };
    this.publish();
    if (client) {
      void this.loadStatus();
    }
    return true;
  }

  async loadStatus() {
    const client = this.client;
    if (!client) {
      return;
    }
    const generation = this.generation;
    const sequence = ++this.sequence;
    this.view = { ...this.view, loading: true, error: null };
    this.publish();
    try {
      const status = await client.request<GitLabConnectionStatus>("users.gitlab.status", {});
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = { ...this.view, loading: false, status };
      const callbackUrl = takeGitLabOAuthCallback();
      if (callbackUrl) {
        this.publish();
        await this.complete(callbackUrl);
        return;
      }
    } catch {
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        loading: false,
        error: "Could not load your GitLab connection. Try again.",
      };
    }
    this.publish();
  }

  async start(serverUrl?: string) {
    const client = this.client;
    if (!client || !this.view.status?.configured || this.view.busy) {
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
    const generation = this.generation;
    const sequence = ++this.sequence;
    this.view = { ...this.view, busy: true, pending: null, error: null };
    this.publish();
    try {
      const pending = await client.request<PendingAuthorization>(
        "users.gitlab.authorize.start",
        {},
      );
      if (!this.current(client, generation, sequence)) {
        return;
      }
      if (!isGitLabAuthorizationUrl(pending.authorizationUrl, issuer)) {
        throw new Error("Invalid GitLab authorization URL");
      }
      this.view = {
        ...this.view,
        busy: false,
        pending,
        status: { ...this.view.status!, connected: false, account: null },
      };
    } catch {
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        busy: false,
        pending: null,
        error: "Could not start GitLab sign-in. Try again.",
      };
    }
    this.publish();
  }

  async complete(callbackUrl: string) {
    const client = this.client;
    const managedRequestId = managedGitLabCallbackRequestId(callbackUrl);
    const requestId =
      managedRequestId ?? this.view.pending?.requestId ?? this.view.status?.pendingRequestId;
    if (!client || this.view.busy || !callbackUrl.trim()) {
      return;
    }
    if (!requestId) {
      this.view = {
        ...this.view,
        error: "GitLab sign-in expired or changed. Connect GitLab again.",
      };
      this.publish();
      return;
    }
    const generation = this.generation;
    const sequence = ++this.sequence;
    this.view = { ...this.view, busy: true, error: null };
    this.publish();
    let managedAccepted = false;
    try {
      let status: GitLabConnectionStatus;
      if (managedRequestId) {
        await client.request("tools.gitlab.authorize.complete", {
          requestId,
          callbackUrl: callbackUrl.trim(),
        });
        managedAccepted = true;
        if (!this.current(client, generation, sequence)) {
          return;
        }
        await this.onManagedComplete?.();
        if (!this.current(client, generation, sequence)) {
          return;
        }
        status = await client.request<GitLabConnectionStatus>("users.gitlab.status", {});
      } else {
        status = await client.request<GitLabConnectionStatus>("users.gitlab.authorize.complete", {
          requestId,
          callbackUrl: callbackUrl.trim(),
        });
      }
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = { ...this.view, busy: false, pending: null, status };
    } catch {
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        busy: false,
        pending: null,
        error: managedAccepted
          ? "GitLab authorization was accepted. Verify the selected connection to refresh its status."
          : managedRequestId
            ? "GitLab authorization could not be confirmed. Verify the selected connection before retrying."
            : "Could not complete GitLab sign-in. Start again.",
      };
    }
    this.publish();
  }

  async disconnect() {
    const client = this.client;
    if (!client || !this.view.status?.configured || this.view.busy) {
      return;
    }
    const generation = this.generation;
    const sequence = ++this.sequence;
    this.view = { ...this.view, busy: true, error: null };
    this.publish();
    try {
      await client.request("users.gitlab.disconnect", {});
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        busy: false,
        pending: null,
        status: { ...this.view.status!, connected: false, account: null, scopes: [] },
      };
    } catch {
      if (!this.current(client, generation, sequence)) {
        return;
      }
      this.view = {
        ...this.view,
        busy: false,
        error: "Could not disconnect GitLab. Try again.",
      };
    }
    this.publish();
  }

  dispose() {
    this.generation += 1;
    this.sequence += 1;
    this.client = null;
    this.listeners.clear();
  }
}
