import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withConsoleLogsRoutedToStderrForJson } from "../cli/json-output-mode.js";
import { defaultRuntime } from "../runtime.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { LoggingOperations } from "./sqlite-worker-logging.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("keeps worker diagnostics off JSON stdout through backend close", async () => {
  const root = tempDirs.make("openclaw-worker-logging-");
  const databasePath = path.join(root, "fixture.sqlite");
  await fs.writeFile(databasePath, "");
  vi.stubEnv("OPENCLAW_LOG_LEVEL", "debug");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const broker = new SqliteWorkerBroker();
  try {
    await withConsoleLogsRoutedToStderrForJson(["--json"], async () => {
      const store = await broker.open<LoggingOperations>({
        moduleUrl: new URL("./sqlite-worker-logging.test-support.ts", import.meta.url),
        databasePath,
        input: { logFile: path.join(root, "worker.log") },
      });
      if (!store) {
        throw new Error("Expected fixture worker to open");
      }
      const result = await store.execute({ type: "echo", input: "ready" });
      defaultRuntime.writeJson(result);
      await store.close();
    });
  } finally {
    await broker.close();
  }
  expect(JSON.parse(stdout.join(""))).toEqual({ value: "ready" });
  for (const phase of ["open", "execute", "close"]) {
    expect(stderr.join("")).toContain(`worker fixture ${phase}`);
  }
});
