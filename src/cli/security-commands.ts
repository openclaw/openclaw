import * as p from "@clack/prompts";
import { type Command } from "commander";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { encryptVault, decryptVault, isVaultFile } from "../security/vault.js";

const VAULT_FILENAME = "secrets.vault";

function getVaultPath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, VAULT_FILENAME);
}

function getEnvPath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, ".env");
}

async function promptForPassword(message: string = "Enter vault password"): Promise<string> {
  const password = await p.password({
    message,
    validate: (value) => {
      if (!value) {
        return "Password cannot be empty";
      }
      if (value.length < 8) {
        return "Password must be at least 8 characters";
      }
    },
  });
  if (p.isCancel(password)) {
    p.cancel("Operation cancelled");
    process.exit(0);
  }
  return password;
}

export function registerSecurityCommands(program: Command) {
  const security = program.command("security").description("Manage credentials vault");

  security
    .command("init")
    .description("Initialize a new encrypted secrets vault")
    .action(async () => {
      p.intro("OpenClaw Security Vault Init");
      const vaultPath = getVaultPath();

      if (isVaultFile(vaultPath)) {
        p.log.warn(`Vault already exists at ${vaultPath}`);
        const force = await p.confirm({
          message: "Overwrite existing vault? (All data will be lost)",
        });
        if (!force || p.isCancel(force)) {
          p.cancel("Operation cancelled");
          process.exit(0);
        }
      }

      const password = await promptForPassword("Set a strong master password");
      const confirm = await promptForPassword("Confirm password");

      if (password !== confirm) {
        p.log.error("Passwords do not match");
        process.exit(1);
      }

      await fs.promises.mkdir(path.dirname(vaultPath), { recursive: true });
      const buffer = await encryptVault({}, password);
      await fs.promises.writeFile(vaultPath, buffer, { mode: 0o600 });

      p.outro(`Vault initialized at ${vaultPath}`);
    });

  security
    .command("migrate")
    .description("Migrate .env file to encrypted vault")
    .action(async () => {
      p.intro("OpenClaw Vault Migration");
      const vaultPath = getVaultPath();
      const envPath = getEnvPath();

      if (!fs.existsSync(envPath)) {
        p.log.error(`No .env file found at ${envPath}`);
        process.exit(1);
      }

      const envContent = await fs.promises.readFile(envPath, "utf8");
      const parsed = dotenv.parse(envContent);
      const keys = Object.keys(parsed);

      if (keys.length === 0) {
        p.log.warn("No secrets found in .env");
        process.exit(0);
      }

      p.log.info(`Found ${keys.length} secrets in .env`);

      // Decrypt existing vault or create new
      let secrets: Record<string, string> = {};
      let password = "";

      if (isVaultFile(vaultPath)) {
        password = await promptForPassword("Enter existing vault password");
        try {
          const buffer = await fs.promises.readFile(vaultPath);
          secrets = await decryptVault(buffer, password);
        } catch (_err) {
          p.log.error("Failed to unlock vault. Wrong password?");
          process.exit(1);
        }
      } else {
        password = await promptForPassword("Set a master password for the new vault");
        const confirm = await promptForPassword("Confirm password");
        if (password !== confirm) {
          p.log.error("Passwords do not match");
          process.exit(1);
        }
      }

      // Merge .env into vault
      Object.assign(secrets, parsed);

      // Save vault
      const buffer = await encryptVault(secrets, password);
      await fs.promises.writeFile(vaultPath, buffer, { mode: 0o600 });
      p.log.success("Secrets migrated to vault");

      // Shred .env
      const confirmDelete = await p.confirm({
        message: "Delete plaintext .env file? (Highly Recommended)",
      });

      if (confirmDelete && !p.isCancel(confirmDelete)) {
        await fs.promises.unlink(envPath);
        p.log.success("Plaintext .env deleted");
      }

      p.outro("Migration complete");
    });

  security
    .command("rekey")
    .description("Change vault password")
    .action(async () => {
      p.intro("OpenClaw Vault Rekey");
      const vaultPath = getVaultPath();

      if (!isVaultFile(vaultPath)) {
        p.log.error(`No vault found at ${vaultPath}`);
        process.exit(1);
      }

      const oldPassword = await promptForPassword("Enter current password");
      let secrets: Record<string, string>;

      try {
        const buffer = await fs.promises.readFile(vaultPath);
        secrets = await decryptVault(buffer, oldPassword);
      } catch (_err) {
        p.log.error("Failed to unlock vault");
        process.exit(1);
      }

      const newPassword = await promptForPassword("Enter new password");
      const confirm = await promptForPassword("Confirm new password");

      if (newPassword !== confirm) {
        p.log.error("Passwords do not match");
        process.exit(1);
      }

      const newBuffer = await encryptVault(secrets, newPassword);
      await fs.promises.writeFile(vaultPath, newBuffer, { mode: 0o600 }); // Mode verified as user-only

      p.outro("Vault password changed");
    });
}
