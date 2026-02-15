import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { callGatewayFromCli, addGatewayClientOptions } from "./gateway-rpc.js";
import { withProgress } from "./progress.js";

type MatrixVerifyRecoveryKeyOpts = {
  file?: string;
  json?: boolean;
  account?: string;
  url?: string;
  token?: string;
  timeout?: string;
};

type MatrixVerifyStatusOpts = {
  json?: boolean;
  account?: string;
  url?: string;
  token?: string;
  timeout?: string;
};

function runMatrixCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

/**
 * Format success output for recovery key verification.
 */
function formatVerificationSuccess(result: {
  deviceId?: string;
  backupRestored: boolean;
  restoredSessionCount: number;
  backupDetected?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(theme.success("✓ Recovery key validated"));
  lines.push(theme.success("✓ Device verified successfully"));
  if (result.deviceId) {
    lines.push(theme.info(`✓ Device ID: ${result.deviceId}`));
  }

  // Handle backup restoration status
  if (result.backupRestored && result.restoredSessionCount > 0) {
    lines.push(theme.success(`✓ Restored ${result.restoredSessionCount} room keys from backup`));
  } else if (result.backupDetected) {
    lines.push(
      theme.muted(
        "ℹ Backup detected but restoration requires a full Matrix client (bot-SDK limitation)",
      ),
    );
  }

  return lines.join("\n");
}

/**
 * Format error output for recovery key verification.
 */
function formatVerificationError(error: string): string {
  const lines: string[] = [];
  lines.push(theme.error(`✗ ${error}`));
  lines.push("");
  lines.push(theme.muted("Troubleshooting:"));
  lines.push(theme.muted("- Verify you copied the entire 58-character key"));
  lines.push(
    theme.muted("- Check that secret storage is configured (set up in your Matrix client)"),
  );
  lines.push(theme.muted("- Try logging into your Matrix client to confirm recovery key works"));
  return lines.join("\n");
}

/**
 * Format status output for device verification.
 */
function formatStatusOutput(
  status: {
    deviceId: string | null;
    deviceVerified: boolean;
    verifiedAt: string | null;
    keyBackupVersion: string | null;
    restoredSessionCount: number;
    configured?: boolean;
  },
  accountId: string,
): string {
  const lines: string[] = [];

  // If account is not configured, show helpful error message
  if (status.configured === false) {
    lines.push(theme.error(`✗ Matrix account '${accountId}' not found or E2EE not enabled`));
    lines.push("");
    lines.push(theme.muted("Troubleshooting:"));
    lines.push(theme.muted("- Check your account ID (use --account <id> to specify)"));
    lines.push(theme.muted("- Verify the account is configured in openclaw config"));
    lines.push(theme.muted("- Ensure E2EE is enabled (channels.matrix.encryption: true)"));
    lines.push(theme.muted("- Check that the account has an active session"));
    return lines.join("\n");
  }

  if (status.deviceId) {
    lines.push(`Device ID: ${theme.accent(status.deviceId)}`);
  } else {
    lines.push(`Device ID: ${theme.muted("unknown")}`);
  }

  const statusText = status.deviceVerified
    ? theme.success("Verified ✓")
    : theme.warn("Not verified");
  lines.push(`Status: ${statusText}`);

  if (status.verifiedAt) {
    const date = new Date(status.verifiedAt);
    lines.push(`Last verified: ${theme.muted(date.toLocaleString())}`);
  }

  if (status.keyBackupVersion) {
    const backupInfo = `Active (version ${status.keyBackupVersion}`;
    const sessionInfo =
      status.restoredSessionCount > 0 ? `, ${status.restoredSessionCount} keys` : "";
    lines.push(`Key backup: ${theme.info(backupInfo + sessionInfo + ")")}`);
  } else {
    lines.push(`Key backup: ${theme.muted("Not configured")}`);
  }

  return lines.join("\n");
}

/**
 * Read recovery key from file or environment variable.
 */
function readRecoveryKey(filePath?: string): string | null {
  // Check environment variable first
  const envKey = process.env.MATRIX_RECOVERY_KEY;
  if (envKey) {
    defaultRuntime.error(
      theme.warn(
        "Warning: Using MATRIX_RECOVERY_KEY from environment (shell history exposure risk)",
      ),
    );
    return envKey.trim();
  }

  // Read from file if provided
  if (filePath) {
    try {
      const content = readFileSync(filePath, "utf8");
      return content.trim();
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err) {
        if (err.code === "ENOENT") {
          throw new Error(`Recovery key file not found: ${filePath}`, { cause: err });
        }
        if (err.code === "EACCES") {
          throw new Error(`Permission denied reading recovery key file: ${filePath}`, {
            cause: err,
          });
        }
      }
      throw new Error(`Failed to read recovery key file: ${String(err)}`, { cause: err });
    }
  }

  return null;
}

