import fs from "node:fs";
import { z } from "zod";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import type { SessionEntry } from "./types.js";

const SessionStoreSchema = z.record(z.string(), z.unknown()) as z.ZodType<
  Record<string, SessionEntry | undefined>
>;

function isSessionEntryRecord(value: unknown): value is SessionEntry {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readSessionStoreReadOnly(
  storePath: string,
): Record<string, SessionEntry | undefined> {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    if (!raw.trim()) {
      return {};
    }
    const parsed = safeParseJsonWithSchema(SessionStoreSchema, raw) ?? {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, entry]) => isSessionEntryRecord(entry)),
    );
  } catch {
    return {};
  }
}
