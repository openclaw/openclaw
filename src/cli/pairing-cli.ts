import type { Command } from "commander";
import type { PairingChannel } from "../pairing/pairing-store.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

/** Load plugins and return the available pairing channels. */
async function loadPairingChannels(): Promise<PairingChannel[]> {
  const { listPairingChannels } = await import("../channels/plugins/pairing.js");
  return listPairingChannels();
}

/** Parse channel, allowing extension channels not in core registry. */
async function parseChannel(raw: unknown, channels: PairingChannel[]): Promise<PairingChannel> {
  const value = (
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : ""
  )
    .trim()
    .toLowerCase();
  if (!value) {
    throw new Error("Channel required");
  }

  const { normalizeChannelId } = await import("../channels/plugins/index.js");
  const normalized = normalizeChannelId(value);
  if (normalized) {
    if (!channels.includes(normalized)) {
      throw new Error(`Channel ${normalized} does not support pairing`);
    }
    return normalized;
  }

  // Allow extension channels: validate format but don't require registry
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    return value as PairingChannel;
  }
  throw new Error(`Invalid channel: ${value}`);
}

export function registerPairingCli(program: Command) {
  const pairing = program
    .command("pairing")
    .description("Secure DM pairing (approve inbound requests)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/pairing", "docs.openclaw.ai/cli/pairing")}\n`,
    );

  pairing
    .command("list")
    .description("List pending pairing requests")
    .option("--channel <channel>", "Channel name")
    .argument("[channel]", "Channel name")
    .option("--json", "Print JSON", false)
    .action(async (channelArg, opts) => {
      const { listChannelPairingRequests } = await import("../pairing/pairing-store.js");
      const { resolvePairingIdLabel } = await import("../pairing/pairing-labels.js");
      const { defaultRuntime } = await import("../runtime.js");
      const { renderTable } = await import("../terminal/table.js");
      const channels = await loadPairingChannels();
      const channelRaw = opts.channel ?? channelArg;
      if (!channelRaw) {
        throw new Error(
          `Channel required. Use --channel <channel> or pass it as the first argument (expected one of: ${channels.join(", ")})`,
        );
      }
      const channel = await parseChannel(channelRaw, channels);
      const requests = await listChannelPairingRequests(channel);
      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ channel, requests }, null, 2));
        return;
      }
      if (requests.length === 0) {
        defaultRuntime.log(theme.muted(`No pending ${channel} pairing requests.`));
        return;
      }
      const idLabel = resolvePairingIdLabel(channel);
      const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
      defaultRuntime.log(
        `${theme.heading("Pairing requests")} ${theme.muted(`(${requests.length})`)}`,
      );
      defaultRuntime.log(
        renderTable({
          width: tableWidth,
          columns: [
            { key: "Code", header: "Code", minWidth: 10 },
            { key: "ID", header: idLabel, minWidth: 12, flex: true },
            { key: "Meta", header: "Meta", minWidth: 8, flex: true },
            { key: "Requested", header: "Requested", minWidth: 12 },
          ],
          rows: requests.map((r) => ({
            Code: r.code,
            ID: r.id,
            Meta: r.meta ? JSON.stringify(r.meta) : "",
            Requested: r.createdAt,
          })),
        }).trimEnd(),
      );
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allow that sender")
    .option("--channel <channel>", "Channel name")
    .argument("<codeOrChannel>", "Pairing code (or channel when using 2 args)")
    .argument("[code]", "Pairing code (when channel is passed as the 1st arg)")
    .option("--notify", "Notify the requester on the same channel", false)
    .action(async (codeOrChannel, code, opts) => {
      const { approveChannelPairingCode } = await import("../pairing/pairing-store.js");
      const { notifyPairingApproved } = await import("../channels/plugins/pairing.js");
      const { loadConfig } = await import("../config/config.js");
      const { defaultRuntime } = await import("../runtime.js");
      const { formatCliCommand } = await import("./command-format.js");
      const channels = await loadPairingChannels();
      const channelRaw = opts.channel ?? codeOrChannel;
      const resolvedCode = opts.channel ? codeOrChannel : code;
      if (!opts.channel && !code) {
        throw new Error(
          `Usage: ${formatCliCommand("openclaw pairing approve <channel> <code>")} (or: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")})`,
        );
      }
      if (opts.channel && code != null) {
        throw new Error(
          `Too many arguments. Use: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")}`,
        );
      }
      const channel = await parseChannel(channelRaw, channels);
      const approved = await approveChannelPairingCode({
        channel,
        code: String(resolvedCode),
      });
      if (!approved) {
        throw new Error(`No pending pairing request found for code: ${String(resolvedCode)}`);
      }

      defaultRuntime.log(
        `${theme.success("Approved")} ${theme.muted(channel)} sender ${theme.command(approved.id)}.`,
      );

      if (!opts.notify) {
        return;
      }
      const cfg = loadConfig();
      await notifyPairingApproved({ channelId: channel, id: approved.id, cfg }).catch((err) => {
        defaultRuntime.log(theme.warn(`Failed to notify requester: ${String(err)}`));
      });
    });
}
