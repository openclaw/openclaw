import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ChannelIngressFailedHealth = {
  channelId: string;
  accountId: string;
  count: number;
  oldestFailedAt?: number;
};

type ChannelIngressReadOperations = {
  "channelIngress.failedHealth": { input: undefined; output: ChannelIngressFailedHealth[] };
};

export type ChannelIngressReadCommand = {
  [Kind in keyof ChannelIngressReadOperations]: {
    type: Kind;
  } & (ChannelIngressReadOperations[Kind]["input"] extends undefined
    ? { input?: undefined }
    : { input: ChannelIngressReadOperations[Kind]["input"] });
}[keyof ChannelIngressReadOperations];

export function isChannelIngressReadCommand(value: unknown): value is ChannelIngressReadCommand {
  return (
    isRecord(value) && value.type === "channelIngress.failedHealth" && value.input === undefined
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
