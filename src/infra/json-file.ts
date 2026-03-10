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
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

export async function loadJsonFileAsync(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.promises.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export async function saveJsonFileAsync(pathname: string, data: unknown): Promise<void> {
  const dir = path.dirname(pathname);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await fs.promises.writeFile(pathname, content, { encoding: "utf8", mode: 0o600 });
}
