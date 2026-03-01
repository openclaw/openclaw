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
  readJson(key: string): unknown {
    return loadJsonFile(key) ?? null;
  }

  readJsonWithFallback(key: string, fallback: unknown): { value: unknown; exists: boolean } {
    const data = this.readJson(key);
    if (data == null) {
      return { value: fallback, exists: false };
    }
    return { value: data, exists: true };
  }

  readText(key: string): string | null {
    try {
      return fs.readFileSync(key, "utf-8");
    } catch (err) {
      if ((err as { code?: unknown })?.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  readJson5(key: string): unknown {
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
      return JSON.parse(raw);
    } catch {
      // fall through to JSON5
    }
    try {
      return JSON5.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse ${key}: ${String(err)}`, { cause: err });
    }
  }

  writeJson(key: string, data: unknown): void {
    saveJsonFile(key, data);
  }

  writeText(key: string, content: string): void {
    const dir = path.dirname(key);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(key, content, "utf-8");
  }

  writeJsonWithBackup(key: string, data: unknown): void {
    const dir = path.dirname(key);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = `${key}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    const json = `${JSON.stringify(data, null, 2)}\n`;
    fs.writeFileSync(tmp, json, "utf-8");
    fs.renameSync(tmp, key);
    try {
      fs.copyFileSync(key, `${key}.bak`);
    } catch {
      // best-effort
    }
  }

  async updateJsonWithLock(
    key: string,
    updater: (data: unknown) => { changed: boolean; result: unknown },
  ): Promise<void> {
    const dir = path.dirname(key);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    await withFileLock(key, DEFAULT_LOCK_OPTIONS, async () => {
      // Strict parse: throw on malformed JSON rather than silently treating as empty.
      let current: unknown = null;
      if (fs.existsSync(key)) {
        current = JSON.parse(fs.readFileSync(key, "utf-8"));
      }
      const { changed, result } = updater(current);
      if (changed) {
        saveJsonFile(key, result);
      }
    });
  }

  delete(key: string): void {
    try {
      fs.unlinkSync(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }

  async flush(): Promise<void> {
    // No-op: all FS writes are synchronous.
  }
}
