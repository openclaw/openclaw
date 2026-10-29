import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatJsonConsoleLine } from "../logging/json-console-line.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { cliChildEnv } from "./cli-process-fixture.test-support.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const expectedLogs = [
  ["warn", "gateway", "console warning"],
  ["error", "worker", "console error"],
  ["info", "canonical", "metadata control"],
] as const;
const cliSource = `
  import { Command } from "commander";
  import { registerLogsCli } from "./src/cli/logs-cli.ts";
  import { registerPreActionHooks } from "./src/cli/program/preaction.ts";
  const program = new Command();
  registerPreActionHooks(program, "test");
  registerLogsCli(program);
  await program.parseAsync(process.argv.slice(1), { from: "user" });
`;
const original =
  [
    formatJsonConsoleLine({ level: "warn", subsystem: "gateway", message: "console warning" }),
    formatJsonConsoleLine({ level: "error", subsystem: "worker", message: "console error" }),
    JSON.stringify({
      time: "2026-01-09T02:10:00.000Z",
      level: "warn",
      subsystem: "fallback",
      message: "metadata control",
      _meta: { logLevelName: "INFO", name: '{"subsystem":"canonical"}' },
    }),
  ].join("\n") + "\n";

it.each(["sqlite", "postgres"])(
  "retains console metadata through passive %s config admission and file fallback",
  async (engine) => {
    const home = tempDirs.make("openclaw-logs-console-");
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const logFile = path.join(home, "console.jsonl");
    await fs.mkdir(stateDir, { recursive: true });
    // Own the unavailable endpoint so the real client cannot reach a user's Gateway.
    const { claim, releaseListener } = await reserveTestPortListener({
      offsets: [0],
      createListener: () => net.createServer((socket) => socket.destroy()),
    });
    try {
      const connection = { source: "env", provider: "default", id: "OPENCLAW_MISSING_LOGS_DSN" };
      const database = engine === "postgres" ? { engine, postgres: { connection } } : undefined;
      const config = {
        database,
        gateway: { mode: "local", port: claim.port, auth: { mode: "none" } },
        plugins: { enabled: false },
        logging: { file: logFile, level: "silent", consoleLevel: "silent" },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      const env = cliChildEnv(home, {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        NO_COLOR: "1",
        TZ: "UTC",
      });
      const run = (...args: string[]) =>
        execFileAsync(
          process.execPath,
          ["--import", "./scripts/tsx.mjs", "--input-type=module", "-e", cliSource, "--", ...args],
          { cwd: process.cwd(), env, timeout: 60_000, maxBuffer: 1024 * 1024 },
        );
      await fs.writeFile(logFile, original);
      const text = await run("logs", "--plain", "--utc", "--timeout", "100");
      const json = await run("logs", "--json", "--timeout", "100");
      for (const row of expectedLogs) {
        expect(text.stdout).toContain(row.join(" "));
      }
      const lines = json.stdout.trim().split("\n");
      const records = lines.map((line) => JSON.parse(line));
      expect(records.find((record) => record.type === "meta")).toMatchObject({
        sourceKind: "file",
        localFallback: true,
      });
      expect(records.filter((record) => record.type === "log")).toMatchObject(
        expectedLogs.map(([level, subsystem, message]) => ({ level, subsystem, message })),
      );
      expect(await fs.readFile(logFile, "utf8")).toBe(original);
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      try {
        await releaseListener();
      } finally {
        await claim.release();
      }
    }
  },
  180_000,
);
