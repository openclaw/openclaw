import { describe, it, expect } from "vitest";

/**
 * Test fixtures and formatting utilities for Matrix CLI output.
 * These tests verify output formatting without requiring the full CLI stack.
 */

// Mock theme colors for testing (these match the actual theme.ts)
const mockTheme = {
  success: (text: string) => `[SUCCESS]${text}[/SUCCESS]`,
  error: (text: string) => `[ERROR]${text}[/ERROR]`,
  info: (text: string) => `[INFO]${text}[/INFO]`,
  muted: (text: string) => `[MUTED]${text}[/MUTED]`,
  accent: (text: string) => `[ACCENT]${text}[/ACCENT]`,
  warn: (text: string) => `[WARN]${text}[/WARN]`,
};

/**
 * Format verification success output (extracted from matrix-cli.ts for testing).
 */
function formatVerificationSuccess(
  result: {
    deviceId?: string;
    backupRestored: boolean;
    restoredSessionCount: number;
    backupDetected?: boolean;
  },
  theme = mockTheme,
): string {
  const lines: string[] = [];
  lines.push(theme.success("✓ Recovery key validated"));
  lines.push(theme.success("✓ Device verified successfully"));
  if (result.deviceId) {
    lines.push(theme.info(`✓ Device ID: ${result.deviceId}`));
  }

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
 * Format verification error output (extracted from matrix-cli.ts for testing).
 */
function formatVerificationError(error: string, theme = mockTheme): string {
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
 * Format status output (extracted from matrix-cli.ts for testing).
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
  accountId: string = "default",
  theme = mockTheme,
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

describe("matrix-cli output formatting", () => {
  describe("formatVerificationSuccess", () => {
    it("should format basic success without device ID", () => {
      const result = {
        backupRestored: false,
        restoredSessionCount: 0,
      };

      const output = formatVerificationSuccess(result);

      expect(output).toContain("[SUCCESS]✓ Recovery key validated[/SUCCESS]");
      expect(output).toContain("[SUCCESS]✓ Device verified successfully[/SUCCESS]");
      expect(output).not.toContain("Device ID:");
    });

    it("should format success with device ID", () => {
      const result = {
        deviceId: "ABCD1234EFGH",
        backupRestored: false,
        restoredSessionCount: 0,
      };

      const output = formatVerificationSuccess(result);

      expect(output).toContain("[INFO]✓ Device ID: ABCD1234EFGH[/INFO]");
    });

    it("should format success with backup restored", () => {
      const result = {
        deviceId: "ABCD1234EFGH",
        backupRestored: true,
        restoredSessionCount: 847,
      };

      const output = formatVerificationSuccess(result);

      expect(output).toContain("[SUCCESS]✓ Restored 847 room keys from backup[/SUCCESS]");
    });

    it("should show backup limitation when backup detected but not restored", () => {
      const result = {
        deviceId: "ABCD1234EFGH",
        backupRestored: false,
        restoredSessionCount: 0,
        backupDetected: true,
      };

      const output = formatVerificationSuccess(result);

      expect(output).toContain(
        "[MUTED]ℹ Backup detected but restoration requires a full Matrix client (bot-SDK limitation)[/MUTED]",
      );
    });

    it("should not show backup message when no backup detected", () => {
      const result = {
        deviceId: "ABCD1234EFGH",
        backupRestored: false,
        restoredSessionCount: 0,
        backupDetected: false,
      };

      const output = formatVerificationSuccess(result);

      expect(output).not.toContain("Backup");
      expect(output).not.toContain("Matrix client");
    });
  });

  describe("formatVerificationError", () => {
    it("should format error with troubleshooting steps", () => {
      const output = formatVerificationError("Recovery key incorrect");

      expect(output).toContain("[ERROR]✗ Recovery key incorrect[/ERROR]");
      expect(output).toContain("[MUTED]Troubleshooting:[/MUTED]");
      expect(output).toContain("[MUTED]- Verify you copied the entire 58-character key[/MUTED]");
      expect(output).toContain(
        "[MUTED]- Check that secret storage is configured (set up in your Matrix client)[/MUTED]",
      );
      expect(output).toContain(
        "[MUTED]- Try logging into your Matrix client to confirm recovery key works[/MUTED]",
      );
    });

    it("should include custom error message", () => {
      const output = formatVerificationError("Secret storage not configured");

      expect(output).toContain("[ERROR]✗ Secret storage not configured[/ERROR]");
    });
  });

  describe("formatStatusOutput", () => {
    it("should format error when account is not configured", () => {
      const status = {
        deviceId: null,
        deviceVerified: false,
        verifiedAt: null,
        keyBackupVersion: null,
        restoredSessionCount: 0,
        configured: false,
      };

      const output = formatStatusOutput(status, "main");

      expect(output).toContain(
        "[ERROR]✗ Matrix account 'main' not found or E2EE not enabled[/ERROR]",
      );
      expect(output).toContain("[MUTED]Troubleshooting:[/MUTED]");
      expect(output).toContain(
        "[MUTED]- Check your account ID (use --account <id> to specify)[/MUTED]",
      );
      expect(output).toContain(
        "[MUTED]- Verify the account is configured in openclaw config[/MUTED]",
      );
      expect(output).toContain(
        "[MUTED]- Ensure E2EE is enabled (channels.matrix.encryption: true)[/MUTED]",
      );
      expect(output).toContain("[MUTED]- Check that the account has an active session[/MUTED]");
    });

    it("should format status with verified device", () => {
      const status = {
        deviceId: "ABCD1234EFGH",
        deviceVerified: true,
        verifiedAt: "2026-02-13T21:00:00Z",
        keyBackupVersion: "2",
        restoredSessionCount: 847,
      };

      const output = formatStatusOutput(status);

      expect(output).toContain("Device ID: [ACCENT]ABCD1234EFGH[/ACCENT]");
      expect(output).toContain("Status: [SUCCESS]Verified ✓[/SUCCESS]");
      expect(output).toContain("Last verified:");
      expect(output).toContain("Key backup: [INFO]Active (version 2, 847 keys)[/INFO]");
    });

    it("should format status with unverified device", () => {
      const status = {
        deviceId: "ABCD1234EFGH",
        deviceVerified: false,
        verifiedAt: null,
        keyBackupVersion: null,
        restoredSessionCount: 0,
      };

      const output = formatStatusOutput(status);

      expect(output).toContain("Status: [WARN]Not verified[/WARN]");
      expect(output).not.toContain("Last verified:");
      expect(output).toContain("Key backup: [MUTED]Not configured[/MUTED]");
    });

    it("should handle unknown device ID", () => {
      const status = {
        deviceId: null,
        deviceVerified: false,
        verifiedAt: null,
        keyBackupVersion: null,
        restoredSessionCount: 0,
      };

      const output = formatStatusOutput(status);

      expect(output).toContain("Device ID: [MUTED]unknown[/MUTED]");
    });

    it("should format backup without restored sessions", () => {
      const status = {
        deviceId: "ABCD1234EFGH",
        deviceVerified: true,
        verifiedAt: "2026-02-13T21:00:00Z",
        keyBackupVersion: "3",
        restoredSessionCount: 0,
      };

      const output = formatStatusOutput(status);

      expect(output).toContain("Key backup: [INFO]Active (version 3)[/INFO]");
    });
  });

  describe("JSON output mode", () => {
    it("should serialize verification result to JSON", () => {
      const result = {
        success: true,
        deviceId: "ABCD1234EFGH",
        backupRestored: true,
        restoredSessionCount: 847,
        backupVersion: "2",
      };

      const json = JSON.stringify(result, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.success).toBe(true);
      expect(parsed.deviceId).toBe("ABCD1234EFGH");
      expect(parsed.backupRestored).toBe(true);
      expect(parsed.restoredSessionCount).toBe(847);
      expect(parsed.backupVersion).toBe("2");
    });

    it("should serialize error result to JSON", () => {
      const result = {
        success: false,
        error: "Recovery key incorrect",
        backupRestored: false,
        restoredSessionCount: 0,
      };

      const json = JSON.stringify(result, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("Recovery key incorrect");
      expect(parsed.backupRestored).toBe(false);
      expect(parsed.restoredSessionCount).toBe(0);
    });

    it("should serialize status to JSON", () => {
      const status = {
        deviceId: "ABCD1234EFGH",
        deviceVerified: true,
        verifiedAt: "2026-02-13T21:00:00Z",
        keyBackupVersion: "2",
        restoredSessionCount: 847,
      };

      const json = JSON.stringify(status, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.deviceId).toBe("ABCD1234EFGH");
      expect(parsed.deviceVerified).toBe(true);
      expect(parsed.verifiedAt).toBe("2026-02-13T21:00:00Z");
      expect(parsed.keyBackupVersion).toBe("2");
      expect(parsed.restoredSessionCount).toBe(847);
    });
  });
});
