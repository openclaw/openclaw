import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/lib/doctor-install-switch/write-wrapper.mjs";
const EXEC_START_ASSERTION_PATH = "scripts/e2e/lib/doctor-install-switch/assert-exec-start.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const run = (script: string, args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env } });
const runExecStartAssertion = (args: string[]) => run(EXEC_START_ASSERTION_PATH, args);
function makeUnit(command: string) {
  const root = tempDirs.make("openclaw-doctor-exec-start-");
  const unitPath = path.join(root, "openclaw-gateway.service");
  const entrypoint = path.join(root, "index with spaces.js");
  writeFileSync(unitPath, `[Service]\nExecStart=${command.replace("ENTRY", entrypoint)}\n`);
  return { unitPath, entrypoint };
}

it("writes an executable wrapper that preserves quoted paths and arguments", () => {
  const root = tempDirs.make("openclaw-doctor-wrapper-");
  const npmDir = path.join(root, "bin with ' quote");
  mkdirSync(npmDir);

  const fakeNpm = path.join(npmDir, "npm mock");
  const forwardedArgsPath = path.join(root, "forwarded args.json");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(forwardedArgsPath)}, JSON.stringify(process.argv.slice(2)));
`,
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(fakeNpm, 0o755);

  const wrapperPath = path.join(root, "openclaw wrapper");
  const wrapperLogPath = path.join(root, "wrapper log with ' quote.txt");
  const writeResult = run(SCRIPT_PATH, [wrapperPath, fakeNpm, wrapperLogPath]);

  expect(writeResult).toMatchObject({ status: 0, stderr: "" });

  const args = ["gateway", "install", "--flag=value with spaces", "it's quoted"];
  const wrapperResult = spawnSync(wrapperPath, args, { encoding: "utf8", env: { ...process.env } });

  expect(wrapperResult).toMatchObject({ status: 0, stderr: "" });
  expect(readFileSync(wrapperLogPath, "utf8")).toBe(`${args.join("\n")}\n`);
  expect(JSON.parse(readFileSync(forwardedArgsPath, "utf8"))).toEqual(args);
});
it("resolves a quoted entrypoint after inserted Node heap flags", () => {
  const { unitPath, entrypoint } = makeUnit(
    '"/usr/local/bin/node runtime" --max-old-space-size=4096 "ENTRY" gateway --port 18789',
  );
  writeFileSync(entrypoint, "export {};\n");

  const result = runExecStartAssertion(["entrypoint", unitPath, entrypoint]);

  expect(result).toMatchObject({ status: 0, stderr: "" });

  const exists = runExecStartAssertion(["entrypoint-exists", unitPath]);
  expect(exists.status, exists.stderr).toBe(0);
  expect(exists.stdout.trim()).toBe(entrypoint);
});

it.each(["missing", "directory"])("rejects a %s service entrypoint", (kind) => {
  const { unitPath, entrypoint } = makeUnit(
    '/usr/bin/node --max-old-space-size=4096 "ENTRY" gateway',
  );
  if (kind === "directory") {
    mkdirSync(entrypoint);
  }

  const result = runExecStartAssertion(["entrypoint-exists", unitPath]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Entrypoint in service unit does not exist: ${entrypoint}`);
});

it("reports the parsed argv when entrypoint detection fails", () => {
  const { unitPath } = makeUnit(
    "/usr/bin/node --max-old-space-size=4096 /app/dist/index.js gateway",
  );

  const result = runExecStartAssertion(["entrypoint", unitPath, "/app/dist/other-index.js"]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Expected entrypoint /app/dist/other-index.js, got /app/dist/index.js.",
  );
  expect(result.stderr).toContain(
    'ExecStart argv: ["/usr/bin/node","--max-old-space-size=4096","/app/dist/index.js","gateway"]',
  );
});
