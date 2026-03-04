import fs from "node:fs";
import path from "node:path";

/**
 * Synchronously loads a JSON file. Use `loadJsonFileAsync` for non-blocking I/O.
 */
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

/**
 * Asynchronously loads a JSON file. Preferred for hot paths to avoid blocking.
 */
export async function loadJsonFileAsync(pathname: string): Promise<unknown> {
  try {
    await fs.promises.access(pathname, fs.constants.F_OK);
    const raw = await fs.promises.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Synchronously saves a JSON file. Use `saveJsonFileAsync` for non-blocking I/O.
 */
export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

/**
 * Asynchronously saves a JSON file. Preferred for hot paths to avoid blocking.
 */
export async function saveJsonFileAsync(pathname: string, data: unknown): Promise<void> {
  const dir = path.dirname(pathname);
  try {
    await fs.promises.access(dir, fs.constants.F_OK);
  } catch {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await fs.promises.writeFile(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  try {
    await fs.promises.chmod(pathname, 0o600);
  } catch {
    // Best-effort on platforms without chmod support
  }
}
