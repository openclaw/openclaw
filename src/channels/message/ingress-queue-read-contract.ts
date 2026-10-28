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

export type ChannelIngressPressureSnapshot = {
  pressure: ChannelIngressPressureHealth[];
  nextClaimExpiryAtMs: number | null;
};

export type ChannelIngressHealthErrors = { failed?: string; pressure?: string };

export type ChannelIngressHealthSnapshot = {
  failed?: ChannelIngressFailedHealth[];
  pressure?: ChannelIngressPressureSnapshot;
  errors: ChannelIngressHealthErrors;
};

export type ChannelIngressReadCommand =
  | { type: "channelIngress.accounts"; input: { channelId: string } }
  | { type: "channelIngress.failedHealth"; input?: undefined }
  | { type: "channelIngress.health"; input: { now: number; failed: boolean; pressure: boolean } };

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
    value.type === "channelIngress.health" &&
    isRecord(value.input) &&
    typeof value.input.now === "number" &&
    typeof value.input.failed === "boolean" &&
    typeof value.input.pressure === "boolean"
  );
}

export type ChannelIngressReadReply = {
  ok: true;
  sourceAdmitted: true;
} & (
  | { type: "channelIngress.accounts"; result: string[] }
  | { type: "channelIngress.failedHealth"; result: ChannelIngressFailedHealth[] }
  | { type: "channelIngress.health"; result: ChannelIngressHealthSnapshot }
);
