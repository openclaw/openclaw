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

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function invalidInstallationRecordError(filePath: string, cause?: unknown): Error {
  return new Error(
    `Invalid backup installation record at ${filePath}. Delete or repair it before continuing.`,
    cause === undefined ? undefined : { cause },
  );
}

function isInvalidInstallationRecordError(error: unknown, filePath: string): error is Error {
  return (
    error instanceof Error &&
    error.message ===
      `Invalid backup installation record at ${filePath}. Delete or repair it before continuing.`
  );
}

async function readInstallationRecord(filePath: string): Promise<InstallationRecord | undefined> {
  let raw: string | undefined;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw new Error(`Failed to read backup installation record at ${filePath}.`, {
      cause: error,
    });
  }

  let parsed: Partial<InstallationRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<InstallationRecord>;
  } catch (error) {
    throw invalidInstallationRecordError(filePath, error);
  }
  if (
    parsed.schemaVersion === 1 &&
    typeof parsed.installationId === "string" &&
    isValidInstallationId(parsed.installationId)
  ) {
    return parsed as InstallationRecord;
  }
  throw invalidInstallationRecordError(filePath);
}

async function readInstallationRecordAfterCreateRace(
  filePath: string,
): Promise<InstallationRecord> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const existing = await readInstallationRecord(filePath);
      if (existing) {
        return existing;
      }
    } catch (error) {
      if (!isInvalidInstallationRecordError(error, filePath)) {
        throw error;
      }
      lastError = error;
    }
    if (attempt === 4) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
  }
  throw lastError ?? invalidInstallationRecordError(filePath);
}

export async function resolveInstallationId(params: {
  stateDir: string;
  createIfMissing?: boolean;
}): Promise<string | undefined> {
  const filePath = buildInstallationFilePath(params.stateDir);
  const existing = await readInstallationRecord(filePath);
  if (existing) {
    return existing.installationId;
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
    if (isErrnoCode(error, "EEXIST")) {
      const winner = await readInstallationRecordAfterCreateRace(filePath);
      return winner.installationId;
    }
    throw error;
  }
  return record.installationId;
}
