import { callGateway } from "../../gateway/call.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

export type ChannelLifecycleAction = "start" | "stop" | "restart";

export type ChannelsLifecycleOptions = {
  channel?: string;
  account?: string;
  json?: boolean;
};

type ChannelLifecyclePayload = {
  channel?: string;
  accountId?: string;
  started?: boolean;
  stopped?: boolean;
};

function resolveRequiredChannel(raw: string | undefined): string {
  const channel = raw?.trim();
  if (!channel) {
    throw new Error("Channel is required (--channel <name>).");
  }
  return channel;
}

function resolveOptionalAccount(raw: string | undefined): string | undefined {
  const account = raw?.trim();
  return account || undefined;
}

function formatChannelAccount(payload: ChannelLifecyclePayload, fallbackChannel: string) {
  const channel = payload.channel || fallbackChannel;
  const accountId = payload.accountId || "default";
  return `${channel}/${accountId}`;
}

function formatLifecycleResult(action: ChannelLifecycleAction, payload: ChannelLifecyclePayload) {
  const target = formatChannelAccount(payload, payload.channel || "channel");
  if (action === "start") {
    return payload.started === false
      ? `Start requested for ${target}, but the runtime still reports stopped.`
      : `Started ${target}.`;
  }
  if (action === "stop") {
    return payload.stopped === false
      ? `Stop requested for ${target}, but the runtime still reports running.`
      : `Stopped ${target}.`;
  }
  if (payload.stopped === false) {
    return `Restart requested for ${target}, but the stop phase did not complete.`;
  }
  return payload.started === false
    ? `Restart requested for ${target}, but the runtime still reports stopped.`
    : `Restarted ${target}.`;
}

export async function channelsLifecycleCommand(
  action: ChannelLifecycleAction,
  opts: ChannelsLifecycleOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const channel = resolveRequiredChannel(opts.channel);
  const accountId = resolveOptionalAccount(opts.account);
  const payload = (await callGateway({
    method: `channels.${action}`,
    params: {
      channel,
      ...(accountId ? { accountId } : {}),
    },
  })) as ChannelLifecyclePayload;

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(formatLifecycleResult(action, payload));
}
