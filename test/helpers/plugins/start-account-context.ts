import { vi } from "vitest";
import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
} from "../../../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import { createRuntimeEnv } from "./runtime-env.js";

export function createStartAccountContext<TAccount extends { accountId: string }>(params: {
  account: TAccount;
  abortSignal?: AbortSignal;
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  statusPatchSink?: (next: ChannelAccountSnapshot) => void;
}): ChannelGatewayContext<TAccount> {
  const snapshot: ChannelAccountSnapshot = {
    accountId: params.account.accountId,
    configured: true,
    enabled: true,
    running: false,
  };
  return {
    accountId: params.account.accountId,
    account: params.account,
    cfg: params.cfg ?? ({} as OpenClawConfig),
    runtime: params.runtime ?? createRuntimeEnv(),
    abortSignal: params.abortSignal ?? new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => snapshot,
    setStatus: (next) => {
      Object.assign(snapshot, next);
      params.statusPatchSink?.(snapshot);
    },
  };
}
