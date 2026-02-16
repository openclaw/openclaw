import type { Command } from "commander";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { listPairingChannels, notifyPairingApproved } from "../channels/plugins/pairing.js";
import { loadConfig } from "../config/config.js";
import { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  type PairingApprovalRole,
  type PairingChannel,
} from "../pairing/pairing-store.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";

/** Parse channel, allowing extension channels not in core registry. */
function parseChannel(raw: unknown, channels: PairingChannel[]): PairingChannel {
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

function parseRole(raw: unknown): PairingApprovalRole {
  const role = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (role === "restricted" || role === "tenant" || role === "superadmin") {
    return role;
  }
  throw new Error('Invalid role. Use: "restricted", "tenant", or "superadmin".');
}

async function notifyApproved(channel: PairingChannel, id: string) {
  const cfg = loadConfig();
  await notifyPairingApproved({ channelId: channel, id, cfg });
}

export function registerPairingCli(program: Command) {
  const channels = listPairingChannels();
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
    .option("--channel <channel>", `Channel (${channels.join(", ")})`)
    .option("--account <accountId>", "Account id (for multi-account channels)")
    .argument("[channel]", `Channel (${channels.join(", ")})`)
    .option("--json", "Print JSON", false)
    .action(async (channelArg, opts) => {
      const channelRaw = opts.channel ?? channelArg;
      if (!channelRaw) {
        throw new Error(
          `Channel required. Use --channel <channel> or pass it as the first argument (expected one of: ${channels.join(", ")})`,
        );
      }
      const channel = parseChannel(channelRaw, channels);
      const accountId = String(opts.account ?? "").trim();
      const requests = accountId
        ? await listChannelPairingRequests(channel, process.env, accountId)
        : await listChannelPairingRequests(channel);
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
    .option("--channel <channel>", `Channel (${channels.join(", ")})`)
    .option("--account <accountId>", "Account id (for multi-account channels)")
    .argument("<codeOrChannel>", "Pairing code (or channel when using 2 args)")
    .argument("[code]", "Pairing code (when channel is passed as the 1st arg)")
    .option("--notify", "Notify the requester on the same channel", false)
    .option("--role <role>", 'Assign access role on approval: "restricted" | "tenant" | "superadmin"')
    .option(
      "--approved-by <actor>",
      "Who approved this request (for audit trail, e.g. +5511999999999)",
    )
    .option(
      "--confirm-superadmin",
      "Required when assigning role=superadmin",
      false,
    )
    .action(async (codeOrChannel, code, opts) => {
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
      const channel = parseChannel(channelRaw, channels);
      const accountId = String(opts.account ?? "").trim();
      const role = opts.role ? parseRole(opts.role) : undefined;
      if (role === "superadmin" && !opts.confirmSuperadmin) {
        throw new Error(
          'Role "superadmin" requires explicit confirmation. Re-run with --confirm-superadmin.',
        );
      }
      const approvedBy = String(opts.approvedBy ?? "").trim() || undefined;
      const approved = accountId
        ? await approveChannelPairingCode({
            channel,
            code: String(resolvedCode),
            accountId,
            role,
            approvedBy,
          })
        : await approveChannelPairingCode({
            channel,
            code: String(resolvedCode),
            role,
            approvedBy,
          });
      if (!approved) {
        throw new Error(`No pending pairing request found for code: ${String(resolvedCode)}`);
      }

      const roleSuffix = approved.roleEntry
        ? ` ${theme.muted(`(role: ${approved.roleEntry.role})`)}`
        : "";
      defaultRuntime.log(
        `${theme.success("Approved")} ${theme.muted(channel)} sender ${theme.command(approved.id)}.${roleSuffix}`,
      );

      if (!opts.notify) {
        return;
      }
      await notifyApproved(channel, approved.id).catch((err) => {
        defaultRuntime.log(theme.warn(`Failed to notify requester: ${String(err)}`));
      });
    });
}
