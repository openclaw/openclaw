import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const content = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${pathname}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
    fs.renameSync(tmp, pathname);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // cleanup best-effort
      }
    }
  }
}
