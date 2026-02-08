import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { clearSession, enrollTotpUser, listTotpUsers, revokeTotpUser } from "../totp/totp-store.js";

export function registerTotpCli(program: Command) {
  const totp = program
    .command("totp")
    .description("TOTP two-factor authentication for Telegram DMs");

  totp
    .command("enroll")
    .description("Enroll a Telegram user for TOTP 2FA")
    .argument("<channel>", "Channel (telegram)")
    .argument("<user-id>", "Telegram user ID")
    .option("--label <name>", "Display label (e.g. username)")
    .action(async (channel, userId, opts) => {
      if (channel !== "telegram") {
        throw new Error("Only telegram is supported for TOTP enrollment");
      }
      const result = await enrollTotpUser(userId, opts.label);
      defaultRuntime.log(
        `${theme.success("Enrolled")} user ${theme.command(userId)} for TOTP 2FA.`,
      );
      defaultRuntime.log("");
      defaultRuntime.log(`${theme.heading("Secret (base32):")} ${result.secretBase32}`);
      defaultRuntime.log("");
      defaultRuntime.log(`${theme.heading("OTPAuth URI:")} ${result.otpauthUri}`);
      defaultRuntime.log("");
      defaultRuntime.log(
        theme.muted(
          "Add this secret to your authenticator app (Google Authenticator, Authy, etc).",
        ),
      );
    });

  totp
    .command("revoke")
    .description("Revoke TOTP enrollment for a Telegram user")
    .argument("<channel>", "Channel (telegram)")
    .argument("<user-id>", "Telegram user ID")
    .action(async (channel, userId) => {
      if (channel !== "telegram") {
        throw new Error("Only telegram is supported for TOTP revocation");
      }
      const removed = await revokeTotpUser(userId);
      if (!removed) {
        throw new Error(`User ${userId} is not enrolled in TOTP`);
      }
      defaultRuntime.log(
        `${theme.success("Revoked")} TOTP enrollment for user ${theme.command(userId)}.`,
      );
    });

  totp
    .command("list")
    .description("List TOTP-enrolled users")
    .option("--json", "Print JSON", false)
    .action(async (opts) => {
      const users = await listTotpUsers();
      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ users }, null, 2));
        return;
      }
      if (users.length === 0) {
        defaultRuntime.log(theme.muted("No TOTP-enrolled users."));
        return;
      }
      const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
      defaultRuntime.log(`${theme.heading("TOTP users")} ${theme.muted(`(${users.length})`)}`);
      defaultRuntime.log(
        renderTable({
          width: tableWidth,
          columns: [
            { key: "UserId", header: "User ID", minWidth: 12, flex: true },
            { key: "Label", header: "Label", minWidth: 8, flex: true },
            { key: "Enrolled", header: "Enrolled", minWidth: 12 },
          ],
          rows: users.map((u) => ({
            UserId: u.telegramUserId,
            Label: u.label ?? "",
            Enrolled: u.enrolledAt,
          })),
        }).trimEnd(),
      );
    });

  totp
    .command("clear-session")
    .description("Force re-authentication for a Telegram user")
    .argument("<channel>", "Channel (telegram)")
    .argument("<user-id>", "Telegram user ID")
    .action(async (channel, userId) => {
      if (channel !== "telegram") {
        throw new Error("Only telegram is supported for TOTP session management");
      }
      const cleared = await clearSession(userId);
      if (!cleared) {
        defaultRuntime.log(theme.muted(`No active session for user ${userId}.`));
        return;
      }
      defaultRuntime.log(
        `${theme.success("Cleared")} TOTP session for user ${theme.command(userId)}.`,
      );
    });
}
