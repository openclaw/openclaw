import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

function startNodeFixture(script: string, args: string[]) {
  const fixture = observeChild(
    spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  );
  const ready = new Promise<void>((resolve) => {
    fixture.child.once("message", () => resolve());
  });
  return {
    ...fixture,
    ready: awaitGateBeforeSettlement(
      ready,
      fixture.closed,
      "fixture exited before publishing readiness",
    ),
  };
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
  if (pid > 1) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
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

function runHelper(payload: string) {
  return runSourcedHelper(
    [
      `openclaw_e2e_eval_test_state_from_b64 ${shellQuote(payload)}`,
      'printf "value=%s" "${OPENCLAW_E2E_INSTANCE_TEST:-unset}"',
    ].join("; "),
    null,
  );
}

function base64(script: string): string {
  return execFileSync("base64", { input: script, encoding: "utf8" }).replace(/\s+/gu, "");
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

function withTempDir<T>(prefix: string, run: (tempDir: string) => T): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(tempDir);
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function runBash(
  script: string | string[],
  env?: Record<string, string | undefined>,
  timeout?: number,
  separator = "\n",
): ReturnType<typeof spawnSync> {
  return spawnSync("/bin/bash", ["-c", Array.isArray(script) ? script.join(separator) : script], {
    encoding: "utf8",
    env: env === undefined ? undefined : shellTestEnv(env),
    timeout,
  });
}

function runBashWithHelper(
  lines: string[],
  env?: Record<string, string | undefined>,
  timeout?: number,
  separator = "\n",
): ReturnType<typeof spawnSync> {
  return runBash(
    ["set -euo pipefail", `source ${shellQuote(helperPath)}`, ...lines],
    env,
    timeout,
    separator,
  );
}

function runSourcedHelper(
  script: string,
  overrides: Record<string, string | undefined> | null = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(
    "bash",
    ["-lc", ["set -euo pipefail", `source ${shellQuote(helperPath)}`, script].join("; ")],
    { encoding: "utf8", env: overrides === null ? undefined : shellTestEnv(overrides) },
  );
}

function expectShellSuccess(result: ReturnType<typeof spawnSync>) {
  expect(result.status, String(result.stderr || result.stdout || result.error?.message || "")).toBe(
    0,
  );
}

function writePackageFixture(packagePath: string): void {
  withTempDir("openclaw-e2e-package-", (root) => {
    const packageDir = path.join(root, "package");
    fs.mkdirSync(packageDir);
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "openclaw-e2e-fixture", version: "0.0.0" }),
    );
    execFileSync("tar", ["-czf", packagePath, "-C", root, "package"]);
  });
}

function createPackageInstallFixture(tempDir: string) {
  const fixture = {
    logPath: path.join(tempDir, "install.log"),
    npmArgsPath: path.join(tempDir, "npm-args.txt"),
    packagePath: path.join(tempDir, "openclaw.tgz"),
    prefixPath: path.join(tempDir, "prefix"),
    redactorPath: path.join(tempDir, "redactor.mjs"),
    timeoutArgsPath: path.join(tempDir, "timeout-args.txt"),
  };
  writePackageFixture(fixture.packagePath);
  fs.writeFileSync(
    fixture.redactorPath,
    "export const redactSensitiveText = (value) => value;\n",
    "utf8",
  );
  return fixture;
}

