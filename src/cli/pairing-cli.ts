import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import type {
  ChannelsPairingCliListResult,
  ChannelsPairingCodeApproveResult,
  ChannelsPairingRemoveResult,
} from "../../packages/gateway-protocol/src/schema/channel-pairing.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  getTerminalTableWidth,
  renderTerminalSafeTable,
} from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { listPairingChannels, notifyPairingApproved } from "../channels/plugins/pairing.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { bootstrapCommandOwnerFromPairing } from "../pairing/command-owner.js";
import { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  removeChannelAllowFromStore,
} from "../pairing/pairing-store.js";
import type { PairingChannel } from "../pairing/pairing-store.types.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { throwExpectedCliError } from "./expected-cli-error.js";
import { formatDocsHelp } from "./help-format.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

/** Parse channel, allowing extension channels not in core registry. */
function parseChannel(raw: unknown, channels: PairingChannel[]): PairingChannel {
  const value = normalizeLowercaseStringOrEmpty(normalizeStringifiedOptionalString(raw) ?? "");
  if (!value) {
    throwExpectedCliError(
      `Missing channel. Use ${formatCliCommand("openclaw pairing list --channel <channel>")}.`,
    );
  }

  const normalized = normalizeChannelId(value);
  if (normalized) {
    if (!channels.includes(normalized)) {
      throwExpectedCliError(
        `Channel "${normalized}" does not support pairing. Supported pairing channels: ${channels.join(", ") || "none"}.`,
      );
    }
    return normalized;
  }

  // Allow extension channels: validate format but don't require registry
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    return value as PairingChannel;
  }
  return throwExpectedCliError(
    `Invalid channel "${value}". Use lowercase letters, numbers, "_" or "-", for example "telegram".`,
  );
}

function resolveAccountId(raw: unknown): string | undefined {
  const accountId = normalizeStringifiedOptionalString(raw);
  // Omission intentionally leaves pairing unscoped; an explicit blank must not
  // silently remove the account restriction.
  if (raw !== undefined && !accountId) {
    throwExpectedCliError("--account must not be blank");
  }
  return accountId;
}

