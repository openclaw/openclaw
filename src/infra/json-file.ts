import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function loadJsonFile(pathname: string): unknown {
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  const tmpPath = `${pathname}.${randomUUID()}.tmp`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // best-effort on platforms without chmod support
    }
    fs.renameSync(tmpPath, pathname);
    try {
      fs.chmodSync(pathname, 0o600);
    } catch {
      // best-effort on platforms without chmod support
    }
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup when rename does not happen
    }
  }
}
