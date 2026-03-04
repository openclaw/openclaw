import { spawn } from "node:child_process";
import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { checkGrant, grantSecret } from "../secrets/index.js";
import { theme } from "../terminal/theme.js";
import { withProgress } from "./progress.js";

const ELEVATED_SECRET_NAME = "_elevated_session";
const ELEVATED_GRANT_TTL_MINUTES = 30;

type ElevateOptions = {
  json?: boolean;
};

async function runCommand(command: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(command[0], command.slice(1), {
      stdio: "inherit",
    });

    proc.on("close", (code) => {
      resolve(code ?? 0);
    });

    proc.on("error", (error) => {
      defaultRuntime.error(`${theme.error("✗")} Failed to execute command: ${error.message}`);
      resolve(1);
    });
  });
}

export function registerElevateCli(program: Command) {
  const elevate = program
    .command("elevate")
    .description("Run commands with elevated (sudo) privileges using TOTP");

  elevate
    .command("exec")
    .description("Execute a command with TOTP-gated sudo access")
    .argument("<totp-code>", "6-digit TOTP code")
    .argument("<command...>", "Command and arguments to execute")
    .option("--json", "Output JSON", false)
    .action(async (totpCode: string, command: string[], opts: ElevateOptions) => {
      if (command.length === 0) {
        defaultRuntime.error(`${theme.error("✗")} No command provided`);
        defaultRuntime.exit(1);
        return;
      }

      await withProgress(
        {
          label: "Validating TOTP and creating elevated grant",
          indeterminate: true,
          enabled: !opts.json,
        },
        async (progress) => {
          try {
            // Grant elevated session access
            const result = await grantSecret(
              ELEVATED_SECRET_NAME,
              totpCode,
              ELEVATED_GRANT_TTL_MINUTES,
            );

            progress.done();

            if (opts.json) {
              defaultRuntime.log(
                JSON.stringify(
                  {
                    granted: true,
                    expiresAt: result.expiresAt,
                    command: command.join(" "),
                  },
                  null,
                  2,
                ),
              );
            } else {
              defaultRuntime.log(
                `${theme.success("✓")} Elevated access granted for ${ELEVATED_GRANT_TTL_MINUTES} minutes`,
              );
              defaultRuntime.log(
                `${theme.muted("Executing:")} ${theme.command(command.join(" "))}`,
              );
              defaultRuntime.log("");
            }

            // Execute command with sudo
            const sudoCommand = ["sudo", ...command];
            const exitCode = await runCommand(sudoCommand);
            defaultRuntime.exit(exitCode);
          } catch (error) {
            progress.done();
            const message = error instanceof Error ? error.message : String(error);
            if (opts.json) {
              defaultRuntime.error(JSON.stringify({ error: message }, null, 2));
            } else {
              defaultRuntime.error(`${theme.error("✗")} ${message}`);
            }
            defaultRuntime.exit(1);
          }
        },
      );
    });

  elevate
    .command("session")
    .description("Execute a command using existing elevated grant (no TOTP required)")
    .argument("<command...>", "Command and arguments to execute")
    .option("--json", "Output JSON", false)
    .action(async (command: string[], opts: ElevateOptions) => {
      if (command.length === 0) {
        defaultRuntime.error(`${theme.error("✗")} No command provided`);
        defaultRuntime.exit(1);
        return;
      }

      // Check for existing elevated grant
      const grantStatus = await checkGrant(ELEVATED_SECRET_NAME);

      if (grantStatus.status !== "valid") {
        if (opts.json) {
          defaultRuntime.error(
            JSON.stringify(
              {
                error: "No valid elevated session grant",
                hint: `Use: openclaw elevate exec <totp> ${command.join(" ")}`,
              },
              null,
              2,
            ),
          );
        } else {
          defaultRuntime.error(`${theme.error("✗")} No valid elevated session grant`);
          defaultRuntime.error(
            theme.muted(
              `Hint: Use ${theme.command(`openclaw elevate exec <totp> ${command.join(" ")}`)} to create one`,
            ),
          );
        }
        defaultRuntime.exit(1);
        return;
      }

      // Calculate remaining time
      const remaining =
        grantStatus.status === "valid" ? Math.ceil(grantStatus.remaining / 60000) : 0;
      if (!opts.json) {
        defaultRuntime.log(
          `${theme.success("✓")} Using elevated session (${theme.muted(`${remaining}m remaining`)})`,
        );
        defaultRuntime.log(`${theme.muted("Executing:")} ${theme.command(command.join(" "))}`);
        defaultRuntime.log("");
      }

      // Execute command with sudo
      const sudoCommand = ["sudo", ...command];
      const exitCode = await runCommand(sudoCommand);
      defaultRuntime.exit(exitCode);
    });

  // Direct usage: openclaw elevate <totp> <command...>
  // Treats first arg as TOTP code, rest as command
  elevate
    .argument("[totp-code]", "6-digit TOTP code")
    .argument("[command...]", "Command and arguments to execute")
    .action(async (totpCode: string | undefined, command: string[]) => {
      if (!totpCode || command.length === 0) {
        elevate.help();
        return;
      }

      // If totpCode looks like a 6-digit code, treat as elevate exec
      if (/^\d{6}$/.test(totpCode)) {
        try {
          await grantSecret(ELEVATED_SECRET_NAME, totpCode, ELEVATED_GRANT_TTL_MINUTES);
          defaultRuntime.log(
            `${theme.success("✓")} Elevated access granted for ${ELEVATED_GRANT_TTL_MINUTES} minutes`,
          );
          defaultRuntime.log(`${theme.muted("Executing:")} ${theme.command(command.join(" "))}`);
          defaultRuntime.log("");
          const sudoCommand = ["sudo", ...command];
          const exitCode = await runCommand(sudoCommand);
          defaultRuntime.exit(exitCode);
        } catch (error) {
          defaultRuntime.error(`${theme.error("✗")} ${(error as Error).message}`);
          defaultRuntime.exit(1);
        }
      } else {
        elevate.help();
      }
    });
}
