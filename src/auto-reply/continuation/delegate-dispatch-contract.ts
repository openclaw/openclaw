import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { ChainState } from "./scheduler.js";
import type { ContinuationRuntimeConfig } from "./types.js";

export type DelegateDispatchContext = {
  sessionKey: string;
  /** Trusted owner captured by the originating run; never model-supplied. */
  ownerAgentId?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  /** The Gateway a delegate's operator grant is restored on when no request scope names one. */
  resolveGatewayContext?: GatewayContextResolver;
};

export type DelegateDispatchParams = {
  sessionKey: string;
  chainState: ChainState;
  ctx: DelegateDispatchContext;
  maxChainLength: number;
  /**
   * Resolved runtime config for the active run. Callers with scoped/runtime
   * snapshots should pass it so delegate caps match the turn that queued them.
   */
  config?: ContinuationRuntimeConfig;
  /**
   * Optional callback the hedge timer invokes to re-load the chain state
   * from the persisted session entry at fire time.
   */
  loadFreshChainState?: () => ChainState;
  recoverRunningDelegates?: boolean;
  queuedCreatedAtOrBefore?: number;
  includeRunningUpdatedAtOrBefore?: number;
  dispatchQueuedRegardlessOfDelay?: boolean;
  applyDelegateChainTokensFold?: boolean;
  persistChainState?: (chainState: ChainState) => void | Promise<void>;
  persistBeforeTerminalCommit?: boolean;
  inheritedSilent?: boolean;
  inheritedWake?: boolean;
};

export type DelegateDispatchResult = {
  dispatched: number;
  rejected: number;
  chainState: ChainState;
  appliedChainTokensFold?: number;
  chainStatePersistedBeforeTerminalCommit?: boolean;
};
