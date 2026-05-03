import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyContextEngineFallbackGuard,
  fallbackGuardOutcomeIsBlocking,
  DEFAULT_FALLBACK_GUARD_SIZE_BYTES,
} from "./fallback-guard.js";

function createTempSessionsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fallback-guard-"));
}

function writeJsonl(dir: string, name: string, sizeBytes: number): string {
  const filePath = path.join(dir, name);
  const buf = Buffer.alloc(sizeBytes, "x");
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function makeLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

function configWith(
  action?: "warn" | "archive" | "block" | "auto",
  sizeBytes?: number | string,
): OpenClawConfig {
  return {
    session: {
      maintenance: {
        contextFallbackGuard: {
          ...(action ? { action } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        },
      },
    },
  } as OpenClawConfig;
}

describe("applyContextEngineFallbackGuard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempSessionsDir();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns inspected:0 when sessions dir does not exist", () => {
    const logger = makeLogger();
    const outcome = applyContextEngineFallbackGuard({
      config: configWith("warn"),
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => path.join(tmpDir, "missing"),
    });
    expect(outcome.inspected).toBe(0);
    expect(outcome.triggered).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not trigger when transcripts are below threshold", () => {
    writeJsonl(tmpDir, "session-a.jsonl", 1024);
    writeJsonl(tmpDir, "session-b.jsonl", 2048);
    const logger = makeLogger();
    const outcome = applyContextEngineFallbackGuard({
      config: configWith("warn", "1mb"),
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => tmpDir,
    });
    expect(outcome.inspected).toBe(2);
    expect(outcome.triggered).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when a transcript exceeds the threshold under action=warn", () => {
    const big = writeJsonl(tmpDir, "session-big.jsonl", 2 * 1024 * 1024);
    writeJsonl(tmpDir, "session-small.jsonl", 1024);
    const logger = makeLogger();
    const outcome = applyContextEngineFallbackGuard({
      config: configWith("warn", "1mb"),
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => tmpDir,
      warnedPaths: new Set(),
    });
    expect(outcome.triggered).toHaveLength(1);
    expect(outcome.triggered[0]?.path).toBe(big);
    expect(outcome.triggered[0]?.appliedAction).toBe("warn");
    expect(fs.existsSync(big)).toBe(true); // not renamed
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = logger.warn.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("session-size guard tripped");
    expect(message).toContain('engine="lossless-claw"');
    expect(message).toContain("action=warn");
  });

  it("archives when action=archive", () => {
    const big = writeJsonl(tmpDir, "session-big.jsonl", 2 * 1024 * 1024);
    const logger = makeLogger();
    const outcome = applyContextEngineFallbackGuard({
      config: configWith("archive", "1mb"),
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => tmpDir,
    });
    expect(outcome.triggered).toHaveLength(1);
    expect(outcome.triggered[0]?.appliedAction).toBe("archive");
    expect(outcome.triggered[0]?.archivedPath).toMatch(
      /session-big\.archived-no-context-engine-.*\.jsonl$/u,
    );
    expect(fs.existsSync(big)).toBe(false);
    const archived = outcome.triggered[0]?.archivedPath;
    expect(archived).toBeDefined();
    expect(fs.existsSync(archived as string)).toBe(true);
  });

  it("flags entries as block under action=block but does not throw or rename", () => {
    const big = writeJsonl(tmpDir, "session-big.jsonl", 2 * 1024 * 1024);
    const logger = makeLogger();
    const outcome = applyContextEngineFallbackGuard({
      config: configWith("block", "1mb"),
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => tmpDir,
    });
    expect(outcome.triggered).toHaveLength(1);
    expect(outcome.triggered[0]?.appliedAction).toBe("block");
    expect(fs.existsSync(big)).toBe(true);
    expect(fallbackGuardOutcomeIsBlocking(outcome)).toBe(true);
  });

  it("auto resolves to archive when context-engine history is present", () => {
    const big = writeJsonl(tmpDir, "session-big.jsonl", 2 * 1024 * 1024);
    const logger = makeLogger();
    const outcome = applyContextEngineFallbackGuard({
      config: configWith("auto", "1mb"),
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => tmpDir,
      hasContextEngineHistory: () => true,
    });
    expect(outcome.resolvedAction).toBe("archive");
    expect(outcome.triggered[0]?.appliedAction).toBe("archive");
    expect(fs.existsSync(big)).toBe(false);
  });

  it("auto resolves to warn when no context-engine history is present", () => {
    writeJsonl(tmpDir, "session-big.jsonl", 2 * 1024 * 1024);
    const logger = makeLogger();
    const outcome = applyContextEngineFallbackGuard({
      config: configWith("auto", "1mb"),
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => tmpDir,
      hasContextEngineHistory: () => false,
      warnedPaths: new Set(),
    });
    expect(outcome.resolvedAction).toBe("warn");
    expect(outcome.triggered[0]?.appliedAction).toBe("warn");
  });

  it("ignores backup, reset, deleted, archived, and trim-backup files", () => {
    writeJsonl(tmpDir, "session-live.jsonl", 2 * 1024 * 1024);
    writeJsonl(tmpDir, "session-x.jsonl.bak.2026-01-01.jsonl", 5 * 1024 * 1024);
    writeJsonl(tmpDir, "session-y.jsonl.reset.2026-01-01.jsonl", 5 * 1024 * 1024);
    writeJsonl(tmpDir, "session-z.jsonl.deleted.2026-01-01.jsonl", 5 * 1024 * 1024);
    writeJsonl(tmpDir, "session-w.archived-no-context-engine-2026-01-01.jsonl", 5 * 1024 * 1024);
    writeJsonl(tmpDir, "session-q.jsonl.trim-backup.2026-01-01.jsonl", 5 * 1024 * 1024);
    const logger = makeLogger();
    const outcome = applyContextEngineFallbackGuard({
      config: configWith("warn", "1mb"),
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => tmpDir,
      warnedPaths: new Set(),
    });
    expect(outcome.inspected).toBe(1);
    expect(outcome.triggered).toHaveLength(1);
    expect(outcome.triggered[0]?.path).toMatch(/session-live\.jsonl$/u);
  });

  it("uses default 1MiB threshold when config does not override", () => {
    writeJsonl(tmpDir, "session-big.jsonl", DEFAULT_FALLBACK_GUARD_SIZE_BYTES + 1024);
    writeJsonl(tmpDir, "session-small.jsonl", 1024);
    const logger = makeLogger();
    const outcome = applyContextEngineFallbackGuard({
      // No config override at all
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => tmpDir,
      hasContextEngineHistory: () => false, // force resolved warn
      warnedPaths: new Set(),
    });
    expect(outcome.resolvedSizeBytes).toBe(DEFAULT_FALLBACK_GUARD_SIZE_BYTES);
    expect(outcome.triggered).toHaveLength(1);
  });

  it("dedups warn messages for the same path within one process", () => {
    writeJsonl(tmpDir, "session-big.jsonl", 2 * 1024 * 1024);
    const logger = makeLogger();
    const sharedDedupSet = new Set<string>();
    for (let i = 0; i < 3; i++) {
      applyContextEngineFallbackGuard({
        config: configWith("warn", "1mb"),
        failedEngineId: "lossless-claw",
        fallbackReason: "engine not registered",
        logger,
        resolveSessionsDir: () => tmpDir,
        warnedPaths: sharedDedupSet,
      });
    }
    // Three calls, but only one warning emitted thanks to per-path dedup.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to warn when archive rename fails", () => {
    const big = writeJsonl(tmpDir, "session-big.jsonl", 2 * 1024 * 1024);
    const logger = makeLogger();
    const fakeFs = {
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      statSync: fs.statSync,
      renameSync: () => {
        throw new Error("rename denied (simulated)");
      },
    } as Pick<typeof fs, "existsSync" | "readdirSync" | "statSync" | "renameSync">;
    const outcome = applyContextEngineFallbackGuard({
      config: configWith("archive", "1mb"),
      failedEngineId: "lossless-claw",
      fallbackReason: "engine not registered",
      logger,
      resolveSessionsDir: () => tmpDir,
      fs: fakeFs,
    });
    expect(outcome.triggered).toHaveLength(1);
    expect(outcome.triggered[0]?.appliedAction).toBe("warn");
    expect(fs.existsSync(big)).toBe(true); // still there
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error?.mock.calls[0]?.[0] ?? "").toContain("action=archive FAILED");
  });

  it("returns blocking=false when no triggered entries are blocked", () => {
    const outcome = {
      inspected: 1,
      triggered: [
        {
          path: "/x",
          sizeBytes: 1,
          appliedAction: "warn" as const,
        },
      ],
      resolvedSizeBytes: 1,
      resolvedAction: "warn" as const,
    };
    expect(fallbackGuardOutcomeIsBlocking(outcome)).toBe(false);
  });
});