function runPackageInstall(
  fixture: ReturnType<typeof createPackageInstallFixture>,
  env: Record<string, string | undefined>,
): ReturnType<typeof spawnSync> {
  return runBashWithHelper(
    [
      `openclaw_e2e_install_package ${shellQuote(fixture.logPath)} ${shellQuote("fixture package")} ${shellQuote(fixture.prefixPath)}`,
    ],
    { ...env, OPENCLAW_E2E_REDACTOR_MODULE: fixture.redactorPath },
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

function writeFakeTimeout(filePath: string, supportsKillAfter: boolean): void {
  writeBashExecutable(filePath, [
    'if [ "${1:-}" = "--kill-after=1s" ]; then',
    `  exit ${supportsKillAfter ? 0 : 1}`,
    "fi",
    'printf "%s\\n" "$*" >"$OPENCLAW_TEST_TIMEOUT_ARGS"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    "    --)",
    "      shift",
    "      break",
    "      ;;",
    "    -k|--kill-after)",
    "      shift 2",
    "      ;;",
    "    --kill-after=*|-*)",
    "      shift",
    "      ;;",
    "    *)",
    "      shift",
    "      break",
    "      ;;",
    "  esac",
    "done",
    'exec "$@"',
  ]);
}

function writeFakeNpm(filePath: string): void {
  writeBashExecutable(filePath, ['printf "%s\\n" "$*" >"$OPENCLAW_TEST_NPM_ARGS"']);
}

function writeTimeoutDispatcher(tempDir: string, target: string, executableEnv: string): void {
  writeBashExecutable(path.join(tempDir, "timeout"), [
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

describe("scripts/lib/openclaw-e2e-instance.sh", () => {
  it("fails when the test-state payload is not valid base64", () => {
    const result = runHelper("@@@");

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("value=");
    expect(result.stderr).toContain("Invalid OpenClaw test-state base64 payload");
  });

  it("fails when the test-state payload decodes to an empty script", () => {
    const result = runHelper(base64("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("value=");
    expect(result.stderr).toContain("decoded to an empty script");
  });

  it("reads positive integer env values without treating decimal input as durations", () => {
    const fallback = runSourcedHelper(
      'printf "%s" "$(openclaw_e2e_read_positive_int_env OPENCLAW_E2E_SAMPLE_SECONDS 180)"',
    );
    const leadingZero = runSourcedHelper(
      'printf "%s" "$(openclaw_e2e_read_positive_int_env OPENCLAW_E2E_SAMPLE_SECONDS 180)"',
      { OPENCLAW_E2E_SAMPLE_SECONDS: "008" },
    );
    const duration = runSourcedHelper(
      "openclaw_e2e_read_positive_int_env OPENCLAW_E2E_SAMPLE_SECONDS 180",
      { OPENCLAW_E2E_SAMPLE_SECONDS: "30s" },
    );

    expectShellSuccess(fallback);
    expect(fallback.stdout).toBe("180");
    expectShellSuccess(leadingZero);
    expect(leadingZero.stdout).toBe("008");
    expect(duration.status).toBe(2);
    expect(duration.stderr).toContain("invalid OPENCLAW_E2E_SAMPLE_SECONDS: 30s");
  });

  it("probes default and explicit mock OpenAI base URLs", () => {
    withTempDir("openclaw-e2e-mock-openai-url-", (tempDir) => {
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
  });

  it.each(["mock-openai listening on 23456", "mock-openai listening on 65536\n"])(
    "does not accept HTTP readiness without a complete valid listener receipt (%j)",
    (receipt) => {
      withTempDir("openclaw-e2e-mock-receipt-", (tempDir) => {
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
      });
    },
  );

  it("requires /readyz after the gateway ready log", () => {
    withTempDir("openclaw-e2e-readyz-required-", (tempDir) => {
      const logPath = path.join(tempDir, "gateway.log");
      const result = runBashWithHelper(
        [
          "openclaw_e2e_probe_http() { return 1; }",
          "sleep 30 &",
          'gateway_pid="$!"',
          "trap 'kill \"$gateway_pid\" >/dev/null 2>&1 || true' EXIT",
          `printf '[gateway] ready ws://127.0.0.1:23456\\n' >${shellQuote(logPath)}`,
          `if openclaw_e2e_wait_gateway_ready "$gateway_pid" ${shellQuote(logPath)} 2; then`,
          '  echo "gateway readiness passed without /readyz" >&2',
          "  exit 1",
          "fi",
        ],
        {},
        5_000,
      );

      expectShellSuccess(result);
      expect(result.stdout).toContain(
        "Gateway log reported ready, but /readyz probe never succeeded",
      );
    });
  });

  it("probes /readyz on the explicit gateway port", () => {
    withTempDir("openclaw-e2e-readyz-port-", (tempDir) => {
      const logPath = path.join(tempDir, "gateway.log");
      const probePath = path.join(tempDir, "probe-url.txt");
      const result = runBashWithHelper(
        [
          `openclaw_e2e_probe_http() { printf "%s\\n" "$1" >${shellQuote(probePath)}; return 0; }`,
          "sleep 30 &",
          'gateway_pid="$!"',
          "trap 'kill \"$gateway_pid\" >/dev/null 2>&1 || true' EXIT",
          `printf '[gateway] ready\\n' >${shellQuote(logPath)}`,
          `openclaw_e2e_wait_gateway_ready "$gateway_pid" ${shellQuote(logPath)} 2 23456`,
        ],
        {},
        5_000,
      );

      expectShellSuccess(result);
      expect(fs.readFileSync(probePath, "utf8").trim()).toBe("http://127.0.0.1:23456/readyz");
    });
  });

  it.for([
    ["accepts the March listening marker", "listening on", true, "legacy-ready-log-ok", 0],
    ["rejects a closed legacy ready listener", "ready", false, "legacy-ready-log-ok", 1],
    ["rejects the March marker in strict mode", "listening on", true, "strict", 1],
  ] as const)("%s", async ([_label, marker, listening, mode, expectedStatus], { signal }) => {
    const tempDir = tempDirs.make("openclaw-e2e-readyz-legacy-");
    const logPath = path.join(tempDir, "gateway.log");
    const portPath = path.join(tempDir, "port.txt");
    const resultPath = path.join(tempDir, "readiness-status.txt");
    const serverPath = path.join(tempDir, "gateway.cjs");
    fs.writeFileSync(
      serverPath,
      [
        "const fs = require('node:fs');",
        "const http = require('node:http');",
        "const [logPath, portPath, marker, listening, mode] = process.argv.slice(2);",
        "const server = http.createServer((_request, response) => {",
        // A working endpoint must not let strict mode accept the historical marker.
        "  response.writeHead(mode === 'strict' ? 200 : 503);",
        "  response.end('{}');",
        "});",
        "server.listen(0, '127.0.0.1', () => {",
        "  const port = server.address().port;",
        "  const publish = () => {",
        "    fs.writeFileSync(logPath, `[gateway] ${marker} ws://127.0.0.1:${port} (PID ${process.pid})\\n`);",
        "    fs.writeFileSync(portPath, String(port));",
        "    process.send('ready');",
        "  };",
        "  if (listening === 'true') publish(); else server.close(publish);",
        "});",
        "setInterval(() => {}, 1000);",
        "process.on('SIGTERM', () => process.exit(0));",
        "",
      ].join("\n"),
    );
    const fixture = startNodeFixture(serverPath, [
      logPath,
      portPath,
      marker,
      String(listening),
      mode,
    ]);
    try {
      await withinTest(fixture.ready, signal);
      const result = runBashWithHelper(
        [
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
    } finally {
      fixture.child.kill("SIGKILL");
      await fixture.closed;
    }
  });

  it("wraps package installs with the configured timeout", () => {
    withTempDir("openclaw-e2e-instance-", (tempDir) => {
      const fixture = createPackageInstallFixture(tempDir);
      writeFakeTimeout(path.join(tempDir, "timeout"), true);
      writeFakeNpm(path.join(tempDir, "npm"));

      const result = runPackageInstall(fixture, {
        PATH: `${tempDir}${path.delimiter}${hostPath}`,
        OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.packagePath,
        OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
        OPENCLAW_TEST_TIMEOUT_ARGS: fixture.timeoutArgsPath,
        OPENCLAW_TEST_NPM_ARGS: fixture.npmArgsPath,
        OPENCLAW_TEST_NPM_BIN: path.join(tempDir, "npm"),
      });

      expectShellSuccess(result);
      expect(result.stdout).toContain("Installing fixture package...");
      expect(result.stdout).toContain("Installed fixture package.");
      expect(fs.readFileSync(fixture.timeoutArgsPath, "utf8").trim()).toBe(
        `--kill-after=30s 42s npm install -g --prefix ${fixture.prefixPath} ${fixture.packagePath} --no-fund --no-audit`,
      );
      expectNpmInstallObserved(
        fixture.npmArgsPath,
        `install -g --prefix ${fixture.prefixPath} ${fixture.packagePath} --no-fund --no-audit`,
        fixture.prefixPath,
      );
    });
  });

  it("falls back to plain timeout when kill-after is unavailable", () => {
    withTempDir("openclaw-e2e-instance-plain-timeout-", (tempDir) => {
      const fixture = createPackageInstallFixture(tempDir);
      writeFakeTimeout(path.join(tempDir, "timeout"), false);
      writeFakeNpm(path.join(tempDir, "npm"));

      const result = runPackageInstall(fixture, {
        PATH: `${tempDir}${path.delimiter}${hostPath}`,
        OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.packagePath,
        OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
        OPENCLAW_TEST_TIMEOUT_ARGS: fixture.timeoutArgsPath,
        OPENCLAW_TEST_NPM_ARGS: fixture.npmArgsPath,
        OPENCLAW_TEST_NPM_BIN: path.join(tempDir, "npm"),
      });

      expectShellSuccess(result);
      expect(fs.readFileSync(fixture.timeoutArgsPath, "utf8").trim()).toBe(
        `42s npm install -g --prefix ${fixture.prefixPath} ${fixture.packagePath} --no-fund --no-audit`,
      );
      expectNpmInstallObserved(
        fixture.npmArgsPath,
        `install -g --prefix ${fixture.prefixPath} ${fixture.packagePath} --no-fund --no-audit`,
        fixture.prefixPath,
      );
    });
  });

  it("uses gtimeout when GNU timeout is not on PATH", () => {
    withTempDir("openclaw-e2e-instance-gtimeout-", (tempDir) => {
      const fixture = createPackageInstallFixture(tempDir);
      writeFakeTimeout(path.join(tempDir, "gtimeout"), true);
      writeFakeNpm(path.join(tempDir, "npm"));

      const result = runPackageInstall(fixture, {
        PATH: tempDir,
        OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.packagePath,
        OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
        OPENCLAW_TEST_TIMEOUT_ARGS: fixture.timeoutArgsPath,
        OPENCLAW_TEST_NPM_ARGS: fixture.npmArgsPath,
        OPENCLAW_TEST_NPM_BIN: path.join(tempDir, "npm"),
      });

      expectShellSuccess(result);
      expect(fs.readFileSync(fixture.timeoutArgsPath, "utf8").trim()).toBe(
        `--kill-after=30s 42s npm install -g --prefix ${fixture.prefixPath} ${fixture.packagePath} --no-fund --no-audit`,
      );
      expectNpmInstallObserved(
        fixture.npmArgsPath,
        `install -g --prefix ${fixture.prefixPath} ${fixture.packagePath} --no-fund --no-audit`,
        fixture.prefixPath,
      );
    });
  });

  it("bounds npm install failure logs to the configured tail", () => {
    withTempDir("openclaw-e2e-instance-install-log-", (tempDir) => {
      const fixture = createPackageInstallFixture(tempDir);
      writeFakeTimeout(path.join(tempDir, "timeout"), true);
      writeBashExecutable(path.join(tempDir, "npm"), [
        'printf "DO_NOT_PRINT_OLD_NPM_LOG\\n"',
        'i=0; while [ "$i" -lt 220 ]; do printf "x"; i=$((i + 1)); done',
        'printf "\\nrecent npm tail\\n"',
        "exit 42",
      ]);

      const result = runPackageInstall(fixture, {
        PATH: `${tempDir}${path.delimiter}${hostPath}`,
        OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.packagePath,
        OPENCLAW_E2E_LOG_TAIL_BYTES: "80",
        OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
        OPENCLAW_TEST_TIMEOUT_ARGS: fixture.timeoutArgsPath,
      });

      expect(result.status).toBe(42);
      expect(result.stdout).not.toContain("Installed fixture package.");
      expect(result.stderr).toContain("npm install failed for fixture package");
      expect(result.stderr).toContain("recent npm tail");
      expect(result.stderr).not.toContain("DO_NOT_PRINT_OLD_NPM_LOG");
      expect(fs.readFileSync(fixture.logPath, "utf8")).toContain("DO_NOT_PRINT_OLD_NPM_LOG");
    });
  });

  it("returns install failures through the caller-owned ERR diagnostics", () => {
    withTempDir("openclaw-e2e-instance-install-trap-", (tempDir) => {
      const fixture = createPackageInstallFixture(tempDir);
      const diagnosticPath = path.join(tempDir, "diagnostic.txt");
      writeFakeTimeout(path.join(tempDir, "timeout"), true);
      writeBashExecutable(path.join(tempDir, "npm"), ["exit 42"]);

      const result = runBashWithHelper(
        [
          `trap 'status=$?; printf "%s" "$status" >${shellQuote(diagnosticPath)}; exit "$status"' ERR`,
          `openclaw_e2e_install_package ${shellQuote(fixture.logPath)} ${shellQuote("fixture package")} ${shellQuote(fixture.prefixPath)}`,
        ],
        {
          PATH: `${tempDir}${path.delimiter}${hostPath}`,
          OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.packagePath,
          OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
          OPENCLAW_TEST_TIMEOUT_ARGS: fixture.timeoutArgsPath,
        },
      );

      expect(result.status).toBe(42);
      expect(fs.readFileSync(diagnosticPath, "utf8")).toBe("42");
    });
  });

  it.each([
    ["bytes", "OPENCLAW_E2E_LOG_TAIL_BYTES", "64kb"],
    ["lines", "OPENCLAW_E2E_LOG_TAIL_LINES", "25 lines"],
  ])("rejects invalid E2E log tail %s before invoking tail", (_label, envName, value) => {
    withTempDir("openclaw-e2e-instance-log-tail-", (tempDir) => {
      const logPath = path.join(tempDir, "install.log");
      fs.writeFileSync(logPath, "old log\nrecent log\n", "utf8");

      const result = runSourcedHelper(`openclaw_e2e_print_log ${shellQuote(logPath)}`, {
        [envName]: value,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
      expect(result.stdout).not.toContain("old log");
    });
  });

  it("bounds commands with the Node watchdog when timeout is unavailable", () => {
    withTempDir("openclaw-e2e-instance-node-watchdog-", (tempDir) => {
      writeNodeShim(tempDir);
      const startedAt = Date.now();
      const result = runBashWithHelper(
        [
          `openclaw_e2e_maybe_timeout 200ms ${shellQuote(process.execPath)} -e ${shellQuote("setInterval(() => {}, 1000)")}`,
        ],
        { PATH: tempDir },
        5_000,
        "; ",
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe(124);
      expect(elapsedMs).toBeLessThan(4_000);
      expect(result.stderr).toContain("using Node watchdog");
      expect(result.stderr).toContain("OpenClaw E2E command timed out after 200ms");
    });
  });

  it("preserves child stdin, arguments, and exit status through the Node watchdog", () => {
    withTempDir("openclaw-e2e-instance-node-watchdog-stdin-", (tempDir) => {
      writeNodeShim(tempDir);
      const payload = "harmless watchdog stdin\nsecond line\n";
      const args = ["two words", "--literal", "quote'arg"];
      const child =
        'const fs = require("node:fs"); process.stdout.write(JSON.stringify({ stdin: fs.readFileSync(0, "utf8"), args: process.argv.slice(1) })); process.exit(37);';
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_maybe_timeout 5s node -e ${shellQuote(child)} -- ${args.map(shellQuote).join(" ")}`,
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: shellTestEnv({ PATH: tempDir }),
          input: payload,
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(37);
      expect(result.stderr).toContain("using Node watchdog");
      expect(JSON.parse(result.stdout)).toEqual({ stdin: payload, args });
    });
  });

  it("treats Node-watchdog timeout values as data, not Node options", () => {
    withTempDir("openclaw-e2e-instance-node-watchdog-option-", (tempDir) => {
      writeNodeShim(tempDir);
      const result = runBashWithHelper(
        ["openclaw_e2e_maybe_timeout --version node --version"],
        { PATH: tempDir },
        5_000,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unsupported timeout value: --version");
      expect(result.stdout).toBe("");
    });
  });

  for (const [shellSignal, expectedStatus] of [
    ["TERM", "143"],
    ["HUP", "129"],
  ] as const) {
    it(`escalates Node watchdog children that ignore parent SIG${shellSignal}`, async ({
      signal,
    }) => {
      const tempDir = tempDirs.make("openclaw-e2e-instance-node-watchdog-signal-");
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
        for (const marker of [pidPath, watchdogPidPath]) {
          if (fs.existsSync(marker)) {
            killFixturePid(Number(fs.readFileSync(marker, "utf8")));
          }
        }
        if (
          runner.child.exitCode === null &&
          runner.child.signalCode === null &&
          runner.child.pid
        ) {
          try {
            process.kill(-runner.child.pid, "SIGKILL");
          } catch {}
        }
        await runner.closed;
      }
    });
  }

  it("terminates only the tracked gateway process", () => {
    withTempDir("openclaw-e2e-gateway-terminate-", (tempDir) => {
      const forbiddenToolLog = path.join(tempDir, "process-tools.log");
      fs.writeFileSync(forbiddenToolLog, "");
      writeBashExecutable(path.join(tempDir, "pkill"), [
        'printf "pkill %s\\n" "$*" >>"$OPENCLAW_TEST_FORBIDDEN_PROCESS_TOOL_LOG"',
        "exit 42",
      ]);
      writeBashExecutable(path.join(tempDir, "pgrep"), [
        'printf "pgrep %s\\n" "$*" >>"$OPENCLAW_TEST_FORBIDDEN_PROCESS_TOOL_LOG"',
        "exit 42",
      ]);

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
  });

  it("terminates descendants in the tracked process group", async ({ signal }) => {
    const tempDir = tempDirs.make("openclaw-e2e-process-group-");
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
            expect(fs.existsSync(childTermPath), "tracked child did not receive SIGTERM").toBe(
              true,
            );
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
      await waitForProcessGone(
        childPid,
        signal,
        "tracked child still alive after group termination",
      );
    } finally {
      for (const pidPath of [childPidPath, parentPidPath]) {
        if (fs.existsSync(pidPath)) {
          killFixturePid(Number(fs.readFileSync(pidPath, "utf8")));
        }
      }
      if (trackedPid > 1) {
        try {
          process.kill(-trackedPid, "SIGKILL");
        } catch {}
      }
      killFixturePid(trackedPid);
      for (const command of [starter, stopper]) {
        if (!command) {
          continue;
        }
        if (
          command.child.exitCode === null &&
          command.child.signalCode === null &&
          command.child.pid
        ) {
          try {
            process.kill(-command.child.pid, "SIGKILL");
          } catch {}
        }
        await command.closed;
      }
    }
  });

  it("bounds HTTP readiness probes when a server accepts connections but never responds", async ({
    signal,
  }) => {
    const tempDir = tempDirs.make("openclaw-e2e-http-probe-");
    const portPath = path.join(tempDir, "port.txt");
    const serverPath = path.join(tempDir, "stalling-server.cjs");
    fs.writeFileSync(
      serverPath,
      [
        "const fs = require('node:fs');",
        "const net = require('node:net');",
        "const server = net.createServer((socket) => socket.on('data', () => {}));",
        "server.listen(0, '127.0.0.1', () => {",
        "  fs.writeFileSync(process.argv[2], String(server.address().port));",
        "  process.send('ready');",
        "});",
        "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
        "",
      ].join("\n"),
    );

    const startedAt = Date.now();
    const fixture = startNodeFixture(serverPath, [portPath]);
    try {
      await withinTest(fixture.ready, signal);
      const result = runBash(
        [
          "set -euo pipefail",
          `port="$(cat ${shellQuote(portPath)})"`,
          `source ${shellQuote(helperPath)}`,
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
    } finally {
      fixture.child.kill("SIGKILL");
      await fixture.closed;
    }
  });

  it("cancels HTTP readiness probe response bodies", () => {
    const helper = fs.readFileSync(helperPath, "utf8");

    expect(helper).toContain("await response?.body?.cancel?.().catch(() => undefined);");
  });

  it("does not repeatedly grep the full gateway log while waiting for readiness", () => {
    withTempDir("openclaw-e2e-readyz-incremental-", (tempDir) => {
      const logPath = path.join(tempDir, "gateway.log");
      const grepArgsPath = path.join(tempDir, "grep-args.txt");
      const result = runBashWithHelper(
        [
          "openclaw_e2e_probe_http() { return 0; }",
          "grep() {",
          `  printf '%s\\n' "$*" >>${shellQuote(grepArgsPath)}`,
          '  for arg in "$@"; do',
          `    if [ "$arg" = ${shellQuote(logPath)} ]; then return 77; fi`,
          "  done",
          '  command grep "$@"',
          "}",
          "sleep 30 &",
          'gateway_pid="$!"',
          "trap 'kill \"$gateway_pid\" >/dev/null 2>&1 || true' EXIT",
          `printf 'old log line\\n' >${shellQuote(logPath)}`,
          `printf '[gateway] ready ws://127.0.0.1:23456\\n' >>${shellQuote(logPath)}`,
          `openclaw_e2e_wait_gateway_ready "$gateway_pid" ${shellQuote(logPath)} 2`,
        ],
        {},
        5_000,
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(fs.readFileSync(grepArgsPath, "utf8")).not.toContain(logPath);
    });
  });

  it("detects gateway ready markers split across incremental log reads", () => {
    withTempDir("openclaw-e2e-readyz-split-marker-", (tempDir) => {
      const logPath = path.join(tempDir, "gateway.log");
      const result = runBashWithHelper(
        [
          "openclaw_e2e_probe_http() { return 0; }",
          "sleep 30 &",
          'gateway_pid="$!"',
          "trap 'kill \"$gateway_pid\" >/dev/null 2>&1 || true' EXIT",
          `printf '[gateway] rea' >${shellQuote(logPath)}`,
          `(sleep 0.35; printf 'dy ws://127.0.0.1:23456\\n' >>${shellQuote(logPath)}) &`,
          `openclaw_e2e_wait_gateway_ready "$gateway_pid" ${shellQuote(logPath)} 8`,
        ],
        {},
        5_000,
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    });
  });

  it("derives the readiness port only from gateway ready log lines", () => {
    withTempDir("openclaw-e2e-readyz-port-", (tempDir) => {
      const logPath = path.join(tempDir, "gateway.log");
      const probePath = path.join(tempDir, "probe-url.txt");
      const result = runBashWithHelper(
        [
          `openclaw_e2e_probe_http() { printf '%s' "$1" >${shellQuote(probePath)}; [[ "$1" = "http://127.0.0.1:23456/readyz" ]]; }`,
          "sleep 30 &",
          'gateway_pid="$!"',
          "trap 'kill \"$gateway_pid\" >/dev/null 2>&1 || true' EXIT",
          `printf '[gateway] ready ws://127.0.0.1:23456\\nunrelated localhost:9999\\n' >${shellQuote(logPath)}`,
          `openclaw_e2e_wait_gateway_ready "$gateway_pid" ${shellQuote(logPath)} 2`,
        ],
        {},
        5_000,
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(fs.readFileSync(probePath, "utf8")).toBe("http://127.0.0.1:23456/readyz");
    });
  });

  it("wraps logged OpenClaw E2E commands with the configured timeout", () => {
    withTempDir("openclaw-e2e-instance-run-logged-", (tempDir) => {
      const logLabel = path.basename(tempDir);
      const logDir = path.join(tempDir, "logs");
      const logPathFile = path.join(tempDir, "log-path.txt");
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const commandArgsPath = path.join(tempDir, "command-args.txt");
      writeTimeoutDispatcher(tempDir, "fixture-command", "OPENCLAW_TEST_COMMAND_BIN");
      writeBashExecutable(path.join(tempDir, "fixture-command"), [
        'printf "%s\\n" "$*" >"$OPENCLAW_TEST_COMMAND_ARGS"',
        'printf "fixture output\\n"',
      ]);

      const result = runBashWithHelper(
        [
          `openclaw_e2e_run_logged ${shellQuote(logLabel)} fixture-command one two`,
          `printf "%s" "$OPENCLAW_E2E_LAST_LOG_PATH" > ${shellQuote(logPathFile)}`,
        ],
        {
          PATH: `${tempDir}:${hostPath}`,
          OPENCLAW_E2E_LOG_DIR: logDir,
          OPENCLAW_E2E_COMMAND_TIMEOUT: "17s",
          OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
          OPENCLAW_TEST_COMMAND_ARGS: commandArgsPath,
          OPENCLAW_TEST_COMMAND_BIN: path.join(tempDir, "fixture-command"),
        },
        undefined,
        "; ",
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        "--kill-after=30s 17s fixture-command one two",
      );
      expect(fs.readFileSync(commandArgsPath, "utf8").trim()).toBe("one two");
      const logPath = fs.readFileSync(logPathFile, "utf8");
      expect(logPath.startsWith(`${logDir}${path.sep}`)).toBe(true);
      expect(path.basename(logPath)).toMatch(new RegExp(`^openclaw-${logLabel}\\..+\\.log$`, "u"));
      expect(fs.readFileSync(logPath, "utf8")).toContain("fixture output");
    });
  });

  it("redacts logged command failures before replay with initialized stdin", () => {
    withTempDir("openclaw-e2e-instance-run-log-redact-", (tempDir) => {
      const redactorPath = path.join(tempDir, "redactor.mjs");
      fs.writeFileSync(
        redactorPath,
        'void process.stdin;\nexport const redactSensitiveText = (value) => value.replaceAll("fixture-secret", "***");\n',
        "utf8",
      );
      writeFakeTimeout(path.join(tempDir, "timeout"), true);
      writeBashExecutable(path.join(tempDir, "fixture-command"), [
        'for ((i = 0; i < 120; i += 1)); do printf "%02000d\\n" 0; done',
        'printf "actionable failure fixture-secret\\n"',
        "exit 23",
      ]);

      const result = runBashWithHelper(
        ["openclaw_e2e_run_logged redacted-failure fixture-command"],
        {
          PATH: `${tempDir}${path.delimiter}${hostPath}`,
          OPENCLAW_E2E_LOG_DIR: path.join(tempDir, "logs"),
          OPENCLAW_E2E_REDACTOR_MODULE: redactorPath,
          OPENCLAW_TEST_TIMEOUT_ARGS: path.join(tempDir, "timeout-args.txt"),
        },
        undefined,
        "; ",
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("actionable failure ***");
      expect(result.stdout).not.toContain("fixture-secret");
    });
  });

  it("installs the trash shim under isolated test state", () => {
    withTempDir("openclaw-e2e-trash-shim-", (tempDir) => {
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
  });

  it("wraps package-installed OpenClaw CLI calls with the configured timeout", () => {
    withTempDir("openclaw-e2e-instance-openclaw-cli-", (tempDir) => {
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const commandArgsPath = path.join(tempDir, "openclaw-args.txt");
      writeTimeoutDispatcher(tempDir, path.join(tempDir, "openclaw"), "OPENCLAW_TEST_OPENCLAW_BIN");
      writeBashExecutable(path.join(tempDir, "openclaw"), [
        'printf "%s\\n" "$*" >"$OPENCLAW_TEST_COMMAND_ARGS"',
      ]);

      const result = runBashWithHelper(
        [
          "openclaw_e2e_enable_openclaw_cli_timeout",
          "openclaw_e2e_enable_openclaw_cli_timeout",
          "openclaw plugins list --json",
        ],
        {
          PATH: `${tempDir}:${hostPath}`,
          OPENCLAW_E2E_COMMAND_TIMEOUT: "23s",
          OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
          OPENCLAW_TEST_COMMAND_ARGS: commandArgsPath,
          OPENCLAW_TEST_OPENCLAW_BIN: path.join(tempDir, "openclaw"),
        },
        undefined,
        "; ",
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        `--kill-after=30s 23s ${path.join(tempDir, "openclaw")} plugins list --json`,
      );
      expect(fs.readFileSync(commandArgsPath, "utf8").trim()).toBe("plugins list --json");
    });
  });

  it("wraps interactive PTY scripts with the configured timeout", () => {
    withTempDir("openclaw-e2e-instance-pty-timeout-", (tempDir) => {
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const scriptArgsPath = path.join(tempDir, "script-args.txt");
      const logPath = path.join(tempDir, "pty.log");
      writeTimeoutDispatcher(tempDir, "script", "OPENCLAW_TEST_SCRIPT_BIN");
      writeBashExecutable(path.join(tempDir, "script"), [
        'if [ "${1:-}" = "--version" ]; then exit 0; fi',
        'printf "%s\\n" "$*" >"$OPENCLAW_TEST_SCRIPT_ARGS"',
      ]);

      const result = runBashWithHelper(
        [
          `openclaw_e2e_run_script_with_pty ${shellQuote("node /tmp/entry onboard")} ${shellQuote(logPath)}`,
        ],
        {
          PATH: `${tempDir}:${hostPath}`,
          OPENCLAW_E2E_COMMAND_TIMEOUT: "31s",
          OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
          OPENCLAW_TEST_SCRIPT_ARGS: scriptArgsPath,
          OPENCLAW_TEST_SCRIPT_BIN: path.join(tempDir, "script"),
        },
        undefined,
        "; ",
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        `--kill-after=30s 31s script -q -f -c node /tmp/entry onboard ${logPath}`,
      );
      expect(fs.readFileSync(scriptArgsPath, "utf8").trim()).toBe(
        `-q -f -c node /tmp/entry onboard ${logPath}`,
      );
    });
  });
});
