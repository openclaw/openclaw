import fs from "node:fs";
import path from "node:path";
import { CredentialVault } from "./credential-vault.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

export interface MigrationResult {
  success: boolean;
  files: Array<{
    path: string;
    migrated: boolean;
    alreadyEncrypted: boolean;
    error?: string;
  }>;
  errors: string[];
}

export async function migrateToEncrypted(
  vault: CredentialVault,
  filePaths: string[],
  options: { backup?: boolean } = {},
): Promise<MigrationResult> {
  const result: MigrationResult = { success: true, files: [], errors: [] };

  for (const filePath of filePaths) {
    const fileResult = {
      path: filePath,
      migrated: false,
      alreadyEncrypted: false,
      error: undefined as string | undefined,
    };

    try {
      if (!fs.existsSync(filePath)) {
        fileResult.error = "File does not exist";
        result.files.push(fileResult);
        continue;
      }

      const data = loadJsonFile(filePath);
      if (!data) {
        fileResult.error = "Could not load JSON data";
        result.files.push(fileResult);
        continue;
      }

      if (await vault.isEncrypted(data)) {
        fileResult.alreadyEncrypted = true;
        result.files.push(fileResult);
        continue;
      }

      // Create backup if requested
      if (options.backup !== false) {
        try {
          fs.copyFileSync(filePath, `${filePath}.bak`);
        } catch (err) {
          fileResult.error = `Failed to create backup: ${err instanceof Error ? err.message : String(err)}`;
          result.files.push(fileResult);
          continue;
        }
      }

      // Encrypt and save
      const encrypted = await vault.encrypt(data);
      saveJsonFile(filePath, encrypted);

      fileResult.migrated = true;
      result.files.push(fileResult);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      fileResult.error = `Migration error: ${errMsg}`;
      result.files.push(fileResult);
      result.success = false;
      result.errors.push(`${filePath}: ${errMsg}`);
    }
  }

  return result;
}

/**
 * Find common credential files in the OpenClaw configuration directory
 */
export function findCredentialFiles(baseDir: string): string[] {
  const credentialPaths: string[] = [];

  const walkDir = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name === "auth-profiles.json" || entry.name.includes("credentials")) {
          credentialPaths.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  };

  if (fs.existsSync(baseDir)) {
    walkDir(baseDir);
  }

  // Add main config file if it exists
  const mainConfig = path.join(baseDir, "openclaw.json");
  if (fs.existsSync(mainConfig)) {
    credentialPaths.push(mainConfig);
  }

  return credentialPaths;
}