/**
 * Verify device with recovery key.
 */
async function verifyRecoveryKeyCommand(
  key: string | undefined,
  opts: MatrixVerifyRecoveryKeyOpts,
) {
  // Normalize account ID (gateway will validate configuration)
  const accountId = normalizeAccountId(opts.account);

  // Get recovery key from argument, file, or environment
  let recoveryKey = key;
  if (!recoveryKey) {
    const fileOrEnvKey = readRecoveryKey(opts.file);
    if (!fileOrEnvKey) {
      defaultRuntime.error(
        theme.error("Error: Recovery key required (provide as argument or via --file)"),
      );
      defaultRuntime.exit(1);
      return;
    }
    recoveryKey = fileOrEnvKey;
  }

  // Call gateway RPC
  const result: {
    success: boolean;
    error?: string;
    deviceId?: string;
    backupRestored: boolean;
    restoredSessionCount: number;
    backupDetected?: boolean;
  } = await withProgress(
    {
      label: `Verifying device for account '${accountId}'`,
      indeterminate: true,
      enabled: !opts.json,
    },
    async () => {
      const response = await callGatewayFromCli(
        "matrix.verify.recoveryKey",
        {
          url: opts.url,
          token: opts.token,
          timeout: opts.timeout ?? "30000",
          json: opts.json,
        },
        { key: recoveryKey, accountId },
      );
      return response as {
        success: boolean;
        error?: string;
        deviceId?: string;
        backupRestored: boolean;
        restoredSessionCount: number;
        backupDetected?: boolean;
      };
    },
  );

  // Output result
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
  } else {
    if (result.success) {
      defaultRuntime.log(formatVerificationSuccess(result));
    } else {
      defaultRuntime.error(formatVerificationError(result.error ?? "Verification failed"));
      defaultRuntime.exit(1);
    }
  }
}

/**
 * Show device verification status.
 */
async function verifyStatusCommand(opts: MatrixVerifyStatusOpts) {
  // Normalize account ID (gateway will validate configuration)
  const accountId = normalizeAccountId(opts.account);

  const result: {
    deviceId: string | null;
    deviceVerified: boolean;
    verifiedAt: string | null;
    keyBackupVersion: string | null;
    restoredSessionCount: number;
    configured?: boolean;
  } = await withProgress(
    {
      label: `Fetching verification status for account '${accountId}'`,
      indeterminate: true,
      enabled: !opts.json,
    },
    async () => {
      const response = await callGatewayFromCli(
        "matrix.verify.status",
        {
          url: opts.url,
          token: opts.token,
          timeout: opts.timeout ?? "10000",
          json: opts.json,
        },
        { accountId },
      );
      return response as {
        deviceId: string | null;
        deviceVerified: boolean;
        verifiedAt: string | null;
        keyBackupVersion: string | null;
        restoredSessionCount: number;
        configured?: boolean;
      };
    },
  );

  // Output result
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
  } else {
    defaultRuntime.log(formatStatusOutput(result, accountId));
  }
}

/**
 * Register Matrix CLI commands.
 */
export function registerMatrixCli(program: Command) {
  const matrix = program
    .command("matrix")
    .description("Manage Matrix E2EE device verification")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/channels/matrix",
          "docs.openclaw.ai/channels/matrix",
        )}\n`,
    );

  // Verify subcommands
  const verify = matrix.command("verify").description("Device verification commands");

  // verify status
  const statusCmd = verify
    .command("status")
    .description("Show device verification status for a Matrix account")
    .option("--account <id>", "Matrix account ID (default: 'default')")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Examples:")}\n` +
        `  ${theme.accent("$ openclaw matrix verify status")}\n` +
        `  ${theme.accent("$ openclaw matrix verify status --account work")}\n`,
    );

  addGatewayClientOptions(statusCmd);

  statusCmd.action(async (opts) => {
    await runMatrixCommand(async () => {
      await verifyStatusCommand(opts);
    });
  });

  // verify recovery-key
  const recoveryKeyCmd = verify
    .command("recovery-key [key]")
    .description("Verify device with recovery key for a Matrix account")
    .option("--account <id>", "Matrix account ID (default: 'default')")
    .option("--file <path>", "Read recovery key from file")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Examples:")}\n` +
        `  ${theme.accent("$ openclaw matrix verify recovery-key <key>")}\n` +
        `  ${theme.accent("$ openclaw matrix verify recovery-key --file ~/recovery.key")}\n` +
        `  ${theme.accent("$ openclaw matrix verify recovery-key <key> --account work")}\n`,
    );

  addGatewayClientOptions(recoveryKeyCmd);

  recoveryKeyCmd.action(async (key, opts) => {
    await runMatrixCommand(async () => {
      await verifyRecoveryKeyCommand(key, opts);
    });
  });
}
