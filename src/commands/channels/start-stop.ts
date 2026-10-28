// Thin CLI adapter for existing channels.start / channels.stop Gateway RPCs.
import { formatCliJsonFailure, rethrowExpectedCliError } from "../../cli/failure-output.js";
import { callGatewayFromCliWithTransport, type GatewayRpcOpts } from "../../cli/gateway-rpc.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { parseAccountSelector } from "./account-selector.js";

export type ChannelsStartStopCliOptions = GatewayRpcOpts & {
  channel: string;
  account?: string;
};

export type ChannelsStartResult = {
  channel: string;
  accountId: string;
  started: boolean;
  outcome?: unknown;
  statusIssues?: unknown;
};

export type ChannelsStopResult = {
  channel: string;
  accountId: string;
  stopped: boolean;
};

function rpcOpts(opts: ChannelsStartStopCliOptions): GatewayRpcOpts {
  return {
    url: opts.url,
    port: opts.port,
    token: opts.token,
    password: opts.password,
    timeout: opts.timeout,
    json: opts.json,
  };
}

function resolveParams(opts: ChannelsStartStopCliOptions): {
  channel: string;
  accountId?: string;
} {
  const channel = opts.channel?.trim();
  if (!channel) {
    throw new Error("--channel is required.");
  }
  // Only omission selects the default account; blank --account fails closed.
  const accountId = parseAccountSelector(opts.account);
  return accountId === undefined ? { channel } : { channel, accountId };
}

async function callChannelLifecycle<T>(
  method: "channels.start" | "channels.stop",
  opts: ChannelsStartStopCliOptions,
  runtime: RuntimeEnv,
): Promise<T | undefined> {
  try {
    const result = await callGatewayFromCliWithTransport<T>(
      method,
      rpcOpts(opts),
      resolveParams(opts),
      { defaultTimeoutMs: 60_000 },
    );
    writeRuntimeJson(runtime, result);
    return result;
  } catch (err) {
    rethrowExpectedCliError(err);
    writeRuntimeJson(runtime, formatCliJsonFailure(formatErrorMessage(err)));
    runtime.exit(1);
    return undefined;
  }
}

/** Start one channel account runtime without re-authenticating (channels.start). */
export async function channelsStartCommand(
  opts: ChannelsStartStopCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  await callChannelLifecycle<ChannelsStartResult>("channels.start", opts, runtime);
}

/** Stop one channel account runtime without clearing credentials (channels.stop). */
export async function channelsStopCommand(
  opts: ChannelsStartStopCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  await callChannelLifecycle<ChannelsStopResult>("channels.stop", opts, runtime);
}

/**
 * Non-destructive reconnect: channels.stop then channels.start for the same account.
 * Prints a combined JSON object with both Gateway payloads.
 */
export async function channelsReconnectCommand(
  opts: ChannelsStartStopCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  try {
    const params = resolveParams(opts);
    const transport = rpcOpts(opts);
    const stop = await callGatewayFromCliWithTransport<ChannelsStopResult>(
      "channels.stop",
      transport,
      params,
      { defaultTimeoutMs: 60_000 },
    );
    const start = await callGatewayFromCliWithTransport<ChannelsStartResult>(
      "channels.start",
      transport,
      params,
      { defaultTimeoutMs: 60_000 },
    );
    writeRuntimeJson(runtime, { stop, start });
  } catch (err) {
    rethrowExpectedCliError(err);
    writeRuntimeJson(runtime, formatCliJsonFailure(formatErrorMessage(err)));
    runtime.exit(1);
  }
}
