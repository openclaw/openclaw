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

export type ChannelIngressReadCommand =
  | { type: "channelIngress.accounts"; input: { channelId: string } }
  | { type: "channelIngress.failedHealth"; input?: undefined }
  | { type: "channelIngress.pressureHealth"; input: { now: number } };

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
  ok: true;
  sourceAdmitted: true;
} & (
  | { type: "channelIngress.accounts"; result: string[] }
  | { type: "channelIngress.failedHealth"; result: ChannelIngressFailedHealth[] }
  | { type: "channelIngress.pressureHealth"; result: ChannelIngressPressureHealth[] }
);
