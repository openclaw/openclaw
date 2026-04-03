import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const JSON_FILE_MODE = 0o600;
const JSON_DIR_MODE = 0o700;

function trySetSecureMode(pathname: string) {
  try {
    fs.chmodSync(pathname, JSON_FILE_MODE);
  } catch {
    // best-effort on platforms without chmod support
  }
}

function resolveJsonWriteTarget(pathname: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return pathname;
  }
  return stat.isSymbolicLink() ? fs.realpathSync(pathname) : pathname;
}

function renameJsonFileWithFallback(tmpPath: string, pathname: string) {
  try {
    fs.renameSync(tmpPath, pathname);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not reliably support rename-based overwrite for existing files.
    if (code === "EPERM" || code === "EEXIST") {
      fs.copyFileSync(tmpPath, pathname);
      fs.rmSync(tmpPath, { force: true });
      return;
    }
    throw error;
  }
}

export function loadJsonFile(pathname: string): unknown {
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const targetPath = resolveJsonWriteTarget(pathname);
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: JSON_DIR_MODE });
  try {
    fs.writeFileSync(tmpPath, payload, {
      encoding: "utf8",
      mode: JSON_FILE_MODE,
    });
    trySetSecureMode(tmpPath);
    renameJsonFileWithFallback(tmpPath, targetPath);
    trySetSecureMode(targetPath);
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup when rename does not happen
    }
  }
}
