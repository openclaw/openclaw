import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveDurableRuntimeSqlitePath } from "../durable/config.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { durableCommand } from "./durable.js";

function createRuntimeCapture() {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: (message: unknown) => logs.push(String(message)),
    error: (message: unknown) => errors.push(String(message)),
    exit: vi.fn(),
  };
  return { errors, logs, runtime };
}

describe("durableCommand", () => {
  it("does not create or migrate durable state when the runtime is disabled", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-disabled-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sqlitePath = resolveDurableRuntimeSqlitePath(env);
    const candidates = resolveSqliteDatabaseFilePaths(sqlitePath);
    const { errors, logs, runtime } = createRuntimeCapture();

    try {
      await durableCommand({ action: "stats", env }, runtime);

      expect(errors).toEqual([]);
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(logs).toEqual([
        "Durable runtime is disabled. Set OPENCLAW_DURABLE_RUNTIME=1 to inspect durable runtime state.",
      ]);
      for (const candidate of candidates) {
        expect(fs.existsSync(candidate)).toBe(false);
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports disabled status as JSON without creating durable state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-disabled-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sqlitePath = resolveDurableRuntimeSqlitePath(env);
    const { logs, runtime } = createRuntimeCapture();

    try {
      await durableCommand({ action: "stats", env, json: true }, runtime);

      expect(JSON.parse(logs[0] ?? "{}")).toEqual({ enabled: false });
      for (const candidate of resolveSqliteDatabaseFilePaths(sqlitePath)) {
        expect(fs.existsSync(candidate)).toBe(false);
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
