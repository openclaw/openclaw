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
  // Set mode atomically during write to avoid race condition where file
  // is briefly readable by other users before chmod
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    // Best-effort chmod for platforms that don't support mode in writeFileSync
    fs.chmodSync(pathname, 0o600);
  } catch {
    // ignore chmod errors on platforms without chmod support
  }
}
