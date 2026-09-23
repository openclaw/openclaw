import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cliSource = `
  import { Command } from "commander";
  import { registerLogsCli } from "./src/cli/logs-cli.ts";
  const program = new Command();
  registerLogsCli(program);
  await program.parseAsync(process.argv.slice(1), { from: "user" });
`;
const producerSource = `
  import fs from "node:fs/promises";
  import { formatJsonConsoleLine } from "./src/logging/json-console-line.ts";
  const records = [
    formatJsonConsoleLine({ level: "warn", subsystem: "gateway", message: "console warning" }),
    formatJsonConsoleLine({ level: "error", subsystem: "worker", message: "console error" }),
    JSON.stringify({
      time: "2026-01-09T02:10:00.000Z",
      level: "warn", subsystem: "fallback", message: "metadata control",
      _meta: { logLevelName: "INFO", name: '{"subsystem":"canonical"}' },
    }),
  ];
  await fs.writeFile(process.argv[1], records.join("\\n") + "\\n");
`;

describe("logs CLI with real JSON console records", () => {
  it("retains console metadata in text and JSON through the configured-file fallback", async () => {
    const home = tempDirs.make("openclaw-logs-console-");
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const logFile = path.join(home, "console.jsonl");
    await fs.mkdir(stateDir, { recursive: true });
    // Own the unavailable endpoint so the real client cannot reach a user's Gateway.
    const unavailable = net.createServer((socket) => socket.destroy());
    unavailable.listen(0, "127.0.0.1");
    await once(unavailable, "listening");
    const address = unavailable.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture listener did not expose a TCP port");
    }
    try {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: { mode: "local", port: address.port, auth: { mode: "none" } },
          plugins: { enabled: false },
          logging: { file: logFile, level: "silent", consoleLevel: "silent" },
        }),
      );
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        NO_COLOR: "1",
        TZ: "UTC",
      };
      const run = (source: string, args: string[]) =>
        execFileAsync(
          process.execPath,
          ["--import", "./scripts/tsx.mjs", "--input-type=module", "-e", source, "--", ...args],
          { cwd: process.cwd(), env, timeout: 60_000, maxBuffer: 1024 * 1024 },
        );
      await run(producerSource, [logFile]);
      const original = await fs.readFile(logFile, "utf8");
      const text = await run(cliSource, ["logs", "--plain", "--utc", "--timeout", "100"]);
      const json = await run(cliSource, ["logs", "--json", "--timeout", "100"]);
      console.info("Real logs CLI text:\n" + text.stdout.replaceAll(home, "<fixture-home>"));
      console.info("Real logs CLI JSON:\n" + json.stdout.replaceAll(home, "<fixture-home>"));
      expect(text.stdout).toContain("info canonical metadata control");
      expect(text.stdout).toContain("warn gateway console warning");
      expect(text.stdout).toContain("error worker console error");
      const records = json.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.find((record) => record.type === "meta")).toMatchObject({
        sourceKind: "file",
        localFallback: true,
      });
      expect(records.filter((record) => record.type === "log")).toEqual([
        expect.objectContaining({
          level: "warn",
          subsystem: "gateway",
          message: "console warning",
        }),
        expect.objectContaining({ level: "error", subsystem: "worker", message: "console error" }),
        expect.objectContaining({
          level: "info",
          subsystem: "canonical",
          message: "metadata control",
        }),
      ]);
      expect(await fs.readFile(logFile, "utf8")).toBe(original);
    } finally {
      await new Promise<void>((resolve, reject) => {
        unavailable.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 180_000);
});
