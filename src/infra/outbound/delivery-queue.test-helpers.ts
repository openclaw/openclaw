import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import type { DeliverFn, RecoveryLogger } from "./delivery-queue.js";

export function installDeliveryQueueTmpDirHooks(): { readonly tmpDir: () => string } {
  let tmpDir = "";
  let fixtureRoot = "";
  let fixtureCount = 0;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dq-suite-"));
  });

  beforeEach(() => {
    tmpDir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    if (!fixtureRoot) {
      return;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  });

  return {
    tmpDir: () => tmpDir,
  };
}

export function readQueuedEntry<T = Record<string, unknown>>(tmpDir: string, id: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDir, "delivery-queue", `${id}.json`), "utf-8"),
  ) as T;
}

export function setQueuedEntryState(
  tmpDir: string,
  id: string,
  state: { retryCount: number; lastAttemptAt?: number; enqueuedAt?: number },
): void {
  const filePath = path.join(tmpDir, "delivery-queue", `${id}.json`);
  const entry = readQueuedEntry(tmpDir, id);
  entry.retryCount = state.retryCount;
  if (state.lastAttemptAt === undefined) {
    delete entry.lastAttemptAt;
  } else {
    entry.lastAttemptAt = state.lastAttemptAt;
  }
  if (state.enqueuedAt !== undefined) {
    entry.enqueuedAt = state.enqueuedAt;
  }
  fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8");
}

export function createRecoveryLog(): RecoveryLogger & {
  info: ReturnType<typeof vi.fn<(msg: string) => void>>;
  warn: ReturnType<typeof vi.fn<(msg: string) => void>>;
  error: ReturnType<typeof vi.fn<(msg: string) => void>>;
} {
  return {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  };
}

export function asDeliverFn(deliver: ReturnType<typeof vi.fn>): DeliverFn {
  return deliver as DeliverFn;
}
