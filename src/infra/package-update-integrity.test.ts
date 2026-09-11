import { afterEach, describe, expect, it } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

function captureReaderLogs() {
  const records: Array<Record<string, unknown>> = [];
  const capture = (line: string) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.subsystem === "update/package-integrity") {
      records.push(record);
    }
  };
  setLoggerOverride({ level: "silent", consoleLevel: "debug", consoleStyle: "json" });
  loggingState.rawConsole = { log: capture, info: capture, warn: capture, error: capture };
  return records;
}

async function readScanBudgetMs(timeoutMs?: number) {
  const records = captureReaderLogs();
  const reader = createPackageIntegrityReader(timeoutMs);
  await reader.observe("baseline", async () => undefined);
  const started = records.filter((record) => record.event === "reader-started");
  expect(started).toHaveLength(1);
  return started[0]?.budgetMs;
}

describe("package integrity scan budget", () => {
  it("defaults to 30 s when the caller supplies no budget", async () => {
    await expect(readScanBudgetMs()).resolves.toBe(30_000);
  });

  it("follows a caller budget above the default", async () => {
    // Before this, any caller budget above the default was clamped to 30 s, so a
    // package tree whose full-tree hash needs longer could never produce a baseline
    // fingerprint on the update path.
    await expect(readScanBudgetMs(55_000)).resolves.toBe(55_000);
  });

  it("caps a caller budget at the 5 minute ceiling", async () => {
    await expect(readScanBudgetMs(1_800_000)).resolves.toBe(5 * 60_000);
  });

  it("keeps a caller budget below the default", async () => {
    await expect(readScanBudgetMs(200)).resolves.toBe(200);
  });
});
