/**
 * `openclaw security` CLI command.
 *
 * Subcommands:
 *   openclaw security init          - Set up workspace encryption
 *   openclaw security status        - Show encryption status
 *   openclaw security change-password - Change master password
 *   openclaw security disable       - Disable encryption and decrypt files
 */
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import {
  changePassword,
  disableEncryption,
  initEncryption,
  isEncryptionConfigured,
  readEncryptionMeta,
  WORKSPACE_SENSITIVE_FILES,
} from "../security/encryption/index.js";
import { keychainHasKeys } from "../security/encryption/keychain.js";

async function promptPassword(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // stderr so it doesn't pollute piped output
  });
  try {
    // Note: readline doesn't natively hide input. For production,
    // consider using a library like `read` for masked password input.
    const password = await rl.question(prompt);
    return password;
  } finally {
    rl.close();
  }
}

async function promptPasswordConfirm(prompt: string): Promise<string> {
  const password = await promptPassword(prompt);
  const confirm = await promptPassword("Confirm password: ");
  if (password !== confirm) {
    throw new Error("Passwords do not match");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  return password;
}

export async function securityInitCommand(): Promise<void> {
  const workspaceDir = resolveDefaultAgentWorkspaceDir();

  const alreadyConfigured = await isEncryptionConfigured(workspaceDir);
  if (alreadyConfigured) {
    console.log("⚠️  Encryption is already configured for this workspace.");
    console.log('   Use "openclaw security change-password" to change your password.');
    console.log('   Use "openclaw security disable" to remove encryption.');
    return;
  }

  console.log("🔐 Setting up workspace encryption");
  console.log("");
  console.log("This will:");
  console.log("  1. Derive encryption keys from your password (scrypt)");
  console.log("  2. Store keys in macOS Keychain");
  console.log("  3. Encrypt sensitive workspace files:");
  for (const f of WORKSPACE_SENSITIVE_FILES) {
    console.log(`     - ${f}`);
  }
  console.log("  4. Encrypt memory/*.md files");
  console.log("");

  const password = await promptPasswordConfirm("Enter master password (min 8 chars): ");

  console.log("");
  console.log("⏳ Deriving keys (this takes a few seconds)...");

  const result = await initEncryption(workspaceDir, password);

  if (result.success) {
    console.log("");
    console.log("✅ Encryption enabled!");
    console.log(`   Encrypted: ${result.migrated.join(", ") || "(no files to encrypt)"}`);
    if (result.skipped.length > 0) {
      console.log(`   Skipped: ${result.skipped.join(", ")}`);
    }
    console.log("");
    console.log("   Keys are stored in macOS Keychain (service: ai.openclaw.encryption)");
    console.log("   Files will be automatically decrypted when OpenClaw reads them.");
    console.log("   New files will be encrypted on next gateway restart.");
  } else {
    console.error("");
    console.error("❌ Encryption setup failed:");
    for (const err of result.errors) {
      console.error(`   ${err.file}: ${err.error}`);
    }
    process.exitCode = 1;
  }
}

export async function securityStatusCommand(params: { json?: boolean }): Promise<void> {
  const workspaceDir = resolveDefaultAgentWorkspaceDir();
  const meta = await readEncryptionMeta(workspaceDir);
  const hasKeys = keychainHasKeys();

  if (params.json) {
    console.log(
      JSON.stringify(
        {
          enabled: meta?.enabled ?? false,
          keychainKeys: hasKeys,
          salt: meta?.salt ?? null,
          encryptedPatterns: meta?.encryptedPatterns ?? [],
          createdAt: meta?.createdAt ?? null,
          lastKeyChangeAt: meta?.lastKeyChangeAt ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("🔐 Workspace Encryption Status");
  console.log("");

  if (!meta) {
    console.log("   Status: Not configured");
    console.log('   Run "openclaw security init" to enable encryption.');
    return;
  }

  console.log(`   Status: ${meta.enabled ? "✅ Enabled" : "❌ Disabled"}`);
  console.log(`   Keychain: ${hasKeys ? "✅ Keys loaded" : "⚠️  Keys missing"}`);
  console.log(`   Created: ${meta.createdAt}`);
  console.log(`   Last key change: ${meta.lastKeyChangeAt}`);
  console.log(`   Encrypted files: ${meta.encryptedPatterns.join(", ") || "(none)"}`);
}

export async function securityChangePasswordCommand(): Promise<void> {
  const workspaceDir = resolveDefaultAgentWorkspaceDir();

  const configured = await isEncryptionConfigured(workspaceDir);
  if (!configured) {
    console.error('❌ Encryption is not configured. Run "openclaw security init" first.');
    process.exitCode = 1;
    return;
  }

  const oldPassword = await promptPassword("Enter current password: ");
  const newPassword = await promptPasswordConfirm("Enter new password (min 8 chars): ");

  console.log("");
  console.log("⏳ Re-deriving keys and re-encrypting files...");

  try {
    const result = await changePassword(workspaceDir, oldPassword, newPassword);
    console.log("");
    console.log("✅ Password changed!");
    console.log(`   Re-encrypted: ${result.migrated.join(", ") || "(no files)"}`);
  } catch (err: unknown) {
    console.error("");
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

export async function securityDisableCommand(): Promise<void> {
  const workspaceDir = resolveDefaultAgentWorkspaceDir();

  const configured = await isEncryptionConfigured(workspaceDir);
  if (!configured) {
    console.log("ℹ️  Encryption is not configured.");
    return;
  }

  const password = await promptPassword("Enter password to disable encryption: ");

  // Simple confirmation
  const confirmToken = crypto.randomBytes(3).toString("hex");
  const confirm = await promptPassword(
    `⚠️  This will decrypt all files and remove keys. Type "${confirmToken}" to confirm: `,
  );
  if (confirm !== confirmToken) {
    console.log("Cancelled.");
    return;
  }

  console.log("");
  console.log("⏳ Decrypting files and removing keys...");

  try {
    await disableEncryption(workspaceDir, password);
    console.log("");
    console.log("✅ Encryption disabled. All files are now plaintext.");
  } catch (err: unknown) {
    console.error("");
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
