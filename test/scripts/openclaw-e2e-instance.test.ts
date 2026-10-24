import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const pendingChildCompletions = new Set<Promise<unknown>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Timeout cleanup still needs fixture PID files until its native child closes.
    await Promise.allSettled(pendingChildCompletions);
    cleanup();
  }),
);
let receipts: FixtureReceiptChannel;
let tempDir: string;
beforeEach(() => {
  tempDir = tempDirs.make("openclaw-e2e-");
});
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

const helperPath = path.resolve("scripts/lib/openclaw-e2e-instance.sh");
const hostPath = [
  path.dirname(process.execPath),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
].join(path.delimiter);

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function observeChild(child: ChildProcess) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    },
  ).finally(() => {
    pendingChildCompletions.delete(closed);
  });
  pendingChildCompletions.add(closed);
  return { child, closed };
}

async function withNodeFixture(
  signal: AbortSignal,
  source: string,
  args: string[],
  run: (fixture: ReturnType<typeof observeChild>, startedAt: number) => void,
) {
  const script = path.join(tempDir, "listener.cjs");
  fs.writeFileSync(script, source);
  const startedAt = Date.now();
  const fixture = observeChild(
    spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  );
  const ready = new Promise<void>((resolve) => {
    fixture.child.once("message", () => resolve());
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        ready,
        fixture.closed,
        "fixture exited before publishing readiness",
      ),
      signal,
    );
    run(fixture, startedAt);
  } finally {
    fixture.child.kill("SIGKILL");
    await fixture.closed;
  }
}

