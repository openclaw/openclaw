import type { Command } from "commander";
import { enrollTotpUser, revokeTotpUser, listTotpUsers, getTotpStatus } from "../totp/totp-store.js";

/**
 * Register TOTP management CLI commands.
 *
 * Usage:
 *   openclaw totp enroll <userId>   — Enroll a user, outputs secret + QR URI
 *   openclaw totp revoke <userId>   — Remove a user's TOTP enrollment
 *   openclaw totp status [userId]   — Show enrollment status
 *   openclaw totp list              — List all enrolled users
 */
export function registerTotpCli(program: Command) {
  const totp = program.command("totp").description("Manage TOTP 2FA enrollment");

  totp
    .command("enroll <userId>")
    .description("Enroll a user for TOTP 2FA")
    .action(async (userId: string) => {
      const result = await enrollTotpUser(userId);
      if (result.alreadyEnrolled) {
        console.log(`User ${userId} is already enrolled.`);
        console.log(`To re-enroll, revoke first: openclaw totp revoke ${userId}`);
        return;
      }
      console.log(`\n✅ TOTP enrolled for user: ${userId}\n`);
      console.log(`Secret: ${result.secret}`);
      console.log(`\nQR URI (paste into authenticator app):`);
      console.log(result.otpauthUri);
      console.log(`\n⚠️  Save this secret securely. It cannot be retrieved later.\n`);
    });

  totp
    .command("revoke <userId>")
    .description("Revoke TOTP enrollment for a user")
    .action(async (userId: string) => {
      const revoked = await revokeTotpUser(userId);
      if (revoked) {
        console.log(`✅ TOTP revoked for user: ${userId}`);
      } else {
        console.log(`User ${userId} was not enrolled.`);
      }
    });

  totp
    .command("status [userId]")
    .description("Show TOTP enrollment status")
    .action(async (userId?: string) => {
      if (userId) {
        const status = await getTotpStatus(userId);
        console.log(`User: ${userId}`);
        console.log(`Enrolled: ${status.enrolled}`);
        if (status.enrolled) {
          console.log(`Has active session: ${status.hasActiveSession}`);
        }
      } else {
        const users = await listTotpUsers();
        if (users.length === 0) {
          console.log("No users enrolled in TOTP.");
        } else {
          console.log(`Enrolled users (${users.length}):`);
          for (const u of users) {
            console.log(`  - ${u}`);
          }
        }
      }
    });

  totp
    .command("list")
    .description("List all enrolled TOTP users")
    .action(async () => {
      const users = await listTotpUsers();
      if (users.length === 0) {
        console.log("No users enrolled in TOTP.");
      } else {
        console.log(`Enrolled users (${users.length}):`);
        for (const u of users) {
          console.log(`  - ${u}`);
        }
      }
    });
}