export function registerPairingCli(program: Command) {
  const channels = listPairingChannels();
  // Avoid rendering a bare "()" enum when no channels are configured.
  const channelHint = channels.length > 0 ? channels.join(", ") : "none configured";
  const pairing = program
    .command("pairing")
    .description("Secure DM pairing (approve inbound requests, remove approved senders)")
    .addHelpText("after", () => formatDocsHelp("/cli/pairing"));

  pairing
    .command("list")
    .description("List pending pairing requests")
    .option("--channel <channel>", `Channel (${channelHint})`)
    .option("--account <accountId>", "Account id (for multi-account channels)")
    .argument("[channel]", `Channel (${channelHint})`)
    .option("--json", "Print JSON", false)
    .action(async (channelArg, opts) => {
      const channelRaw = opts.channel ?? channelArg ?? (channels.length === 1 ? channels[0] : "");
      if (!channelRaw) {
        if (channels.length === 0) {
          // `pairing` is chat DM only; TUI/device approvals live under `openclaw devices`.
          throwExpectedCliError(
            `No chat DM pairing channels are configured. To approve a TUI or device request, ` +
              `use ${formatCliCommand("openclaw devices approve")} instead.`,
          );
        }
        throwExpectedCliError(`Channel required (expected one of: ${channelHint}).`);
      }
      const channel = parseChannel(channelRaw, channels);
      if (opts.channel && channelArg) {
        const positionalChannel = parseChannel(channelArg, channels);
        if (channel !== positionalChannel) {
          throwExpectedCliError(
            `Conflicting pairing channels: "${channel}" and "${positionalChannel}". ` +
              `Pass the channel either positionally or with --channel.`,
          );
        }
      }
      const accountId = resolveAccountId(opts.account);
      const requests = await runWithLocalStateOwner<ChannelsPairingCliListResult>({
        method: "channels.pairing.list",
        params: { channel, format: "cli", ...(accountId ? { accountId } : {}) },
        target: `${channel} pairing requests`,
        requiredCapabilities: [GATEWAY_SERVER_CAPS.CHANNELS_PAIRING_LIST_OWNER],
        runLocal: async ({ env, assertCurrent }) =>
          await listChannelPairingRequests(channel, env, accountId, assertCurrent),
      });
      if (opts.json) {
        defaultRuntime.writeJson({ channel, requests });
        return;
      }
      if (requests.length === 0) {
        defaultRuntime.log(theme.muted(terminalText`No pending ${channel} pairing requests.`));
        return;
      }
      const idLabel = resolvePairingIdLabel(channel);
      const tableWidth = getTerminalTableWidth();
      defaultRuntime.log(
        `${theme.heading("Pairing requests")} ${theme.muted(`(${requests.length})`)}`,
      );
      defaultRuntime.log(
        renderTerminalSafeTable({
          width: tableWidth,
          columns: [
            { key: "Code", header: "Code", minWidth: 10 },
            { key: "ID", header: terminalText`${idLabel}`, minWidth: 12, flex: true },
            { key: "Meta", header: "Meta", minWidth: 8, flex: true },
            { key: "Requested", header: "Requested", minWidth: 12 },
          ],
          rows: requests.map((r) => ({
            Code: r.code,
            ID: r.meta?.senderId ?? r.id,
            Meta: r.meta ? JSON.stringify(r.meta) : "",
            Requested: r.createdAt,
          })),
        }).trimEnd(),
      );
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allow that sender")
    .option("--channel <channel>", `Channel (${channelHint})`)
    .option("--account <accountId>", "Account id (for multi-account channels)")
    .argument("<codeOrChannel>", "Pairing code (or channel when using 2 args)")
    .argument("[code]", "Pairing code (when channel is passed as the 1st arg)")
    .option("--notify", "Notify the requester on the same channel", false)
    .action(async (codeOrChannel, code, opts) => {
      const defaultChannel = channels.length === 1 ? channels[0] : "";
      const usingPositionalChannel = !opts.channel && code != null;
      const channelRaw = opts.channel || (usingPositionalChannel ? codeOrChannel : defaultChannel);
      const resolvedCode = usingPositionalChannel ? code : codeOrChannel;
      if (!channelRaw || !resolvedCode) {
        throwExpectedCliError(
          `Usage: ${formatCliCommand("openclaw pairing approve <channel> <code>")} (or: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")})`,
        );
      }
      if (opts.channel && code != null) {
        throwExpectedCliError(
          `Too many arguments. Use: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")}`,
        );
      }
      const channel = parseChannel(channelRaw, channels);
      const accountId = resolveAccountId(opts.account);
      const params = { channel, code: String(resolvedCode), ...(accountId ? { accountId } : {}) };
      const approved = await runWithLocalStateOwner<ChannelsPairingCodeApproveResult>({
        method: "channels.pairing.approve",
        params,
        target: `${channel} pairing request`,
        recoveryCommand: `openclaw pairing list --channel ${channel}`,
        requiredCapabilities: [GATEWAY_SERVER_CAPS.CHANNELS_PAIRING_APPROVE_OWNER],
        runLocal: async ({ env, assertCurrent }) =>
          await approveChannelPairingCode({ ...params, env, assertCurrent }),
      });
      if (!approved) {
        throwExpectedCliError(
          `No pending pairing request found for code "${String(resolvedCode)}". Run ${formatCliCommand(`openclaw pairing list --channel ${channel}`)} to list pending requests.`,
        );
      }

      defaultRuntime.log(
        `${theme.success("Approved")} ${theme.muted(terminalText`${channel}`)} sender ${theme.command(terminalText`${approved.entry.meta?.senderId ?? approved.id}`)}.`,
      );
      const ownerBootstrap = await bootstrapCommandOwnerFromPairing({
        channel,
        id: approved.id,
      });
      if (ownerBootstrap.status === "configured" && ownerBootstrap.ownerEntry) {
        defaultRuntime.log(
          `${theme.success("Command owner configured")} ${theme.command(terminalText`${ownerBootstrap.ownerEntry}`)} ${theme.muted("(commands.ownerAllowFrom was empty).")}`,
        );
      }

      if (!opts.notify) {
        return;
      }
      const approvedAccountId =
        accountId || normalizeStringifiedOptionalString(approved.entry?.meta?.accountId);
      try {
        await notifyPairingApproved({
          channelId: channel,
          id: approved.id,
          cfg: await captureRuntimeConfigAsyncReader()(),
          ...(approvedAccountId ? { accountId: approvedAccountId } : {}),
          ...(approved.entry.meta ? { meta: approved.entry.meta } : {}),
        });
      } catch (err) {
        defaultRuntime.log(theme.warn(terminalText`Failed to notify requester: ${String(err)}`));
      }
    });

  pairing
    .command("remove")
    .description("Forget senders approved through pairing")
    .option("--channel <channel>", `Channel (${channelHint})`)
    .option("--account <accountId>", "Account id (for multi-account channels)")
    .option("--all", "Forget every approved sender of the channel (or account)", false)
    .option("--json", "Print JSON", false)
    .argument("[channelOrSender]", "Channel (or sender id when --channel is passed)")
    .argument("[senderId]", "Sender id to forget (when channel is passed as the 1st arg)")
    .action(async (channelOrSender, senderId, opts) => {
      const usage = `Usage: ${formatCliCommand("openclaw pairing remove <channel> <senderId>")} or ${formatCliCommand("openclaw pairing remove <channel> --all")}`;
      // Without --channel the first argument is the channel; with it, the first argument is the sender.
      const channelRaw = opts.channel || channelOrSender;
      const senderRaw = opts.channel ? channelOrSender : senderId;
      if (opts.channel && senderId != null) {
        throwExpectedCliError(`Too many arguments. ${usage}`);
      }
      const sender = normalizeStringifiedOptionalString(senderRaw);
      if (!channelRaw || (opts.all ? sender !== undefined : !sender)) {
        throwExpectedCliError(
          opts.all && sender !== undefined
            ? `Pass either a sender id or --all, not both. ${usage}`
            : usage,
        );
      }
      const channel = parseChannel(channelRaw, channels);
      const accountId = resolveAccountId(opts.account);
      const target = opts.all ? { all: true as const } : { entry: sender as string };
      const scope = { channel, ...(accountId ? { accountId } : {}) };
      const result = await runWithLocalStateOwner<ChannelsPairingRemoveResult>({
        method: "channels.pairing.remove",
        params: { ...scope, ...target },
        target: `${channel} approved senders`,
        requiredCapabilities: [GATEWAY_SERVER_CAPS.CHANNELS_PAIRING_REMOVE_OWNER],
        runLocal: async ({ env, assertCurrent }) => ({
          removed: await removeChannelAllowFromStore({ ...scope, target, env, assertCurrent }),
        }),
      });
      if (opts.json) {
        defaultRuntime.writeJson({ channel, removed: result.removed });
        return;
      }
      if (result.removed.length === 0) {
        const where = accountId
          ? terminalText`${channel} account ${accountId}`
          : terminalText`${channel}`;
        throwExpectedCliError(
          opts.all
            ? `No approved senders found for ${where}.`
            : `No approved sender "${sender}" found for ${where}. Pass --account <accountId> when the sender was approved on a non-default account.`,
        );
      }
      for (const removal of result.removed) {
        defaultRuntime.log(
          `${theme.success("Removed")} ${theme.muted(terminalText`${channel}`)} sender ${theme.command(terminalText`${removal.entry}`)} ${theme.muted(terminalText`(account ${removal.accountId})`)}.`,
        );
      }
    });
}
