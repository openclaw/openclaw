import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import type { Datastore } from "./datastore.js";
import { withFileLock } from "./file-lock.js";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

const DEFAULT_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

export class FilesystemDatastore implements Datastore {
  read<T>(key: string): T | null {
    return (loadJsonFile(key) as T) ?? null;
  }

  readWithFallback<T>(key: string, fallback: T): { value: T; exists: boolean } {
    const data = this.read<T>(key);
    if (data == null) {
      return { value: fallback, exists: false };
    }
    return { value: data, exists: true };
  }

  readJson5<T>(key: string): T | null {
    let raw: string;
    try {
      raw = fs.readFileSync(key, "utf-8");
    } catch (err) {
      if ((err as { code?: unknown })?.code === "ENOENT") {
        return null;
      }
      throw err;
    }
    // Try strict JSON first, fall back to JSON5 for human-editable files.
    try {
      return JSON.parse(raw) as T;
    } catch {
      // fall through to JSON5
    }
    try {
      return JSON5.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse ${key}: ${String(err)}`, { cause: err });
    }
  }

  async write(key: string, data: unknown): Promise<void> {
    saveJsonFile(key, data);
  }

  async writeWithBackup(key: string, data: unknown): Promise<void> {
    const dir = path.dirname(key);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = `${key}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    const json = `${JSON.stringify(data, null, 2)}\n`;
    await fs.promises.writeFile(tmp, json, "utf-8");
    await fs.promises.rename(tmp, key);
    try {
      await fs.promises.copyFile(key, `${key}.bak`);
    } catch {
      // best-effort
    }
  }

  async updateWithLock<T>(
    key: string,
    updater: (data: T | null) => { changed: boolean; result: T },
  ): Promise<void> {
    const dir = path.dirname(key);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    await withFileLock(key, DEFAULT_LOCK_OPTIONS, async () => {
      const current = (loadJsonFile(key) as T) ?? null;
      const { changed, result } = updater(current);
      if (changed) {
        saveJsonFile(key, result);
      }
    });
  }

  async delete(key: string): Promise<void> {
    try {
      fs.unlinkSync(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }
}
