import type { Command } from "commander";
import { callGateway } from "../../gateway/call.js";
import { info, error as logError } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { formatHelpExamples } from "../help-format.js";
import {
  listFailedAnnounces,
  loadFailedAnnounce,
  removeFailedAnnounce,
  type FailedAnnouncePayload,
} from "../../agents/subagent-announce-retry.js";

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

function formatFailedAnnounce(payload: FailedAnnouncePayload, verbose: boolean): string {
  const lines = [
    `${theme.accentBright("Session ID:")} ${payload.sessionId}`,
    `${theme.muted("Task:")} ${payload.task}`,
    `${theme.muted("Failed at:")} ${formatTimestamp(payload.timestamp)}`,
    `${theme.muted("Attempts:")} ${payload.attempts}`,
  ];

  if (payload.lastError) {
    lines.push(`${theme.error("Last error:")} ${payload.lastError}`);
  }

  if (verbose) {
    lines.push(`${theme.muted("Child session:")} ${payload.childSessionKey}`);
    lines.push(`${theme.muted("Requester session:")} ${payload.requesterSessionKey}`);
    if (payload.result) {
      const resultPreview =
        payload.result.length > 200 ? payload.result.slice(0, 200) + "..." : payload.result;
      lines.push(`${theme.muted("Result preview:")} ${resultPreview}`);
    }
  }

  return lines.join("\n");
}

export function registerSubagentsListFailedCommand(parent: Command) {
  parent
    .command("list-failed")
    .description("List failed subagent announcements pending recovery")
    .option("--verbose", "Show detailed information", false)
    .option("--json", "Output as JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw subagents list-failed", "List all failed announcements"],
          ["openclaw subagents list-failed --verbose", "Show detailed info"],
          ["openclaw subagents list-failed --json", "Output as JSON"],
        ])}\n`,
    )
    .action(async (opts: { verbose: boolean; json: boolean }) => {
      const failed = listFailedAnnounces();

      if (failed.length === 0) {
        if (opts.json) {
          info("[]");
        } else {
          info(theme.success("No failed announcements pending recovery."));
        }
        return;
      }

      if (opts.json) {
        info(JSON.stringify(failed, null, 2));
        return;
      }

      info(theme.heading(`Found ${failed.length} failed announcement(s):\n`));

      for (const payload of failed) {
        info(formatFailedAnnounce(payload, opts.verbose));
        info("");
      }

      info(
        theme.muted(
          'Use "openclaw subagents recover <sessionId>" to retry delivery for a specific announcement.',
        ),
      );
    });
}

export function registerSubagentsRecoverCommand(parent: Command) {
  parent
    .command("recover <sessionId>")
    .description("Retry delivery of a failed subagent announcement")
    .option("--force", "Force retry even if recent attempt failed", false)
    .option("--delete", "Delete the failed record without retrying", false)
    .option("--timeout <ms>", "Override delivery timeout (milliseconds)", "120000")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw subagents recover abc123", "Retry delivery for session abc123"],
          ["openclaw subagents recover abc123 --delete", "Delete without retrying"],
          ["openclaw subagents recover abc123 --timeout 60000", "Retry with 60s timeout"],
        ])}\n`,
    )
    .action(
      async (
        sessionId: string,
        opts: { force: boolean; delete: boolean; timeout: string },
      ) => {
        const payload = loadFailedAnnounce(sessionId);

        if (!payload) {
          logError(`No failed announcement found for session: ${sessionId}`);
          defaultRuntime.exit(1);
          return;
        }

        if (opts.delete) {
          const removed = removeFailedAnnounce(sessionId);
          if (removed) {
            info(theme.success(`Deleted failed announcement record for: ${sessionId}`));
          } else {
            logError(`Failed to delete record for: ${sessionId}`);
            defaultRuntime.exit(1);
          }
          return;
        }

        const timeoutMs = parseInt(opts.timeout, 10);
        if (isNaN(timeoutMs) || timeoutMs <= 0) {
          logError("Invalid timeout value. Must be a positive integer (milliseconds).");
          defaultRuntime.exit(1);
          return;
        }

        info(theme.muted(`Attempting to recover announcement for session: ${sessionId}`));
        info(theme.muted(`Task: ${payload.task}`));
        info(theme.muted(`Original failure: ${payload.lastError || "unknown"}`));
        info("");

        try {
          // Try to deliver via agent injection
          if (payload.triggerMessage) {
            await callGateway({
              method: "agent",
              params: {
                sessionKey: payload.requesterSessionKey,
                message: payload.triggerMessage,
                deliver: true,
              },
              expectFinal: true,
              timeoutMs,
            });

            // Success - remove the failed record
            removeFailedAnnounce(sessionId);
            info(theme.success(`Successfully recovered announcement for: ${sessionId}`));
            return;
          }

          // Fallback: try to send completion message directly
          if (payload.completionMessage) {
            await callGateway({
              method: "send",
              params: {
                sessionKey: payload.requesterSessionKey,
                message: payload.completionMessage,
              },
              timeoutMs,
            });

            removeFailedAnnounce(sessionId);
            info(theme.success(`Successfully recovered announcement for: ${sessionId}`));
            return;
          }

          // No message content to send
          logError("No message content available for recovery. Result may be in session logs.");
          info(theme.muted(`Use "/subagents log ${sessionId}" in chat to view the result.`));
          defaultRuntime.exit(1);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logError(`Recovery failed: ${errorMsg}`);
          info("");
          info(theme.muted("The failed announcement record has been preserved."));
          info(theme.muted(`Try again later or use --delete to remove the record.`));
          defaultRuntime.exit(1);
        }
      },
    );
}
