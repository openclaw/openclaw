import type { Command } from "commander";
import {
  approvePendingResponse,
  listPendingResponses,
  rejectPendingResponse,
  type ConfirmingChannel,
  type PendingResponse,
} from "../confirming/confirming-store.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";

const CONFIRMING_CHANNELS: ConfirmingChannel[] = ["whatsapp", "telegram", "signal", "discord"];

function parseChannel(raw: unknown): ConfirmingChannel {
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
  if (!CONFIRMING_CHANNELS.includes(value as ConfirmingChannel)) {
    throw new Error(
      `Invalid channel: ${value}. Expected one of: ${CONFIRMING_CHANNELS.join(", ")}`,
    );
  }
  return value as ConfirmingChannel;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function formatStatus(status: PendingResponse["status"]): string {
  switch (status) {
    case "pending":
      return theme.warn("pending");
    case "approved":
      return theme.success("approved");
    case "rejected":
      return theme.error("rejected");
    case "expired":
      return theme.muted("expired");
    case "auto-approved":
      return theme.success("auto-approved");
    default:
      return status;
  }
}

async function sendApprovedMessage(params: {
  channel: ConfirmingChannel;
  response: PendingResponse;
}): Promise<void> {
  const { channel, response } = params;
  const messageToSend = response.editedResponse ?? response.suggestedResponse;

  if (channel === "whatsapp") {
    // Import dynamically to avoid circular dependencies
    const { requireActiveWebListener } = await import("../web/active-listener.js");
    const { listener } = requireActiveWebListener(response.accountId);
    await listener.sendMessage(response.replyTo, messageToSend);
  } else {
    throw new Error(`Sending approved messages not yet implemented for ${channel}`);
  }
}

export function registerConfirmingCli(program: Command) {
  const confirming = program
    .command("confirming")
    .description("Manage owner-approved responses (dmPolicy: confirming)");

  confirming
    .command("list")
    .description("List pending responses awaiting approval")
    .option("--channel <channel>", `Channel (${CONFIRMING_CHANNELS.join(", ")})`)
    .argument("[channel]", `Channel (${CONFIRMING_CHANNELS.join(", ")})`)
    .option("--json", "Print JSON", false)
    .option("--all", "Show all responses (including resolved)", false)
    .action(async (channelArg, opts) => {
      const channelRaw = opts.channel ?? channelArg;
      if (!channelRaw) {
        throw new Error(
          `Channel required. Use --channel <channel> or pass it as the first argument (expected one of: ${CONFIRMING_CHANNELS.join(", ")})`,
        );
      }
      const channel = parseChannel(channelRaw);
      const responses = await listPendingResponses(channel);
      const filtered = opts.all ? responses : responses.filter((r) => r.status === "pending");

      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ channel, responses: filtered }, null, 2));
        return;
      }
      if (filtered.length === 0) {
        defaultRuntime.log(theme.muted(`No ${opts.all ? "" : "pending "}${channel} responses.`));
        return;
      }
      const tableWidth = Math.max(80, (process.stdout.columns ?? 120) - 1);
      defaultRuntime.log(`${theme.heading("Responses")} ${theme.muted(`(${filtered.length})`)}`);
      defaultRuntime.log(
        renderTable({
          width: tableWidth,
          columns: [
            { key: "Code", header: "Code", minWidth: 8 },
            { key: "Status", header: "Status", minWidth: 10 },
            { key: "From", header: "From", minWidth: 15, flex: true },
            { key: "Message", header: "Message", minWidth: 20, flex: true },
            { key: "Created", header: "Created", minWidth: 12 },
          ],
          rows: filtered.map((r) => ({
            Code: r.code,
            Status: formatStatus(r.status),
            From: r.senderName ? `${r.senderName} (${r.senderId})` : r.senderId,
            Message: truncate(r.originalMessage, 30),
            Created: r.createdAt,
          })),
        }).trimEnd(),
      );
    });

  confirming
    .command("show")
    .description("Show details of a pending response")
    .option("--channel <channel>", `Channel (${CONFIRMING_CHANNELS.join(", ")})`)
    .argument("<codeOrChannel>", "Response code (or channel when using 2 args)")
    .argument("[code]", "Response code (when channel is passed as the 1st arg)")
    .option("--json", "Print JSON", false)
    .action(async (codeOrChannel, code, opts) => {
      const channelRaw = opts.channel ?? codeOrChannel;
      const resolvedCode = opts.channel ? codeOrChannel : code;
      if (!opts.channel && !code) {
        throw new Error(`Usage: ${formatCliCommand("openclaw confirming show <channel> <code>")}`);
      }
      const channel = parseChannel(channelRaw);
      const responses = await listPendingResponses(channel);
      const response = responses.find(
        (r) => r.code.toUpperCase() === String(resolvedCode).toUpperCase(),
      );
      if (!response) {
        throw new Error(`No response found for code: ${String(resolvedCode)}`);
      }
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(response, null, 2));
        return;
      }
      defaultRuntime.log(`${theme.heading("Response")} ${theme.command(response.code)}`);
      defaultRuntime.log(`${theme.muted("Status:")} ${formatStatus(response.status)}`);
      defaultRuntime.log(
        `${theme.muted("From:")} ${response.senderName ? `${response.senderName} (${response.senderId})` : response.senderId}`,
      );
      defaultRuntime.log(`${theme.muted("Created:")} ${response.createdAt}`);
      if (response.resolvedAt) {
        defaultRuntime.log(`${theme.muted("Resolved:")} ${response.resolvedAt}`);
      }
      defaultRuntime.log("");
      defaultRuntime.log(`${theme.heading("Original Message:")}`);
      defaultRuntime.log(response.originalMessage);
      defaultRuntime.log("");
      defaultRuntime.log(`${theme.heading("Suggested Response:")}`);
      defaultRuntime.log(response.suggestedResponse);
      if (response.editedResponse) {
        defaultRuntime.log("");
        defaultRuntime.log(`${theme.heading("Edited Response:")}`);
        defaultRuntime.log(response.editedResponse);
      }
    });

  confirming
    .command("approve")
    .description("Approve a response and send it to the original sender")
    .option("--channel <channel>", `Channel (${CONFIRMING_CHANNELS.join(", ")})`)
    .argument("<codeOrChannel>", "Response code (or channel when using 2 args)")
    .argument("[code]", "Response code (when channel is passed as the 1st arg)")
    .action(async (codeOrChannel, code, opts) => {
      const channelRaw = opts.channel ?? codeOrChannel;
      const resolvedCode = opts.channel ? codeOrChannel : code;
      if (!opts.channel && !code) {
        throw new Error(
          `Usage: ${formatCliCommand("openclaw confirming approve <channel> <code>")}`,
        );
      }
      const channel = parseChannel(channelRaw);
      const approved = await approvePendingResponse({
        channel,
        code: String(resolvedCode),
      });
      if (!approved) {
        throw new Error(`No pending response found for code: ${String(resolvedCode)}`);
      }

      // Send the approved message to the original sender
      try {
        await sendApprovedMessage({ channel, response: approved });
        defaultRuntime.log(
          `${theme.success("Approved")} and sent response to ${theme.command(approved.senderId)}.`,
        );
      } catch (err) {
        defaultRuntime.log(`${theme.success("Approved")} but failed to send: ${String(err)}`);
        defaultRuntime.log(
          theme.muted(`Response marked as approved. You may need to send manually.`),
        );
      }
    });

  confirming
    .command("edit")
    .description("Approve a response with an edited message")
    .option("--channel <channel>", `Channel (${CONFIRMING_CHANNELS.join(", ")})`)
    .argument("<codeOrChannel>", "Response code (or channel when using 2 args)")
    .argument("<codeOrMessage>", "Code or edited message")
    .argument("[message]", "Edited message to send")
    .action(async (codeOrChannel, codeOrMessage, message, opts) => {
      let channel: ConfirmingChannel;
      let resolvedCode: string;
      let editedMessage: string;

      if (opts.channel) {
        channel = parseChannel(opts.channel);
        resolvedCode = codeOrChannel;
        editedMessage = codeOrMessage;
      } else if (message) {
        channel = parseChannel(codeOrChannel);
        resolvedCode = codeOrMessage;
        editedMessage = message;
      } else {
        throw new Error(
          `Usage: ${formatCliCommand('openclaw confirming edit <channel> <code> "edited message"')}`,
        );
      }

      const approved = await approvePendingResponse({
        channel,
        code: resolvedCode,
        editedResponse: editedMessage,
      });
      if (!approved) {
        throw new Error(`No pending response found for code: ${resolvedCode}`);
      }

      // Send the edited message to the original sender
      try {
        await sendApprovedMessage({ channel, response: approved });
        defaultRuntime.log(
          `${theme.success("Approved (edited)")} and sent response to ${theme.command(approved.senderId)}.`,
        );
      } catch (err) {
        defaultRuntime.log(
          `${theme.success("Approved (edited)")} but failed to send: ${String(err)}`,
        );
        defaultRuntime.log(
          theme.muted(`Response marked as approved. You may need to send manually.`),
        );
      }
    });

  confirming
    .command("reject")
    .description("Reject a response (no message will be sent)")
    .option("--channel <channel>", `Channel (${CONFIRMING_CHANNELS.join(", ")})`)
    .argument("<codeOrChannel>", "Response code (or channel when using 2 args)")
    .argument("[code]", "Response code (when channel is passed as the 1st arg)")
    .action(async (codeOrChannel, code, opts) => {
      const channelRaw = opts.channel ?? codeOrChannel;
      const resolvedCode = opts.channel ? codeOrChannel : code;
      if (!opts.channel && !code) {
        throw new Error(
          `Usage: ${formatCliCommand("openclaw confirming reject <channel> <code>")}`,
        );
      }
      const channel = parseChannel(channelRaw);
      const rejected = await rejectPendingResponse({
        channel,
        code: String(resolvedCode),
      });
      if (!rejected) {
        throw new Error(`No pending response found for code: ${String(resolvedCode)}`);
      }

      defaultRuntime.log(
        `${theme.error("Rejected")} response for ${theme.command(rejected.senderId)}. No message was sent.`,
      );
    });
}
