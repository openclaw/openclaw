/**
 * Account management CLI commands.
 *
 * These are thin shells that demonstrate CLI integration patterns;
 * production deployments wire them into a persistent AccountManager instance.
 */

import type { Command } from "commander";
import { AccessController } from "../../gateway/access-control/access-controller.js";
import type { CmmcRole } from "../../gateway/access-control/rbac.js";
import { AccountManager } from "../../gateway/accounts/account-manager.js";
import { theme } from "../../terminal/theme.js";

/** Shared in-process account manager (replace with persistent store in prod). */
const globalAccountManager = new AccountManager();

export function registerAccountCli(program: Command): void {
  const account = program
    .command("account")
    .description("Account lifecycle management (CMMC CP-2)");

  // ── account create ──────────────────────────────────────────────────────
  account
    .command("create <username>")
    .description("Create a new account")
    .requiredOption("--role <role>", "Role: admin | operator | observer | guest")
    .option("--no-mfa", "Disable MFA requirement (not recommended)")
    .action(async (username: string, opts: { role: string; mfa: boolean }) => {
      const actor = new AccessController(resolveActorRole());
      const password = await promptPassword();
      try {
        const acct = await globalAccountManager.create(
          {
            username,
            role: opts.role as CmmcRole,
            password,
            createdBy: resolveActorSubject(),
            requireMfa: opts.mfa,
          },
          actor,
        );
        console.log(theme.success(`Account created: ${acct.id} (${acct.username}/${acct.role})`));
      } catch (err) {
        console.error(theme.error(String(err)));
        process.exitCode = 1;
      }
    });

  // ── account list ────────────────────────────────────────────────────────
  account
    .command("list")
    .description("List accounts")
    .option("--role <role>", "Filter by role")
    .option("--status <status>", "Filter by status")
    .option("--json", "Output as JSON")
    .action((opts: { role?: string; status?: string; json?: boolean }) => {
      const actor = new AccessController(resolveActorRole());
      try {
        const accounts = globalAccountManager.list(actor, {
          role: opts.role as CmmcRole | undefined,
          status: opts.status as "active" | "disabled" | "locked" | undefined,
        });
        if (opts.json) {
          console.log(JSON.stringify(accounts, null, 2));
        } else {
          for (const acct of accounts) {
            console.log(
              `${acct.id}  ${acct.username.padEnd(20)}  ${acct.role.padEnd(10)}  ${acct.status}`,
            );
          }
        }
      } catch (err) {
        console.error(theme.error(String(err)));
        process.exitCode = 1;
      }
    });

  // ── account disable ─────────────────────────────────────────────────────
  account
    .command("disable <id>")
    .description("Disable an account")
    .action(async (id: string) => {
      const actor = new AccessController(resolveActorRole());
      try {
        const acct = await globalAccountManager.disable(id, actor);
        console.log(theme.success(`Account disabled: ${acct.username}`));
      } catch (err) {
        console.error(theme.error(String(err)));
        process.exitCode = 1;
      }
    });

  // ── account enable ──────────────────────────────────────────────────────
  account
    .command("enable <id>")
    .description("Re-enable a disabled account")
    .action(async (id: string) => {
      const actor = new AccessController(resolveActorRole());
      try {
        const acct = await globalAccountManager.enable(id, actor);
        console.log(theme.success(`Account enabled: ${acct.username}`));
      } catch (err) {
        console.error(theme.error(String(err)));
        process.exitCode = 1;
      }
    });

  // ── account delete ──────────────────────────────────────────────────────
  account
    .command("delete <id>")
    .description("Permanently delete an account")
    .action((id: string) => {
      const actor = new AccessController(resolveActorRole());
      try {
        globalAccountManager.delete(id, actor);
        console.log(theme.success(`Account deleted: ${id}`));
      } catch (err) {
        console.error(theme.error(String(err)));
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveActorRole(): string {
  return process.env["OPENCLAW_ACTOR_ROLE"] ?? "guest";
}

function resolveActorSubject(): string {
  return process.env["OPENCLAW_ACTOR_SUBJECT"] ?? "unknown";
}

/** Reads password from env (CI/non-interactive) or stdin. */
async function promptPassword(): Promise<string> {
  const envPw = process.env["OPENCLAW_ACCOUNT_PASSWORD"];
  if (envPw) {
    return envPw;
  }
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write("Password: ");
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
