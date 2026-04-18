import type { ChannelPairingAdapter } from "./types.adapters.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("channels-pairing");

type PairingNotifyParams = Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0];

export function createPairingPrefixStripper(
  prefixRe: RegExp,
  map: (entry: string) => string = (entry) => entry,
): NonNullable<ChannelPairingAdapter["normalizeAllowEntry"]> {
  return (entry) => map(entry.trim().replace(prefixRe, "").trim());
}

export function createLoggedPairingApprovalNotifier(
  format: string | ((params: PairingNotifyParams) => string),
  logFn: (message: string) => void = (message) => log.info(message),
): NonNullable<ChannelPairingAdapter["notifyApproval"]> {
  return async (params) => {
    logFn(typeof format === "function" ? format(params) : format);
  };
}

export function createTextPairingAdapter(params: {
  idLabel: string;
  message: string;
  normalizeAllowEntry?: ChannelPairingAdapter["normalizeAllowEntry"];
  notify: (params: PairingNotifyParams & { message: string }) => Promise<void> | void;
}): ChannelPairingAdapter {
  return {
    idLabel: params.idLabel,
    normalizeAllowEntry: params.normalizeAllowEntry,
    notifyApproval: async (ctx) => {
      await params.notify({ ...ctx, message: params.message });
    },
  };
}
