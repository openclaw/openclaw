import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { SidebarSessionMutationScope } from "./app-sidebar-session-types.ts";

export function captureSessionMutationScope(
  context: ApplicationContext | undefined,
  options: Pick<SidebarSessionMutationScope, "epoch" | "allowDeferred" | "selectedAgentId"> & {
    signal: AbortSignal;
  },
): (SidebarSessionMutationScope & { signal: AbortSignal }) | null {
  const gateway = context?.gateway;
  const client = gateway?.snapshot.client;
  if (
    !context ||
    !gateway ||
    !client ||
    gateway.snapshot.phase === "stopped" ||
    (gateway.snapshot.phase !== "connected" &&
      (!options.allowDeferred || !gateway.snapshot.hello || client.offlineRecoveryRetired))
  ) {
    return null;
  }
  return { ...options, context, gateway, sessions: context.sessions, client };
}

export function isSessionMutationScopeCurrent(
  context: ApplicationContext | undefined,
  scope: SidebarSessionMutationScope,
  currentEpoch?: number,
): boolean {
  const gateway = context?.gateway;
  return (
    (currentEpoch === undefined || currentEpoch === scope.epoch) &&
    context === scope.context &&
    gateway === scope.gateway &&
    context.sessions === scope.sessions &&
    (gateway.snapshot.phase === "connected" ||
      (scope.allowDeferred === true &&
        gateway.snapshot.phase !== "stopped" &&
        Boolean(gateway.snapshot.hello) &&
        !scope.client.offlineRecoveryRetired)) &&
    gateway.snapshot.client === scope.client
  );
}

/** Destructive confirmations follow request epochs; editable drafts follow identity. */
export class SessionMutationOwner {
  private epoch = 0;
  private scopeAbort = new AbortController();
  private draftAbort = new AbortController();
  private draftOwner: number | undefined;
  private draftAuth: { role?: string; scopes?: readonly string[] } | undefined;

  get draftSignal(): AbortSignal {
    return this.draftAbort.signal;
  }

  retireScope(): void {
    this.epoch += 1;
    // A confirm opened under the old epoch must dismiss before another can open.
    this.scopeAbort.abort();
    this.scopeAbort = new AbortController();
  }

  retireDrafts(): void {
    this.draftAbort.abort();
    this.draftAbort = new AbortController();
  }

  disconnectDrafts(): void {
    this.retireDrafts();
    this.draftAuth = undefined;
  }

  synchronizeDrafts(gateway: ApplicationContext["gateway"]): void {
    const owner = gatewayPresentationScope(gateway).key;
    const auth = gateway.snapshot.phase === "connected" ? gateway.snapshot.hello?.auth : undefined;
    if (
      (this.draftOwner !== undefined && this.draftOwner !== owner) ||
      (auth &&
        auth !== this.draftAuth &&
        this.draftAuth?.scopes &&
        !roleScopesAllow({
          role: auth.role ?? "operator",
          requestedScopes: this.draftAuth.scopes,
          allowedScopes: auth.scopes ?? [],
        }))
    ) {
      this.retireDrafts();
    }
    this.draftOwner = owner;
    if (auth) {
      this.draftAuth = auth;
    }
  }

  capture(
    context: ApplicationContext,
    options: Pick<SidebarSessionMutationScope, "allowDeferred" | "selectedAgentId">,
  ): SidebarSessionMutationScope | null {
    return captureSessionMutationScope(context, {
      ...options,
      epoch: this.epoch,
      signal: this.scopeAbort.signal,
    });
  }

  isCurrent(context: ApplicationContext, scope: SidebarSessionMutationScope): boolean {
    return isSessionMutationScopeCurrent(context, scope, this.epoch);
  }
}
