import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock, type FileLockOptions } from "../../infra/file-lock.js";

export type IntensiveMode = "normal" | "intensive";

export type ModeState = {
  mode: IntensiveMode;
  activatedAt?: string;
  /** Optional goal for the hyperfocus session, injected into the system prompt each message. */
  goal?: string;
};

const LOCK_OPTIONS: FileLockOptions = {
  retries: { retries: 5, factor: 2, minTimeout: 200, maxTimeout: 5_000, randomize: true },
  stale: 30_000,
};

function modePath(narrativeDir: string): string {
  return path.join(narrativeDir, "mode.json");
}

export async function readModeState(narrativeDir: string): Promise<ModeState> {
  try {
    const raw = await fs.readFile(modePath(narrativeDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "mode" in parsed) {
      return parsed as ModeState;
    }
  } catch {
    // File missing or invalid — default to normal
  }
  return { mode: "normal" };
}

export async function writeModeState(narrativeDir: string, state: ModeState): Promise<void> {
  const p = modePath(narrativeDir);
  await withFileLock(p, LOCK_OPTIONS, async () => {
    const tmp = `${p}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
    await fs.rename(tmp, p);
  });
}
