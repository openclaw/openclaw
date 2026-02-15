import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

// Avoid exporting inferred vitest mock types (TS2742 under pnpm + d.ts emit).
export type NoopLogger = {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

export function createNoopLogger(): NoopLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function createCronStoreHarness(options?: { prefix?: string }) {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? "openclaw-cron-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function makeStorePath() {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(dir, { recursive: true });
    return {
      storePath: path.join(dir, "cron", "jobs.json"),
      cleanup: async () => {},
    };
  }

  return { makeStorePath };
}

export function installCronTestHooks(options: {
  logger: ReturnType<typeof createNoopLogger>;
  baseTimeIso?: string;
}) {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(options.baseTimeIso ?? "2025-12-13T00:00:00.000Z"));
    options.logger.debug.mockClear();
    options.logger.info.mockClear();
    options.logger.warn.mockClear();
    options.logger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}
