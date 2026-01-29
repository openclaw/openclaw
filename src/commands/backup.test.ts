import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupCreateCommand, backupExportCommand, backupRestoreCommand } from "./backup.js";

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    exit: (code: number) => {
      throw new Error(`exit(${code})`);
    },
    logs,
    errors,
  };
}

describe("backup create & restore", () => {
  let stateDir: string;
  let backupDir: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "moltbot-backup-state-"));
    backupDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "moltbot-backup-out-"));
    origEnv = process.env.CLAWDBOT_STATE_DIR;
    process.env.CLAWDBOT_STATE_DIR = stateDir;

    // Create some test state
    await fs.promises.mkdir(path.join(stateDir, "agents", "pi", "sessions"), { recursive: true });
    await fs.promises.writeFile(
      path.join(stateDir, "agents", "pi", "sessions", "main.jsonl"),
      JSON.stringify({ role: "user", content: "Hello", timestamp: Date.now() }) + "\n",
      "utf-8",
    );
    await fs.promises.writeFile(
      path.join(stateDir, "moltbot.json"),
      JSON.stringify({ agents: {} }),
      "utf-8",
    );
  });

  afterEach(async () => {
    if (origEnv !== undefined) {
      process.env.CLAWDBOT_STATE_DIR = origEnv;
    } else {
      delete process.env.CLAWDBOT_STATE_DIR;
    }
    await fs.promises.rm(stateDir, { recursive: true, force: true });
    await fs.promises.rm(backupDir, { recursive: true, force: true });
  });

  it("creates a backup with manifest", async () => {
    const outputDir = path.join(backupDir, "test-backup");
    const runtime = createRuntime();
    await backupCreateCommand({ output: outputDir }, runtime);

    expect(runtime.logs.some((l) => l.includes("Backup created"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "backup-manifest.json"))).toBe(true);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, "backup-manifest.json"), "utf-8"),
    );
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(manifest.includesCredentials).toBe(false);
  });

  it("creates backup as JSON", async () => {
    const outputDir = path.join(backupDir, "json-backup");
    const runtime = createRuntime();
    await backupCreateCommand({ output: outputDir, json: true }, runtime);

    const output = JSON.parse(runtime.logs.join("\n"));
    expect(output.fileCount).toBeGreaterThan(0);
    expect(output.output).toBe(outputDir);
  });

  it("restores a backup", async () => {
    // Create backup
    const outputDir = path.join(backupDir, "restore-test");
    const runtime1 = createRuntime();
    await backupCreateCommand({ output: outputDir }, runtime1);

    // Wipe state dir
    await fs.promises.rm(path.join(stateDir, "agents"), { recursive: true, force: true });
    expect(
      fs.existsSync(path.join(stateDir, "agents", "pi", "sessions", "main.jsonl")),
    ).toBe(false);

    // Restore
    const runtime2 = createRuntime();
    await backupRestoreCommand({ input: outputDir }, runtime2);
    expect(runtime2.logs.some((l) => l.includes("Restored"))).toBe(true);

    // Verify file was restored
    expect(
      fs.existsSync(path.join(stateDir, "agents", "pi", "sessions", "main.jsonl")),
    ).toBe(true);
  });

  it("dry-run restore shows files without changing them", async () => {
    const outputDir = path.join(backupDir, "dryrun-test");
    const runtime1 = createRuntime();
    await backupCreateCommand({ output: outputDir }, runtime1);

    // Remove a file
    await fs.promises.rm(path.join(stateDir, "agents", "pi", "sessions", "main.jsonl"));

    const runtime2 = createRuntime();
    await backupRestoreCommand({ input: outputDir, dryRun: true }, runtime2);
    expect(runtime2.logs.some((l) => l.includes("Dry run"))).toBe(true);

    // File should NOT be restored in dry run
    expect(
      fs.existsSync(path.join(stateDir, "agents", "pi", "sessions", "main.jsonl")),
    ).toBe(false);
  });

  it("rejects invalid backup directory", async () => {
    const runtime = createRuntime();
    await backupRestoreCommand({ input: "/tmp/nonexistent-backup" }, runtime);
    expect(runtime.errors.some((l) => l.includes("Not a valid backup"))).toBe(true);
  });
});

describe("backup export", () => {
  let stateDir: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "moltbot-export-"));
    origEnv = process.env.CLAWDBOT_STATE_DIR;
    process.env.CLAWDBOT_STATE_DIR = stateDir;

    await fs.promises.mkdir(path.join(stateDir, "agents", "pi", "sessions"), { recursive: true });
    const lines = [
      JSON.stringify({ role: "user", content: "Hello", timestamp: "2024-01-15T10:00:00Z" }),
      JSON.stringify({ role: "assistant", content: "Hi there!", timestamp: "2024-01-15T10:00:01Z" }),
    ];
    await fs.promises.writeFile(
      path.join(stateDir, "agents", "pi", "sessions", "main.jsonl"),
      lines.join("\n"),
      "utf-8",
    );
  });

  afterEach(async () => {
    if (origEnv !== undefined) {
      process.env.CLAWDBOT_STATE_DIR = origEnv;
    } else {
      delete process.env.CLAWDBOT_STATE_DIR;
    }
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  });

  it("exports as markdown", async () => {
    const outputPath = path.join(stateDir, "export.md");
    const runtime = createRuntime();
    await backupExportCommand({ format: "markdown", output: outputPath }, runtime);

    expect(runtime.logs.some((l) => l.includes("Exported to"))).toBe(true);
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("pi / main");
    expect(content).toContain("Hello");
    expect(content).toContain("Hi there!");
  });

  it("exports as jsonl", async () => {
    const outputPath = path.join(stateDir, "export.jsonl");
    const runtime = createRuntime();
    await backupExportCommand({ format: "jsonl", output: outputPath }, runtime);

    const content = fs.readFileSync(outputPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.agentId).toBe("pi");
    expect(first.content).toBe("Hello");
  });

  it("filters by agent", async () => {
    // Add another agent's sessions
    await fs.promises.mkdir(path.join(stateDir, "agents", "other", "sessions"), { recursive: true });
    await fs.promises.writeFile(
      path.join(stateDir, "agents", "other", "sessions", "chat.jsonl"),
      JSON.stringify({ role: "user", content: "Other agent" }),
      "utf-8",
    );

    const outputPath = path.join(stateDir, "export.jsonl");
    const runtime = createRuntime();
    await backupExportCommand({ format: "jsonl", output: outputPath, agent: "pi" }, runtime);

    const content = fs.readFileSync(outputPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.every((l) => JSON.parse(l).agentId === "pi")).toBe(true);
  });
});
