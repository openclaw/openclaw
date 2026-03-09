import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type InstallationRecord = {
  schemaVersion: 1;
  installationId: string;
  createdAt: string;
};

function buildInstallationFilePath(stateDir: string): string {
  return path.join(stateDir, "backup", "installation.json");
}

function generateInstallationId(): string {
  return `inst_${crypto.randomBytes(12).toString("hex")}`;
}

export async function resolveInstallationId(params: {
  stateDir: string;
  createIfMissing?: boolean;
}): Promise<string | undefined> {
  const filePath = buildInstallationFilePath(params.stateDir);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<InstallationRecord>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.installationId === "string" &&
      parsed.installationId.trim()
    ) {
      return parsed.installationId;
    }
  } catch {
    // Fall through to optional creation.
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
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record.installationId;
}
