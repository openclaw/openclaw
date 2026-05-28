import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeToNuwaDb } from "../../scripts/openclaw-cron-direct-runner.mjs";

type RunnerReport = {
  task: {
    id: string;
    exitCode: number;
    durationMs: number;
  };
  core_result: string;
  stdout_tail: string;
};

function createReport(): RunnerReport {
  return {
    task: {
      id: "next-safe",
      exitCode: 0,
      durationMs: 12,
    },
    core_result: "success",
    stdout_tail: "ok",
  };
}

describe("openclaw-cron-direct-runner learn bridge", () => {
  it("does not execute main when imported as a module", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "openclaw-cron-direct-runner.mjs");
    const code = [
      'import { pathToFileURL } from "node:url";',
      `await import(pathToFileURL(${JSON.stringify(scriptPath)}).href);`,
      'process.stdout.write("import-ok");',
    ].join("\n");
    const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();

    expect(stdout).toBe("import-ok");
  });

  it("still runs as a direct CLI entrypoint after import guard changes", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "openclaw-cron-direct-runner.mjs");
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, "--task", "next-safe", "--dry-run"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    const report = JSON.parse(stdout) as {
      task?: { id?: string; command?: string; exitCode?: number };
      core_result?: string;
    };

    expect(report.task?.id).toBe("next-safe");
    expect(report.task?.command).toBe("pnpm autonomous:controlled:next-safe");
    expect(report.task?.exitCode).toBe(0);
    expect(report.core_result).toBe("success");
  });

  it("uses post-cron hook first and skips fallback DB write when hook succeeds", async () => {
    const ingestCronReport = vi.fn(() => ({ ok: true }));
    const hookImporter = vi.fn(async () => ({ ingestCronReport }));
    const openDbFn = vi.fn();

    const result = await writeToNuwaDb(createReport(), {
      dbPath: "D:/OpenClaw/.tmp/nuwa-hook-success.db",
      hookImporter,
      openDbFn,
      fileSystem: { existsSync: vi.fn(() => true) },
    });

    expect(result).toBe(true);
    expect(hookImporter).toHaveBeenCalledExactlyOnceWith(
      "../extensions/evolution-learning/hooks/post-cron-learner.js",
    );
    expect(ingestCronReport).toHaveBeenCalledExactlyOnceWith({
      reportData: createReport(),
      dbPath: "D:/OpenClaw/.tmp/nuwa-hook-success.db",
    });
    expect(openDbFn).not.toHaveBeenCalled();
  });

  it("awaits async post-cron hook results before deciding fallback", async () => {
    const ingestCronReport = vi.fn(async () => ({ ok: true }));
    const hookImporter = vi.fn(async () => ({ ingestCronReport }));
    const openDbFn = vi.fn();

    const result = await writeToNuwaDb(createReport(), {
      dbPath: "D:/OpenClaw/.tmp/nuwa-hook-async-success.db",
      hookImporter,
      openDbFn,
      fileSystem: { existsSync: vi.fn(() => true) },
    });

    expect(result).toBe(true);
    expect(ingestCronReport).toHaveBeenCalledExactlyOnceWith({
      reportData: createReport(),
      dbPath: "D:/OpenClaw/.tmp/nuwa-hook-async-success.db",
    });
    expect(openDbFn).not.toHaveBeenCalled();
  });

  it("falls back to local DB write when hook does not return ok", async () => {
    const ingestCronReport = vi.fn(() => ({ ok: false }));
    const hookImporter = vi.fn(async () => ({ ingestCronReport }));
    const createTableRun = vi.fn();
    const insertRun = vi.fn();

    const db = {
      pragma: vi.fn(),
      prepare: vi.fn((sql: string) => {
        if (sql.includes("INSERT INTO learning_events")) {
          return { run: insertRun };
        }
        return { run: createTableRun };
      }),
      close: vi.fn(),
    };
    const openDbFn = vi.fn(async () => db);

    const result = await writeToNuwaDb(createReport(), {
      dbPath: "D:/OpenClaw/.tmp/nuwa-hook-fallback.db",
      hookImporter,
      openDbFn,
      fileSystem: { existsSync: vi.fn(() => true) },
      createId: () => "uuid-fallback",
    });

    expect(result).toBe(true);
    expect(openDbFn).toHaveBeenCalledExactlyOnceWith("D:/OpenClaw/.tmp/nuwa-hook-fallback.db", {
      readonly: false,
      fileMustExist: true,
    });
    expect(db.pragma).toHaveBeenNthCalledWith(1, "journal_mode = WAL");
    expect(db.pragma).toHaveBeenNthCalledWith(2, "busy_timeout = 3000");
    expect(createTableRun).toHaveBeenCalledExactlyOnceWith();
    expect(insertRun).toHaveBeenCalledTimes(1);

    const [id, payload, recordedAt] = insertRun.mock.calls[0] as [string, string, string];
    expect(id).toBe("uuid-fallback");
    expect(typeof recordedAt).toBe("string");
    expect(JSON.parse(payload)).toMatchObject({
      task_id: "next-safe",
      core_result: "success",
      job_type: "cron_direct_run",
    });
    expect(db.close).toHaveBeenCalledTimes(1);
  });
});