function startBash(script: string, env: Record<string, string | undefined> = {}) {
  return observeChild(
    spawn("/bin/bash", ["-c", script], {
      env: shellTestEnv(env),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function killFixturePid(pid: number) {
  if (Math.abs(pid) > 1) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function killFixturePids(...markers: string[]) {
  for (const marker of markers) {
    if (fs.existsSync(marker)) {
      killFixturePid(Number(fs.readFileSync(marker, "utf8")));
    }
  }
}

async function closeBashFixture(fixture: ReturnType<typeof startBash>) {
  const { child } = fixture;
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    killFixturePid(-child.pid);
  }
  await fixture.closed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Shell stop/watchdog escalation can return before a foreign PID has been reaped.
async function waitForProcessGone(
  pid: number,
  signal: AbortSignal,
  message: string,
): Promise<void> {
  while (isProcessAlive(pid)) {
    await delay(5, undefined, { signal }).catch((error: unknown) => {
      throw new Error(`${message}: ${pid}`, { cause: error });
    });
  }
}

async function fixtureReadyBeforeSettlement(marker: string, operation: PromiseLike<unknown>) {
  await Promise.race([
    receipts.waitFor(marker, "ready"),
    Promise.resolve(operation).then(() => {
      // Marker publication precedes the fixture receipt; a separate pipe may deliver it late.
      if (!fs.existsSync(marker)) {
        throw new Error(`fixture exited before publishing ${marker}`);
      }
    }),
  ]);
}

function shellTestEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? os.tmpdir(),
    PATH: hostPath,
    SHELL: "/bin/bash",
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function runBash(
  script: string | string[],
  env?: Record<string, string | undefined>,
  timeout?: number,
  separator = "\n",
  input?: string,
): SpawnSyncReturns<string> {
  return spawnSync("/bin/bash", ["-c", Array.isArray(script) ? script.join(separator) : script], {
    encoding: "utf8",
    env: env === undefined ? undefined : shellTestEnv(env),
    timeout,
    input,
  });
}

function runBashWithHelper(
  lines: string[],
  env?: Record<string, string | undefined>,
  timeout?: number,
  separator = "\n",
  input?: string,
): SpawnSyncReturns<string> {
  return runBash(
    ["set -euo pipefail", `source ${shellQuote(helperPath)}`, ...lines],
    env,
    timeout,
    separator,
    input,
  );
}

function runSourcedHelper(
  script: string,
  overrides: Record<string, string | undefined> | null = {},
): SpawnSyncReturns<string> {
  return spawnSync(
    "bash",
    ["-lc", ["set -euo pipefail", `source ${shellQuote(helperPath)}`, script].join("; ")],
    { encoding: "utf8", env: overrides === null ? undefined : shellTestEnv(overrides) },
  );
}

function runGatewayReadyFixture(lines: string[]) {
  return runBashWithHelper(
    [
      "sleep 30 &",
      'gateway_pid="$!"',
      "trap 'kill \"$gateway_pid\" >/dev/null 2>&1 || true' EXIT",
      ...lines,
    ],
    {},
    5_000,
  );
}

function expectShellSuccess(result: ReturnType<typeof spawnSync>) {
  expect(result.status, String(result.stderr || result.stdout || result.error?.message || "")).toBe(
    0,
  );
}

function createPackageInstallFixture(
  directory: string,
  {
    timeout = "timeout",
    killAfter = true,
    npm = ['printf "%s\\n" "$*" >"$OPENCLAW_TEST_NPM_ARGS"'],
  } = {},
) {
  const fixture = {
    logPath: path.join(directory, "install.log"),
    npmArgsPath: path.join(directory, "npm-args.txt"),
    packagePath: path.join(directory, "openclaw.tgz"),
    prefixPath: path.join(directory, "prefix"),
    redactorPath: path.join(directory, "redactor.mjs"),
    timeoutArgsPath: path.join(directory, "timeout-args.txt"),
  };
  const packageRoot = tempDirs.make("openclaw-e2e-package-");
  fs.mkdirSync(path.join(packageRoot, "package"));
  fs.writeFileSync(
    path.join(packageRoot, "package/package.json"),
    JSON.stringify({ name: "openclaw-e2e-fixture", version: "0.0.0" }),
  );
  execFileSync("tar", ["-czf", fixture.packagePath, "-C", packageRoot, "package"]);
  fs.writeFileSync(
    fixture.redactorPath,
    "export const redactSensitiveText = (value) => value;\n",
    "utf8",
  );
  writeFakeTimeout(path.join(directory, timeout), killAfter);
  writeBashExecutable(path.join(directory, "npm"), npm);
  return {
    ...fixture,
    env: {
      PATH: timeout === "gtimeout" ? directory : `${directory}${path.delimiter}${hostPath}`,
      OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.packagePath,
      OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
      OPENCLAW_TEST_TIMEOUT_ARGS: fixture.timeoutArgsPath,
      OPENCLAW_TEST_NPM_ARGS: fixture.npmArgsPath,
      OPENCLAW_TEST_NPM_BIN: path.join(directory, "npm"),
      OPENCLAW_E2E_REDACTOR_MODULE: fixture.redactorPath,
    },
  };
}

function runPackageInstall(
  fixture: ReturnType<typeof createPackageInstallFixture>,
  env: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  return runBashWithHelper(
    [
      `openclaw_e2e_install_package ${shellQuote(fixture.logPath)} ${shellQuote("fixture package")} ${shellQuote(fixture.prefixPath)}`,
    ],
    { ...fixture.env, ...env },
    undefined,
    "; ",
  );
}

function writeNodeShim(binDir: string): void {
  const nodePath = path.join(binDir, "node");
  fs.writeFileSync(nodePath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`);
  fs.chmodSync(nodePath, 0o755);
}

function writeBashExecutable(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, ["#!/bin/bash", "set -euo pipefail", ...lines, ""].join("\n"));
  fs.chmodSync(filePath, 0o755);
}

function runWatchdog(command: string, timeout = 5_000, input?: string) {
  writeNodeShim(tempDir);
  return runBashWithHelper(
    [`openclaw_e2e_maybe_timeout ${command}`],
    { PATH: tempDir },
    timeout,
    "\n",
    input,
  );
}

function writeFakeTimeout(filePath: string, supportsKillAfter: boolean): void {
  writeBashExecutable(filePath, [
    'if [ "${1:-}" = "--kill-after=1s" ]; then',
    `  exit ${supportsKillAfter ? 0 : 1}`,
    "fi",
    'printf "%s\\n" "$*" >"$OPENCLAW_TEST_TIMEOUT_ARGS"',
    'case "$1" in --kill-after=*) shift ;; esac',
    "shift",
    'exec "$@"',
  ]);
}

function writeTimeoutDispatcher(directory: string, target: string, executableEnv: string): void {
  writeBashExecutable(path.join(directory, "timeout"), [
    'if [ "${1:-}" = "--kill-after=1s" ]; then exit 0; fi',
    'printf "%s\\n" "$*" >"$OPENCLAW_TEST_TIMEOUT_ARGS"',
    `while [ "$#" -gt 0 ] && [ "$1" != ${shellQuote(target)} ]; do shift; done`,
    '[ "$#" -gt 0 ] || exit 127',
    "shift",
    `exec "$${executableEnv}" "$@"`,
  ]);
}

function expectNpmInstallObserved(argsPath: string, expectedArgs: string, prefix: string): void {
  if (fs.existsSync(argsPath)) {
    expect(fs.readFileSync(argsPath, "utf8").trim()).toBe(expectedArgs);
    return;
  }
  expect(
    fs.existsSync(path.join(prefix, "lib/node_modules/openclaw-e2e-fixture/package.json")),
  ).toBe(true);
}

function timedCommandFixture(command: string, timeout: string, output: string[] = []) {
  const root = tempDirs.make("openclaw-e2e-command-");
  const executable = path.join(root, command);
  const timeoutArgs = path.join(root, "timeout-args.txt");
  const commandArgs = path.join(root, "command-args.txt");
  writeTimeoutDispatcher(
    root,
    command === "openclaw" ? executable : command,
    "OPENCLAW_TEST_COMMAND_BIN",
  );
  writeBashExecutable(executable, [
    ...(command === "script" ? ['if [ "${1:-}" = "--version" ]; then exit 0; fi'] : []),
    'printf "%s\\n" "$*" >"$OPENCLAW_TEST_COMMAND_ARGS"',
    ...output,
  ]);
  return {
    root,
    executable,
    run(lines: string[], env: Record<string, string> = {}) {
      return runBashWithHelper(
        lines,
        {
          PATH: `${root}:${hostPath}`,
          OPENCLAW_E2E_COMMAND_TIMEOUT: timeout,
          OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgs,
          OPENCLAW_TEST_COMMAND_ARGS: commandArgs,
          OPENCLAW_TEST_COMMAND_BIN: executable,
          ...env,
        },
        undefined,
        "; ",
      );
    },
    expectArgs(timed: string, direct: string) {
      expect({
        timed: fs.readFileSync(timeoutArgs, "utf8").trim(),
        direct: fs.readFileSync(commandArgs, "utf8").trim(),
      }).toEqual({ timed, direct });
    },
  };
}

it.each([
  ["invalid base64", "@@@", "Invalid OpenClaw test-state base64 payload"],
  ["empty script", Buffer.from("\n").toString("base64"), "decoded to an empty script"],
])("rejects test-state payload: %s", (_name, payload, error) => {
  const result = runSourcedHelper(
    `openclaw_e2e_eval_test_state_from_b64 ${shellQuote(payload)}; printf "value=%s" "\${OPENCLAW_E2E_INSTANCE_TEST:-unset}"`,
    null,
  );
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("value=");
  expect(result.stderr).toContain(error);
});

it.each([
  [undefined, "180\n", 0],
  ["008", "008\n", 0],
  ["30s", "", 2],
] as const)(
  "reads positive integer env %s with fallback, not duration parsing",
  (value, stdout, status) => {
    const result = runSourcedHelper(
      "openclaw_e2e_read_positive_int_env OPENCLAW_E2E_SAMPLE_SECONDS 180",
      { OPENCLAW_E2E_SAMPLE_SECONDS: value },
    );
    expect(result).toMatchObject({ status, stdout });
    if (status !== 0) {
      expect(result.stderr).toContain(`invalid OPENCLAW_E2E_SAMPLE_SECONDS: ${value}`);
    }
  },
);

it("probes default and explicit mock OpenAI base URLs", () => {
  const probePath = path.join(tempDir, "probe-url.txt");
  const result = runSourcedHelper(
    [
      `openclaw_e2e_probe_http() { printf "%s\\n" "$1" >>${shellQuote(probePath)}; return 0; }`,
      "openclaw_e2e_wait_mock_openai 44080 1 400",
      "openclaw_e2e_wait_mock_openai 443 1 400 https://api.openai.com:443",
    ].join("; "),
  );

  expectShellSuccess(result);
  expect(fs.readFileSync(probePath, "utf8").trim().split("\n")).toEqual([
    "http://127.0.0.1:44080/health",
    "https://api.openai.com:443/health",
  ]);
});

it.each(["mock-openai listening on 23456", "mock-openai listening on 65536\n"])(
  "does not accept HTTP readiness without a complete valid listener receipt (%j)",
  (receipt) => {
    const logPath = path.join(tempDir, "mock.log");
    fs.writeFileSync(logPath, receipt);
    const result = runBashWithHelper([
      "openclaw_e2e_process_alive() { return 0; }",
      "openclaw_e2e_probe_http() { echo unexpected-probe; return 0; }",
      "openclaw_e2e_print_log() { :; }",
      "sleep() { :; }",
      `openclaw_e2e_wait_mock_openai 0 1 400 "" 123 ${shellQuote(logPath)}`,
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("unexpected-probe");
    expect(result.stderr).toContain("did not publish a live listener");
  },
);

it("requires /readyz after the gateway ready log", () => {
  const logPath = path.join(tempDir, "gateway.log");
  const result = runGatewayReadyFixture([
    "openclaw_e2e_probe_http() { return 1; }",
    `printf '[gateway] ready ws://127.0.0.1:23456\\n' >${shellQuote(logPath)}`,
    `if openclaw_e2e_wait_gateway_ready "$gateway_pid" ${shellQuote(logPath)} 2; then`,
    '  echo "gateway readiness passed without /readyz" >&2',
    "  exit 1",
    "fi",
  ]);

  expectShellSuccess(result);
  expect(result.stdout).toContain("Gateway log reported ready, but /readyz probe never succeeded");
});

it.each([
  ["explicit", "[gateway] ready\n", "23456"],
  ["ready-log", "[gateway] ready ws://127.0.0.1:23456\nunrelated localhost:9999\n", ""],
])("probes /readyz on the %s port", (_source, log, port) => {
  const logPath = path.join(tempDir, "gateway.log");
  const probePath = path.join(tempDir, "probe-url.txt");
  const result = runGatewayReadyFixture([
    `openclaw_e2e_probe_http() { printf '%s' "$1" >${shellQuote(probePath)}; [[ "$1" = "http://127.0.0.1:23456/readyz" ]]; }`,
    `printf '%s' ${shellQuote(log)} >${shellQuote(logPath)}`,
    `openclaw_e2e_wait_gateway_ready "$gateway_pid" ${shellQuote(logPath)} 2 ${shellQuote(port)}`,
  ]);
  expectShellSuccess(result);
  expect(result.error).toBeUndefined();
  expect(fs.readFileSync(probePath, "utf8")).toBe("http://127.0.0.1:23456/readyz");
});

const readyJson = '{"ready":true}';
const legacyMode = "legacy-ready-log-ok";
it.for([
  ["current listener", "http server listening", true, "strict", 200, readyJson, 0],
  ["March listener", "listening on", true, legacyMode, 503, "{}", 0],
  ["closed legacy listener", "ready", false, legacyMode, 503, "{}", 1],
  ["March marker rejected in strict mode", "listening on", true, "strict", 200, "{}", 1],
  ["modern readiness without marker", "starting", true, "strict", 200, readyJson, 0],
  ["generic response after ready marker", "ready", true, "strict", 200, "{}", 1],
  ["unready JSON despite HTTP success", "starting", true, "strict", 200, '{"ready":false}', 1],
  ["ready JSON despite HTTP failure", "starting", true, "strict", 503, readyJson, 1],
] as const)("readiness: %s", async (row, { signal }) => {
  const [_name, marker, listening, mode, statusCode, body, expectedStatus] = row;
  const logPath = path.join(tempDir, "gateway.log");
  const portPath = path.join(tempDir, "port.txt");
  const resultPath = path.join(tempDir, "readiness-status.txt");
  await withNodeFixture(
    signal,
    `const fs = require('node:fs');
const http = require('node:http');
const [logPath, portPath, marker, listening, statusCode, body] = process.argv.slice(2);
const server = http.createServer((_request, response) => {
  response.writeHead(Number(statusCode));
  response.end(body);
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const publish = () => {
    fs.writeFileSync(logPath, \`[gateway] \${marker} ws://127.0.0.1:\${port} (PID \${process.pid})\\n\`);
    fs.writeFileSync(portPath, String(port));
    process.send('ready');
  };
  if (listening === 'true') publish(); else server.close(publish);
});
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
    [logPath, portPath, marker, String(listening), String(statusCode), body],
    (fixture) => {
      const result = runBashWithHelper(
        [
          "sleep() { :; }",
          `port="$(cat ${shellQuote(portPath)})"`,
          `if openclaw_e2e_wait_gateway_ready "${fixture.child.pid}" ${shellQuote(logPath)} 2 "$port" ${shellQuote(mode)}; then`,
          `  printf '0' >${shellQuote(resultPath)}`,
          "else",
          `  printf '%s' "$?" >${shellQuote(resultPath)}`,
          "fi",
        ],
        {},
        5_000,
      );
      expectShellSuccess(result);
      expect(fs.readFileSync(resultPath, "utf8")).toBe(String(expectedStatus));
    },
  );
});

it.each([
  ["timeout", true],
  ["timeout", false],
  ["gtimeout", true],
] as const)("wraps installs with %s (kill-after=%s)", (timeout, killAfter) => {
  const fixture = createPackageInstallFixture(tempDir, { timeout, killAfter });
  const result = runPackageInstall(fixture);
  expectShellSuccess(result);
  expect(result.stdout).toContain("Installing fixture package...");
  expect(result.stdout).toContain("Installed fixture package.");
  expect(fs.readFileSync(fixture.timeoutArgsPath, "utf8").trim()).toBe(
    `${killAfter ? "--kill-after=30s " : ""}42s npm install -g --prefix ${fixture.prefixPath} ${fixture.packagePath} --no-fund --no-audit`,
  );
  expectNpmInstallObserved(
    fixture.npmArgsPath,
    `install -g --prefix ${fixture.prefixPath} ${fixture.packagePath} --no-fund --no-audit`,
    fixture.prefixPath,
  );
});

it("bounds npm install failure logs to the configured tail", () => {
  const fixture = createPackageInstallFixture(tempDir, {
    npm: [
      'printf "DO_NOT_PRINT_OLD_NPM_LOG\\n"',
      'i=0; while [ "$i" -lt 220 ]; do printf "x"; i=$((i + 1)); done',
      'printf "\\nrecent npm tail\\n"',
      "exit 42",
    ],
  });

  const result = runPackageInstall(fixture, {
    OPENCLAW_E2E_LOG_TAIL_BYTES: "80",
  });

  expect(result.status).toBe(42);
  expect(result.stdout).not.toContain("Installed fixture package.");
  expect(result.stderr).toContain("npm install failed for fixture package");
  expect(result.stderr).toContain("recent npm tail");
  expect(result.stderr).not.toContain("DO_NOT_PRINT_OLD_NPM_LOG");
  expect(fs.readFileSync(fixture.logPath, "utf8")).toContain("DO_NOT_PRINT_OLD_NPM_LOG");
});

it("returns install failures through the caller-owned ERR diagnostics", () => {
  const fixture = createPackageInstallFixture(tempDir, { npm: ["exit 42"] });
  const diagnosticPath = path.join(tempDir, "diagnostic.txt");

  const result = runBashWithHelper(
    [
      `trap 'status=$?; printf "%s" "$status" >${shellQuote(diagnosticPath)}; exit "$status"' ERR`,
      `openclaw_e2e_install_package ${shellQuote(fixture.logPath)} ${shellQuote("fixture package")} ${shellQuote(fixture.prefixPath)}`,
    ],
    fixture.env,
  );

  expect(result.status).toBe(42);
  expect(fs.readFileSync(diagnosticPath, "utf8")).toBe("42");
});

it.each([
  ["bytes", "OPENCLAW_E2E_LOG_TAIL_BYTES", "64kb"],
  ["lines", "OPENCLAW_E2E_LOG_TAIL_LINES", "25 lines"],
])("rejects invalid E2E log tail %s before invoking tail", (_label, envName, value) => {
  const logPath = path.join(tempDir, "install.log");
  fs.writeFileSync(logPath, "old log\nrecent log\n", "utf8");

  const result = runSourcedHelper(`openclaw_e2e_print_log ${shellQuote(logPath)}`, {
    [envName]: value,
  });

  expect(result.status).toBe(2);
  expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
  expect(result.stdout).not.toContain("old log");
});

it("bounds commands with the Node watchdog when timeout is unavailable", () => {
  const startedAt = Date.now();
  const result = runWatchdog(
    `200ms ${shellQuote(process.execPath)} -e ${shellQuote("setInterval(() => {}, 1000)")}`,
  );
  const elapsedMs = Date.now() - startedAt;

  expect(result.status).toBe(124);
  expect(elapsedMs).toBeLessThan(4_000);
  expect(result.stderr).toContain("using Node watchdog");
  expect(result.stderr).toContain("OpenClaw E2E command timed out after 200ms");
});

it("preserves child stdin, arguments, and exit status through the Node watchdog", () => {
  const payload = "harmless watchdog stdin\nsecond line\n";
  const args = ["two words", "--literal", "quote'arg"];
  const child =
    'const fs = require("node:fs"); process.stdout.write(JSON.stringify({ stdin: fs.readFileSync(0, "utf8"), args: process.argv.slice(1) })); process.exit(37);';
  const result = runWatchdog(
    `5s node -e ${shellQuote(child)} -- ${args.map(shellQuote).join(" ")}`,
    10_000,
    payload,
  );

  expect(result.status).toBe(37);
  expect(result.stderr).toContain("using Node watchdog");
  expect(JSON.parse(result.stdout)).toEqual({ stdin: payload, args });
});

it("treats Node-watchdog timeout values as data, not Node options", () => {
  const result = runWatchdog("--version node --version");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unsupported timeout value: --version");
  expect(result.stdout).toBe("");
});

for (const [shellSignal, expectedStatus] of [
  ["TERM", "143"],
  ["HUP", "129"],
] as const) {
  it(`escalates Node watchdog children that ignore parent SIG${shellSignal}`, async ({
    signal,
  }) => {
    writeNodeShim(tempDir);
    const childPath = path.join(tempDir, "ignore-term.mjs");
    const pidPath = path.join(tempDir, "child.pid");
    const watchdogPidPath = path.join(tempDir, "watchdog.pid");
    fs.writeFileSync(
      childPath,
      `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
setInterval(() => {}, 1000);
fs.writeFileSync(process.argv[2], String(process.pid));
fs.writeFileSync(process.argv[3], String(process.ppid));
sendReceipt(process.argv[2], "ready");
`,
    );
    const runner = startBash(
      `
set -euo pipefail
source ${shellQuote(helperPath)}
export OPENCLAW_E2E_TIMEOUT_KILL_GRACE_MS=100
openclaw_e2e_maybe_timeout 30s node ${shellQuote(childPath)} ${shellQuote(pidPath)} ${shellQuote(watchdogPidPath)}
`,
      { PATH: tempDir },
    );
    try {
      await withinTest(fixtureReadyBeforeSettlement(pidPath, runner.closed), signal);
      const childPid = Number(fs.readFileSync(pidPath, "utf8"));
      process.kill(Number(fs.readFileSync(watchdogPidPath, "utf8")), `SIG${shellSignal}`);
      const result = await withinTest(runner.closed, signal);
      expect(result.status, result.stderr).toBe(Number(expectedStatus));
      await waitForProcessGone(childPid, signal, "child still alive after watchdog termination");
    } finally {
      killFixturePids(pidPath, watchdogPidPath);
      await closeBashFixture(runner);
    }
  });
}

it("terminates only the tracked gateway process", () => {
  const forbiddenToolLog = path.join(tempDir, "process-tools.log");
  fs.writeFileSync(forbiddenToolLog, "");
  for (const tool of ["pkill", "pgrep"]) {
    writeBashExecutable(path.join(tempDir, tool), [
      `printf "${tool} %s\\n" "$*" >>"$OPENCLAW_TEST_FORBIDDEN_PROCESS_TOOL_LOG"`,
      "exit 42",
    ]);
  }

  const script = `
set -euo pipefail
source ${shellQuote(helperPath)}
openclaw_e2e_terminate_gateways ""
/bin/sleep 30 &
tracked_pid="$!"
openclaw_e2e_terminate_gateways "$tracked_pid"
if kill -0 "$tracked_pid" 2>/dev/null; then
  echo "tracked gateway process still alive" >&2
  exit 1
fi
[ ! -s "$OPENCLAW_TEST_FORBIDDEN_PROCESS_TOOL_LOG" ]
`;

  const result = runBash(
    script,
    {
      PATH: `${tempDir}:${hostPath}`,
      OPENCLAW_TEST_FORBIDDEN_PROCESS_TOOL_LOG: forbiddenToolLog,
    },
    5_000,
  );

  expectShellSuccess(result);
});

it("terminates descendants in the tracked process group", async ({ signal }) => {
  const parentPidPath = path.join(tempDir, "parent.pid");
  const childPidPath = path.join(tempDir, "child.pid");
  const childTermPath = path.join(tempDir, "child.term");
  const parentPath = path.join(tempDir, "parent.mjs");
  const childPath = path.join(tempDir, "child.mjs");
  const logPath = path.join(tempDir, "tracked.log");
  fs.writeFileSync(
    childPath,
    `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
process.on("SIGTERM", () => {
  fs.writeFileSync(process.argv[3], "terminated");
  sendReceipt(process.argv[3], "terminated");
  process.exit(0);
});
setInterval(() => {}, 1000);
fs.writeFileSync(process.argv[2], String(process.pid));
process.send("ready");
`,
  );
  fs.writeFileSync(
    parentPath,
    `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
import { spawn } from "node:child_process";
process.on("SIGTERM", () => process.exit(0));
const child = spawn(process.execPath, [process.argv[2], process.argv[4], process.argv[5]], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
child.once("message", () => {
  fs.writeFileSync(process.argv[3], String(process.pid));
  sendReceipt(process.argv[3], "ready");
});
setInterval(() => {}, 1000);
`,
  );
  const starter = startBash(
    `source ${shellQuote(helperPath)}
openclaw_e2e_start_tracked_process ${shellQuote(logPath)} ${shellQuote(process.execPath)} ${shellQuote(parentPath)} ${shellQuote(childPath)} ${shellQuote(parentPidPath)} ${shellQuote(childPidPath)} ${shellQuote(childTermPath)}`,
    { PATH: hostPath },
  );
  let stopper: ReturnType<typeof startBash> | undefined;
  let trackedPid = 0;
  try {
    const started = await withinTest(starter.closed, signal);
    expect(started.status, started.stderr).toBe(0);
    trackedPid = Number(started.stdout.trim());
    // The start helper promises spawn only; its detached child reports actual readiness.
    await withinTest(receipts.waitFor(parentPidPath, "ready"), signal);
    const childPid = Number(fs.readFileSync(childPidPath, "utf8"));
    stopper = startBash(
      `source ${shellQuote(helperPath)}
openclaw_e2e_stop_process ${trackedPid}`,
      { PATH: hostPath },
    );
    await withinTest(
      Promise.race([
        receipts.waitFor(childTermPath, "terminated"),
        stopper.closed.then(() => {
          expect(fs.existsSync(childTermPath), "tracked child did not receive SIGTERM").toBe(true);
        }),
      ]),
      signal,
    );
    const stopped = await withinTest(stopper.closed, signal);
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(
      fs.statSync(childTermPath).size,
      "tracked child did not receive SIGTERM",
    ).toBeGreaterThan(0);
    await waitForProcessGone(childPid, signal, "tracked child still alive after group termination");
  } finally {
    killFixturePids(childPidPath, parentPidPath);
    killFixturePid(-trackedPid);
    killFixturePid(trackedPid);
    for (const command of [starter, stopper]) {
      if (command) {
        await closeBashFixture(command);
      }
    }
  }
});

it("bounds HTTP readiness probes when a server accepts connections but never responds", async ({
  signal,
}) => {
  const portPath = path.join(tempDir, "port.txt");
  await withNodeFixture(
    signal,
    `const fs = require('node:fs');
const net = require('node:net');
const server = net.createServer((socket) => socket.on('data', () => {}));
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.argv[2], String(server.address().port));
  process.send('ready');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
    [portPath],
    (_fixture, startedAt) => {
      const result = runBashWithHelper(
        [
          `port="$(cat ${shellQuote(portPath)})"`,
          'openclaw_e2e_probe_http_status "http://127.0.0.1:${port}/health" 200 100',
        ],
        undefined,
        3_000,
        "; ",
      );
      const elapsedMs = Date.now() - startedAt;
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(elapsedMs).toBeLessThan(2_500);
    },
  );
});

it("cancels HTTP readiness probe response bodies", () => {
  const helper = fs.readFileSync(helperPath, "utf8");

  expect(helper).toContain("await response?.body?.cancel?.().catch(() => undefined);");
});

it("does not repeatedly grep the full gateway log while waiting for readiness", () => {
  const logPath = path.join(tempDir, "gateway.log");
  const grepArgsPath = path.join(tempDir, "grep-args.txt");
  const result = runGatewayReadyFixture([
    "openclaw_e2e_probe_http() { return 0; }",
    "grep() {",
    `  printf '%s\\n' "$*" >>${shellQuote(grepArgsPath)}`,
    '  for arg in "$@"; do',
    `    if [ "$arg" = ${shellQuote(logPath)} ]; then return 77; fi`,
    "  done",
    '  command grep "$@"',
    "}",
    `printf 'old log line\\n' >${shellQuote(logPath)}`,
    `printf '[gateway] ready ws://127.0.0.1:23456\\n' >>${shellQuote(logPath)}`,
    `openclaw_e2e_wait_gateway_ready "$gateway_pid" ${shellQuote(logPath)} 2`,
  ]);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(fs.readFileSync(grepArgsPath, "utf8")).not.toContain(logPath);
});

it("detects gateway ready markers split across incremental log reads", () => {
  const logPath = path.join(tempDir, "gateway.log");
  const result = runGatewayReadyFixture([
    "openclaw_e2e_probe_http() { return 0; }",
    `printf '[gateway] rea' >${shellQuote(logPath)}`,
    `(sleep 0.35; printf 'dy ws://127.0.0.1:23456\\n' >>${shellQuote(logPath)}) &`,
    `openclaw_e2e_wait_gateway_ready "$gateway_pid" ${shellQuote(logPath)} 8`,
  ]);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
});

it("wraps logged OpenClaw E2E commands with the configured timeout", () => {
  const fixture = timedCommandFixture("fixture-command", "17s", ['printf "fixture output\\n"']);
  const logLabel = path.basename(fixture.root);
  const logDir = path.join(fixture.root, "logs");
  const logPathFile = path.join(fixture.root, "log-path.txt");
  const result = fixture.run(
    [
      `openclaw_e2e_run_logged ${shellQuote(logLabel)} fixture-command one two`,
      `printf "%s" "$OPENCLAW_E2E_LAST_LOG_PATH" > ${shellQuote(logPathFile)}`,
    ],
    { OPENCLAW_E2E_LOG_DIR: logDir },
  );

  expect(result.status).toBe(0);
  fixture.expectArgs("--kill-after=30s 17s fixture-command one two", "one two");
  const logPath = fs.readFileSync(logPathFile, "utf8");
  expect(logPath.startsWith(`${logDir}${path.sep}`)).toBe(true);
  expect(path.basename(logPath)).toMatch(new RegExp(`^openclaw-${logLabel}\\..+\\.log$`, "u"));
  expect(fs.readFileSync(logPath, "utf8")).toContain("fixture output");
});

it("redacts logged command failures before replay with initialized stdin", () => {
  const fixture = timedCommandFixture("fixture-command", "300s", [
    'for ((i = 0; i < 120; i += 1)); do printf "%02000d\\n" 0; done',
    'printf "actionable failure fixture-secret\\n"',
    "exit 23",
  ]);
  const redactorPath = path.join(fixture.root, "redactor.mjs");
  fs.writeFileSync(
    redactorPath,
    'void process.stdin;\nexport const redactSensitiveText = (value) => value.replaceAll("fixture-secret", "***");\n',
    "utf8",
  );
  const result = fixture.run(["openclaw_e2e_run_logged redacted-failure fixture-command"], {
    OPENCLAW_E2E_LOG_DIR: path.join(fixture.root, "logs"),
    OPENCLAW_E2E_REDACTOR_MODULE: redactorPath,
  });

  expect(result.status).toBe(1);
  expect(result.stdout).toContain("actionable failure ***");
  expect(result.stdout).not.toContain("fixture-secret");
});

it("installs the trash shim under isolated test state", () => {
  const homeDir = path.join(tempDir, "home");
  const stateDir = path.join(tempDir, "state");
  const pathFile = path.join(tempDir, "path.txt");
  const binDirFile = path.join(tempDir, "bin-dir.txt");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const result = runBashWithHelper(
    [
      "openclaw_e2e_install_trash_shim",
      "openclaw_e2e_install_trash_shim",
      `printf "%s" "$PATH" > ${shellQuote(pathFile)}`,
      `printf "%s" "$OPENCLAW_E2E_BIN_DIR" > ${shellQuote(binDirFile)}`,
      "command -v trash >/dev/null",
    ],
    { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, PATH: hostPath },
    undefined,
    "; ",
  );

  expectShellSuccess(result);
  const binDir = fs.readFileSync(binDirFile, "utf8");
  const pathEntries = fs.readFileSync(pathFile, "utf8").split(path.delimiter);
  expect(binDir).toBe(path.join(stateDir, "e2e-bin"));
  expect(binDir).not.toBe("/tmp/openclaw-bin");
  expect(pathEntries.filter((entry) => entry === binDir)).toHaveLength(1);
  expect(fs.existsSync(path.join(binDir, "trash"))).toBe(true);
});

it("wraps package-installed OpenClaw CLI calls with the configured timeout", () => {
  const fixture = timedCommandFixture("openclaw", "23s");
  const result = fixture.run([
    "openclaw_e2e_enable_openclaw_cli_timeout",
    "openclaw_e2e_enable_openclaw_cli_timeout",
    "openclaw plugins list --json",
  ]);

  expect(result.status).toBe(0);
  fixture.expectArgs(
    `--kill-after=30s 23s ${fixture.executable} plugins list --json`,
    "plugins list --json",
  );
});

it("wraps interactive PTY scripts with the configured timeout", () => {
  const fixture = timedCommandFixture("script", "31s");
  const logPath = path.join(fixture.root, "pty.log");
  const result = fixture.run([
    `openclaw_e2e_run_script_with_pty ${shellQuote("node /tmp/entry onboard")} ${shellQuote(logPath)}`,
  ]);

  expect(result.status).toBe(0);
  fixture.expectArgs(
    `--kill-after=30s 31s script -q -f -c node /tmp/entry onboard ${logPath}`,
    `-q -f -c node /tmp/entry onboard ${logPath}`,
  );
});
