import type { ChannelPairingAdapter } from "./types.adapters.js";

type PairingNotifyParams = Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0];

export function createPairingPrefixStripper(
  prefixRe: RegExp,
  map: (entry: string) => string = (entry) => entry,
): NonNullable<ChannelPairingAdapter["normalizeAllowEntry"]> {
  return (entry) => map(entry.trim().replace(prefixRe, "").trim());
}

export function createLoggedPairingApprovalNotifier(
  format: string | ((params: PairingNotifyParams) => string),
  log: (message: string) => void = console.log,
): NonNullable<ChannelPairingAdapter["notifyApproval"]> {
  return async (params) => {
    log(typeof format === "function" ? format(params) : format);
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
