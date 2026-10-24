import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  createDiagnosticFixtureRouting,
  diagnosticCanaries,
  diagnosticEnvReportScript,
  withSyntheticDiagnosticEnv,
} from "./diagnostic-env.test-support.js";
import { inspectPortConnections, inspectPortUsage, inspectPortUsages } from "./ports-inspect.js";

// Only command location is substituted; the runner, env merge, Execa, and child are real.
vi.mock("./ports-lsof.js", () => ({ resolveLsofCommand: async () => "lsof" }));

it.skipIf(process.platform === "win32").each([
  ["single", false],
  ["single", true],
  ["batch", false],
  ["batch", true],
  ["connections", false],
  ["connections", true],
] as const)(
  "%s keeps diagnostics isolated (ss fallback: %s) and preserves payload inheritance",
  (family, fallback) =>
    withTempDir("diagnostic-env-", async (directory) => {
      const root = await realpath(directory);
      const reportPath = path.join(root, "children.jsonl");
      const routing = createDiagnosticFixtureRouting({
        PATH: root,
        HOME: root,
        TMPDIR: root,
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
      });
      const report = diagnosticEnvReportScript(routing);
      const expectedReport = (defined: boolean) => ({
        defined: Object.fromEntries(Object.keys(diagnosticCanaries).map((key) => [key, defined])),
        routingPreserved: true,
      });
      const port = 43123;
      const connected = family === "connections";
      const address = connected ? `127.0.0.1:${port}->127.0.0.1:54321` : `127.0.0.1:${port}`;
      const lsofOutput = `p424242\ncnode\nf1\nn${address}\n`;
      const ssOutput = connected
        ? `0 0 127.0.0.1:${port} 127.0.0.1:54321 users:(("node",pid=424242,fd=1))\n`
        : `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=424242,fd=1))\n`;
      // TMPDIR can live inside an ESM checkout; these executable fixtures use require.
      await writeFile(path.join(root, "package.json"), '{"type":"commonjs"}');
      for (const command of ["lsof", "ss", "ps"]) {
        await writeFile(
          path.join(root, command),
          String.raw`#!${process.execPath}
const fs = require('node:fs');
const command = ${JSON.stringify(command)};
fs.appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({command, ...JSON.parse(${report})}) + '\n');
const output = command === 'lsof' ? ${JSON.stringify(fallback ? "" : lsofOutput)}
  : command === 'ss' ? ${JSON.stringify(ssOutput)}
  : process.argv.includes('user=') ? 'fixture-user\n' : '1 node fixture-server\n';
process.stdout.write(output);
process.exitCode = command === 'lsof' ? ${fallback ? 2 : 0} : 0;
`,
          { mode: 0o755 },
        );
      }
      await withSyntheticDiagnosticEnv(routing, async () => {
        const parent = { ...process.env };
        const payload = async () => {
          const result = await runCommandWithTimeout(
            [process.execPath, "-e", `process.stdout.write(${report})`],
            { timeoutMs: 5000 },
          );
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual(expectedReport(true));
        };
        await payload();
        const entries =
          family === "connections"
            ? (await inspectPortConnections(port)).connections
            : family === "batch"
              ? (await inspectPortUsages([port, port])).get(port)?.listeners
              : (await inspectPortUsage(port)).listeners;
        expect(entries).toMatchObject([
          { pid: 424242, commandLine: "node fixture-server", ppid: 1, user: "fixture-user" },
        ]);
        await payload();
        expect(process.env).toEqual(parent);
        const reports = (await readFile(reportPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const commands = fallback ? ["lsof", "ss", "ps", "ps"] : ["lsof", "ps", "ps"];
        expect(reports.toSorted((a, b) => a.command.localeCompare(b.command))).toEqual(
          commands.toSorted().map((command) => Object.assign({ command }, expectedReport(false))),
        );
      });
    }),
);
