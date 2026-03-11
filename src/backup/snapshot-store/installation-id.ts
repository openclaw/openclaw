import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type InstallationRecord = {
  schemaVersion: 1;
  installationId: string;
  createdAt: string;
};

const INSTALLATION_ID_PATTERN = /^inst_[0-9a-f]{24}$/;

function buildInstallationFilePath(stateDir: string): string {
  return path.join(stateDir, "backup", "installation.json");
}

function generateInstallationId(): string {
  return `inst_${crypto.randomBytes(12).toString("hex")}`;
}

export function isValidInstallationId(value: string): boolean {
  return INSTALLATION_ID_PATTERN.test(value);
}

export async function resolveInstallationId(params: {
  stateDir: string;
  createIfMissing?: boolean;
}): Promise<string | undefined> {
  const filePath = buildInstallationFilePath(params.stateDir);
  let raw: string | undefined;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      raw = undefined;
    } else {
      throw new Error(`Failed to read backup installation record at ${filePath}.`, {
        cause: error,
      });
    }
  }

  if (raw !== undefined) {
    let parsed: Partial<InstallationRecord>;
    try {
      parsed = JSON.parse(raw) as Partial<InstallationRecord>;
    } catch (error) {
      throw new Error(
        `Invalid backup installation record at ${filePath}. Delete or repair it before continuing.`,
        {
          cause: error,
        },
      );
    }
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.installationId === "string" &&
      isValidInstallationId(parsed.installationId)
    ) {
      return parsed.installationId;
    }
    throw new Error(
      `Invalid backup installation record at ${filePath}. Delete or repair it before continuing.`,
    );
  }

  if (!params.createIfMissing) {
    return undefined;
  }

  const record: InstallationRecord = {
    schemaVersion: 1,
    installationId: generateInstallationId(),
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    // Use exclusive create (wx) to avoid races: two concurrent processes
    // that both see ENOENT will only let one writer succeed.
    await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EEXIST"
    ) {
      // Another process won the race — read the file it created.
      const existing = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(existing) as Partial<InstallationRecord>;
      if (
        parsed.schemaVersion === 1 &&
        typeof parsed.installationId === "string" &&
        isValidInstallationId(parsed.installationId)
      ) {
        return parsed.installationId;
      }
      throw new Error(
        `Invalid backup installation record at ${filePath}. Delete or repair it before continuing.`,
        { cause: error },
      );
    }
    throw error;
  }
  return record.installationId;
}
