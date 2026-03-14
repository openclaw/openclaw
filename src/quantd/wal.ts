import fs from "node:fs/promises";
import path from "node:path";
import type { QuantdWalRecord } from "./types.js";

export async function appendQuantdWalRecord(params: {
  walPath: string;
  record: QuantdWalRecord;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.walPath), { recursive: true });
  await fs.appendFile(params.walPath, `${JSON.stringify(params.record)}\n`, "utf-8");
}

export async function readQuantdWalRecords(params: {
  walPath: string;
}): Promise<QuantdWalRecord[]> {
  try {
    const raw = await fs.readFile(params.walPath, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as QuantdWalRecord)
      .toSorted((a, b) => a.sequence - b.sequence);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
