/**
 * Channel plugin setup/config adapter type contracts.
 *
 * Kept as a leaf contract so setup wizard types do not pull the full adapter barrel.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChannelAccountSnapshot, ChannelSetupInput } from "./types.core.js";

type ChannelAdapterCallback<T extends (...args: never[]) => unknown> = T;

export type ChannelSetupAdapter = {
  resolveAccountId?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    input?: ChannelSetupInput;
  }) => string;
  resolveBindingAccountId?: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    accountId?: string;
  }) => string | undefined;
  applyAccountName?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    name?: string;
  }) => OpenClawConfig;
  applyAccountConfig: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => OpenClawConfig;
  afterAccountConfigWritten?: (params: {
    previousCfg: OpenClawConfig;
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
    runtime: RuntimeEnv;
  }) => Promise<void> | void;
  validateInput?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => string | null;
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: (params: {
    channel: Record<string, unknown>;
  }) => string | undefined;
};

export type ChannelConfigAdapter<ResolvedAccount> = {
  listAccountIds: (cfg: OpenClawConfig) => string[];
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
  defaultAccountId?: (cfg: OpenClawConfig) => string;
  setAccountEnabled?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    enabled: boolean;
  }) => OpenClawConfig;
  deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
  isEnabled?: ChannelAdapterCallback<(account: ResolvedAccount, cfg: OpenClawConfig) => boolean>;
  disabledReason?: ChannelAdapterCallback<
    (account: ResolvedAccount, cfg: OpenClawConfig) => string
  >;
  isConfigured?: ChannelAdapterCallback<
    (account: ResolvedAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>
  >;
  unconfiguredReason?: ChannelAdapterCallback<
    (account: ResolvedAccount, cfg: OpenClawConfig) => string
  >;
  describeAccount?: ChannelAdapterCallback<
    (account: ResolvedAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot
  >;
  resolveAllowFrom?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Array<string | number> | undefined;
  formatAllowFrom?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    allowFrom: Array<string | number>;
  }) => string[];
  hasConfiguredState?: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
  hasPersistedAuthState?: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
  resolveDefaultTo?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string | undefined;
};
