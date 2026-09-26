import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ChannelIngressFailedHealth = {
  channelId: string;
  accountId: string;
  count: number;
  oldestFailedAt?: number;
};

export type ChannelIngressPressureHealth = {
  channelId: string;
  accountId: string;
  laneCount: number;
  pendingCount: number;
  claimedCount: number;
  blockedCount: number;
  oldestReceivedAt: number;
};

type ChannelIngressReadOperations = {
  "channelIngress.accounts": { input: { channelId: string }; output: string[] };
  "channelIngress.failedHealth": { input: undefined; output: ChannelIngressFailedHealth[] };
  "channelIngress.pressureHealth": {
    input: { now: number };
    output: ChannelIngressPressureHealth[];
  };
};

export type ChannelIngressReadCommand = {
  [Kind in keyof ChannelIngressReadOperations]: {
    type: Kind;
  } & (ChannelIngressReadOperations[Kind]["input"] extends undefined
    ? { input?: undefined }
    : { input: ChannelIngressReadOperations[Kind]["input"] });
}[keyof ChannelIngressReadOperations];

export function isChannelIngressReadCommand(value: unknown): value is ChannelIngressReadCommand {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "channelIngress.failedHealth") {
    return value.input === undefined;
  }
  if (value.type === "channelIngress.accounts") {
    return isRecord(value.input) && typeof value.input.channelId === "string";
  }
  return (
    value.type === "channelIngress.pressureHealth" &&
    isRecord(value.input) &&
    typeof value.input.now === "number"
  );
}

export type ChannelIngressReadReply = {
  [Kind in keyof ChannelIngressReadOperations]: {
    ok: true;
    type: Kind;
    sourceAdmitted: true;
    result: ChannelIngressReadOperations[Kind]["output"];
  };
}[keyof ChannelIngressReadOperations];
