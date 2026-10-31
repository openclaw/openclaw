import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterAll, afterEach, beforeAll, expect, it, vi, type TestContext } from "vitest";
import { runWindowsBackgroundPowerShell } from "../../scripts/e2e/parallels/guest-transports.ts";
import { run as hostCommandRun } from "../../scripts/e2e/parallels/host-command.ts";
import {
  linuxUpdateScript,
  macosUpdateScript,
  windowsUpdateScript,
} from "../../scripts/e2e/parallels/npm-update-scripts.ts";
import {
  freshLaneTimeoutMs,
  NpmUpdateSmoke,
  parseRegistryPackageMetadata,
  parseArgs,
  spawnLoggedCommand,
} from "../../scripts/e2e/parallels/npm-update-smoke.ts";
import type { HostServer, Platform } from "../../scripts/e2e/parallels/types.ts";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { withEnv, withEnvAsync } from "../../src/test-utils/env.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { createDeferred, withinTest } from "../helpers/promise.js";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { isProcessPresent } from "./run-process.test-support.js";

const SCRIPT_PATH = "scripts/e2e/parallels/npm-update-smoke.ts";
const UPDATE_SCRIPTS_PATH = "scripts/e2e/parallels/npm-update-scripts.ts";
const TEST_AUTH = {
  authChoice: "openai",
  authKeyFlag: "--openai-api-key",
  apiKeyEnv: "OPENAI_API_KEY",
  apiKeyValue: "test-key",
  modelId: "gpt-5.4",
};
const updateInput = (version = "2026.5.3-beta.2") => ({
  auth: TEST_AUTH,
  expectedNeedle: version,
  updateTarget: version,
});

const tempDirs = createTempDirTracker();
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function smokeOptions(
  platform: Platform = "linux",
): ConstructorParameters<typeof NpmUpdateSmoke>[0] {
  return {
    ...TEST_AUTH,
    dependencyTarballs: [],
    registryPackageTarballs: [],
    json: false,
    packageSpec: "openclaw@latest",
    platforms: new Set<Platform>([platform]),
    provider: "openai",
    updateTarget: "local-main",
  };
}

// The command owner joins its leader but only bounds its process-group observation.
// Foreign descendants have no ChildProcess handle; keep extinction tied to the test signal.
async function waitForDead(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isProcessPresent(pid)) {
      await waitForProcessTick(5, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`timeout waiting for pid ${pid} to exit`, { cause });
  }
}

async function runAfterFixtureReady(
  start: () => Promise<number>,
  readyPath: string,
  timeoutMs: number,
  label: string,
  signal: AbortSignal,
): Promise<number> {
  // Hold only the initial deadline; the real kill-grace timers still exercise the owner.
  const deadlineReady = createDeferred();
  const realSetTimeout = globalThis.setTimeout;
  let commandSettled = false;
  const timeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementationOnce((callback, delay, ...args) =>
      realSetTimeout(() => {
        void deadlineReady.promise.then(() => {
          if (!commandSettled) {
            callback(...args);
          }
        });
      }, delay),
    );
  let command: Promise<number> | undefined;
  try {
    try {
      command = start();
      expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(expect.any(Function), timeoutMs);
    } finally {
      timeoutSpy.mockRestore();
    }
    const hasReadyRecord = () =>
      existsSync(readyPath) && readFileSync(readyPath, "utf8").length > 0;
    // Receipts and command exit use different transports. The fixture commits this
    // record before sending readiness, so a late receipt cannot turn success into failure.
    const settled = command.then(
      () => {
        commandSettled = true;
        if (!hasReadyRecord()) {
          throw new Error(`timeout waiting for ${label}`);
        }
      },
      (error: unknown) => {
        commandSettled = true;
        if (!hasReadyRecord()) {
          throw error;
        }
      },
    );
    await withinTest(Promise.race([receipts.waitFor(readyPath, "ready"), settled]), signal);
  } finally {
    deadlineReady.resolve();
    await command;
  }
  return command;
}

function processFixture(onTestFinished: TestContext["onTestFinished"], graceful: boolean) {
  let command: Promise<number> | undefined;
  // Join the aborted body before releasing files still used by process cleanup.
  const dirs = useAutoCleanupTempDirTracker((removeDirs) => {
    onTestFinished(async () => {
      await command?.catch(() => {});
      removeDirs();
    });
  });
  const root = dirs.make("openclaw-parallels-npm-update-");
  const logPath = path.join(root, "fresh.log");
  const scriptPath = path.join(root, "lane.mjs");
  const readyPath = path.join(root, "ready");
  const donePath = path.join(root, "done");
  const descendantScript = [
    "import { writeFileSync } from 'node:fs';",
    fixtureReceiptClientSource(receipts.endpoint),
    graceful
      ? `process.on('SIGTERM', () => {\n  setTimeout(() => { writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);\n});`
      : "process.on('SIGTERM', () => {});",
    `writeFileSync(${JSON.stringify(readyPath)}, ${graceful ? "'ready'" : "String(process.pid)"});`,
    `sendReceipt(${JSON.stringify(readyPath)}, "ready");`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  writeFileSync(
    scriptPath,
    [
      "import { spawn } from 'node:child_process';",
      `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    logPath,
    scriptPath,
    readyPath,
    donePath,
    run: (start: () => Promise<number>, timeout: number, label: string, signal: AbortSignal) =>
      (command = runAfterFixtureReady(start, readyPath, timeout, label, signal)),
  };
}

function decodePowerShellFromArgs(args: string[]): string {
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  return encoded ? Buffer.from(encoded, "base64").toString("utf16le") : "";
}

const commandResult = (stdout = "", status = 0) => ({ status, stderr: "", stdout });
type WindowsJob = Parameters<typeof runWindowsBackgroundPowerShell>[0];

function windowsFixture(
  options: {
    launch?: () => ReturnType<typeof hostCommandRun>;
    input?: () => void;
    poll?: (command: string) => ReturnType<typeof hostCommandRun>;
  } = {},
) {
  const commands: string[] = [];
  const inputs: string[] = [];
  const runCommand: typeof hostCommandRun = (_command, args, runOptions) => {
    if (runOptions?.input) {
      inputs.push(runOptions.input);
      if (options.input) {
        options.input();
        return commandResult();
      }
    }
    const decoded = decodePowerShellFromArgs(args);
    commands.push(decoded);
    if (decoded.includes('cmd.exe /d /s /c start "" /b powershell.exe')) {
      return options.launch?.() ?? commandResult("started\n");
    }
    return args.includes("cmd.exe")
      ? (options.poll?.(args.at(-1) ?? "") ?? commandResult())
      : commandResult();
  };
  return {
    commands,
    inputs,
    run: (label: string, overrides: Partial<WindowsJob> = {}) =>
      runWindowsBackgroundPowerShell({
        pollIntervalMs: 1,
        script: "Write-Output done",
        timeoutMs: 5,
        vmName: "Windows Test",
        ...overrides,
        label,
        runCommand,
      }),
  };
}

function extractWindowsBackgroundControlMarkers(decoded: string): {
  done: string;
  exitPrefix: string;
} {
  const marker = (name: string, trailingColon: boolean): string => {
    const suffix = trailingColon ? ":" : "";
    const match = decoded.match(new RegExp(`${name}:[A-Za-z0-9_-]+${suffix}`));
    if (!match) {
      throw new Error(`missing ${name} control marker`);
    }
    return match[0];
  };
  return {
    done: marker("__OPENCLAW_BACKGROUND_DONE__", false),
    exitPrefix: marker("__OPENCLAW_BACKGROUND_EXIT__", true),
  };
}

function runPrerequisiteCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "MINIMAX_API_KEY", "OPENAI_API_KEY"]) {
    delete childEnv[name];
  }
  return spawnSync(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(scriptProcessEntrypoints.npmUpdateSmoke)),
      ...args,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...childEnv,
        ...env,
        OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_KILL_GRACE_MS: "invalid",
        OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: "invalid",
        OPENCLAW_PARALLELS_NPM_UPDATE_TIMEOUT_S: "invalid",
      },
      timeout: 10_000,
    },
  );
}

afterEach(() => {
  vi.useRealTimers();
  tempDirs.cleanup();
});

it.each(["default", "explicit"] as const)(
  "reports exact ready prerequisites for the %s provider",
  (mode) => {
    const secret = `sentinel-${mode}-provider-secret`;
    const args =
      mode === "explicit"
        ? [
            "--",
            "--prerequisite-check",
            "--only",
            "linux",
            "--provider",
            "anthropic",
            "--model",
            "anthropic/custom",
            "--api-key-env",
            "CUSTOM_ANTHROPIC_KEY",
          ]
        : ["--prerequisite-check"];
    const env = mode === "explicit" ? { CUSTOM_ANTHROPIC_KEY: secret } : { OPENAI_API_KEY: secret };
    const result = runPrerequisiteCli([...args, "--json"], env);
    expect(result).toMatchObject({
      status: 0,
      stderr: "",
      stdout: '{"schema":"openclaw.parallels-prerequisite.v1","status":"ready","reason":null}\n',
    });
    for (const value of [secret, "CUSTOM_ANTHROPIC_KEY", "anthropic/custom"]) {
      expect(`${result.stdout}${result.stderr}`).not.toContain(value);
    }
  },
);

it("blocks missing credentials before smoke-only validation or side effects", () => {
  const root = tempDirs.make("openclaw-parallels-prerequisite-");
  const binDir = path.join(root, "bin");
  const marker = path.join(root, "side-effect");
  mkdirSync(binDir);
  for (const command of ["bash", "git", "npm", "prlctl"]) {
    const commandPath = path.join(binDir, command);
    writeFileSync(commandPath, `#!/bin/sh\nprintf invoked >>${JSON.stringify(marker)}\nexit 99\n`, {
      mode: 0o755,
    });
  }
  const result = runPrerequisiteCli(
    [
      "--prerequisite-check",
      "--provider",
      "minimax",
      "--api-key-env",
      "CUSTOM_MISSING_KEY",
      "--json",
    ],
    {
      CUSTOM_MISSING_KEY: "",
      OPENAI_API_KEY: "sentinel-unselected-provider-secret",
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  );

  expect(result).toMatchObject({
    status: 1,
    stdout:
      '{"schema":"openclaw.parallels-prerequisite.v1","status":"blocked","reason":"credential_missing"}\n',
    stderr: "",
  });
  expect(result.stdout).not.toContain("CUSTOM_MISSING_KEY");
  expect(result.stdout).not.toContain("sentinel-unselected-provider-secret");
  expect(existsSync(marker)).toBe(false);
});

it("accepts one prepared tarball target for update and fresh install", () => {
  expect(
    parseArgs([
      "--target-tarball",
      "/tmp/openclaw-candidate.tgz",
      "--dependency-tarball",
      "/tmp/openclaw-ai-candidate.tgz",
      "--registry-package-tarball",
      "/tmp/openclaw-codex-candidate.tgz",
    ]),
  ).toMatchObject({
    dependencyTarballs: ["/tmp/openclaw-ai-candidate.tgz"],
    registryPackageTarballs: ["/tmp/openclaw-codex-candidate.tgz"],
    targetTarball: "/tmp/openclaw-candidate.tgz",
    updateTarget: "",
    freshTargetSpec: undefined,
  });
  expect(() =>
    parseArgs(["--target-tarball", "/tmp/openclaw-candidate.tgz", "--update-target", "beta"]),
  ).toThrow("--target-tarball cannot be combined");
  expect(() => parseArgs(["--dependency-tarball", "/tmp/openclaw-ai-candidate.tgz"])).toThrow(
    "--dependency-tarball requires --target-tarball",
  );
  expect(() =>
    parseArgs(["--registry-package-tarball", "/tmp/openclaw-codex-candidate.tgz"]),
  ).toThrow("--registry-package-tarball requires --target-tarball");
});

it("passes an explicit macOS snapshot hint through fresh lanes", () => {
  expect(
    parseArgs(["--platform", "macos", "--macos-snapshot-hint", "macOS 26.5 Node 24"]),
  ).toMatchObject({
    macosSnapshotHint: "macOS 26.5 Node 24",
    platforms: new Set(["macos"]),
  });
});

it("accepts an explicit Windows VM at the aggregate CLI", () => {
  const result = hostCommandRun(
    process.execPath,
    ["--import", "tsx", SCRIPT_PATH, "--windows-vm", "Windows Test Guest", "--help"],
    { check: false },
  );
  expect(result.status, result.stderr).toBe(0);
});

it("stops the host artifact server when the wrapper fails mid-run", async () => {
  const stop = vi.fn(async () => {});
  const server: HostServer = {
    hostIp: "127.0.0.1",
    port: 48123,
    stop,
    urlFor: (filePath) => `http://127.0.0.1:48123/${path.basename(filePath)}`,
  };

  class FailingNpmUpdateSmoke extends NpmUpdateSmoke {
    protected override async makeRunTempDir(_prefix: string): Promise<string> {
      return tempDirs.make("openclaw-parallels-npm-update-");
    }

    protected override async runSteps(): Promise<void> {
      this.server = server;
      throw new Error("forced wrapper failure");
    }
  }

  await withEnvAsync({ OPENAI_API_KEY: "test-key" }, async () => {
    const smoke = new FailingNpmUpdateSmoke(smokeOptions());

    await expect(smoke.run()).rejects.toThrow("forced wrapper failure");
  });

  expect(stop).toHaveBeenCalledOnce();
});

it.runIf(process.platform !== "win32").each([
  ["macos", macosUpdateScript],
  ["linux", linuxUpdateScript],
] as const)(
  "keeps the %s candidate registry available through gateway shutdown and the local turn",
  (platform, buildScript) => {
    const root = tempDirs.make("openclaw-parallels-update-registry-");
    const logPath = path.join(root, "registry.log");
    const lifecycleLog = path.join(root, "lifecycle.log");
    const gatewayOwner = path.join(root, "gateway-owner");
    const gatewayTitle = platform === "macos" ? "openclaw-gateway        " : "openclaw-gateway";
    const registry = "http://192.0.2.2:48123";
    const script = buildScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.7.1-beta.3",
      npmRegistry: registry,
      updateTarget: "2026.7.1-beta.3",
    }).replaceAll(
      `/tmp/openclaw-parallels-${platform}-gateway.log`,
      path.join(root, "gateway.log"),
    );
    const result = hostCommandRun(
      "bash",
      [
        "-c",
        `
export HOME='${root}'
unset OPENCLAW_WORKSPACE_DIR
node() { cat >/dev/null; }
python3() { cat >/dev/null; }
function /usr/bin/env() { cat >/dev/null; }
release_gateway_owner() {
  if [ -f '${gatewayOwner}' ]; then
    printf 'stop\\n' >>'${lifecycleLog}'
    rm '${gatewayOwner}'
  fi
}
pkill() {
  if [ "$1" = '-f' ] && printf '%s\\n' '${gatewayTitle}' | grep -Eq "$2"; then
    release_gateway_owner
  else
    return 1
  fi
}
pgrep() { return 1; }
lsof() { :; }
sleep() { :; }
setsid() { :; }
openclaw() {
  case "$1 \${2-}" in
    "gateway stop")
      if [[ " $* " == *" --help "* ]]; then echo '--force'; return 0; fi
      release_gateway_owner
      return 0 ;;
    "gateway status")
      touch '${gatewayOwner}'
      printf 'ready\\n' >>'${lifecycleLog}' ;;
    "agent --local")
      if [ -f '${gatewayOwner}' ]; then echo 'gateway owns state' >&2; return 73; fi
      printf 'local-turn\\n' >>'${lifecycleLog}'
      echo '{"finalAssistantVisibleText":"OK"}' ;;
    "gateway run"|"models set"|"config set") return 0 ;;
  esac
  printf '%s|%s|%s\\n' "$1" "\${NPM_CONFIG_REGISTRY-}" "\${npm_config_registry-}" >>'${logPath}'
  case "$1" in
    --version) echo 'OpenClaw 2026.7.1-beta.3' ;;
  esac
}
${script}`,
      ],
      { check: false, timeoutMs: 5000 },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      `update|${registry}|${registry}`,
      `--version|${registry}|${registry}`,
      `gateway|${registry}|${registry}`,
      `agent|${registry}|${registry}`,
    ]);
    expect(readFileSync(lifecycleLog, "utf8").trim().split("\n")).toEqual([
      "ready",
      "stop",
      "local-turn",
    ]);
  },
);

it("restarts POSIX gateways only after an exact current-launch migration refusal", () => {
  const input = updateInput("2026.7.2-beta.5");

  for (const script of [macosUpdateScript(input), linuxUpdateScript(input)]) {
    expect(script).toContain(
      "OpenClaw plugin migration inputs changed during startup convergence;",
    );
    expect(script).toContain("gateway_launch_log_offset=");
    expect(script).toContain("gateway_pid=$!");
    expect(script).toContain('if ! kill -0 "$gateway_pid" 2>/dev/null; then');
    expect(script).toContain('tail -c +"$((gateway_launch_log_offset + 1))" "$gateway_log"');
    expect(script).toContain(
      'if [ "$gateway_exit_status" -le 128 ] && [ "$gateway_restart_count" -eq 0 ]; then',
    );
    expect(script).toContain("gateway_restart_count=1");
    expect(script).not.toContain('if [ "$attempt" -eq 4 ]');
  }
});

it("restarts the Windows gateway only after its current launch exits with the exact refusal", () => {
  const script = windowsUpdateScript(updateInput("2026.7.2-beta.5"));

  expect(script).toContain("OpenClaw plugin migration inputs changed during startup convergence;");
  expect(script).toContain("$script:gatewayProcess.HasExited");
  expect(script).toContain("$script:gatewayProcess.WaitForExit()");
  expect(script).toContain("$script:gatewayRestartCount -eq 0");
  expect(script).toContain("Test-CurrentGatewayStartupMigrationRefusal");
  expect(script).toContain("Select-String -Path $script:gatewayLogPath -SimpleMatch");
  expect(script).toContain("$script:gatewayRestartCount = 1");
  expect(script).not.toContain("$attempt -eq 4");
  expect(script).not.toContain("Invoke-OpenClaw gateway restart");
});

it("keeps POSIX provider secrets out of executable command lines", () => {
  const input = updateInput("2026.7.2-beta.5");
  const exportLine = `  export ${TEST_AUTH.apiKeyEnv}='${TEST_AUTH.apiKeyValue}'`;

  for (const script of [macosUpdateScript(input), linuxUpdateScript(input)]) {
    expect(script.split("\n").filter((line) => line.includes(TEST_AUTH.apiKeyValue))).toEqual([
      exportLine,
    ]);
    expect(script).toMatch(/with_provider_api_key [^\n]*gateway run/u);
    expect(script).toMatch(/with_provider_api_key [^\n]*agent --local/u);
    expect(script).toContain(`unset ${TEST_AUTH.apiKeyEnv}`);
    expect(script.split("\n").find((line) => line.includes(" update --tag "))).not.toContain(
      "with_provider_api_key",
    );
  }
});

it.each(["keyed", "nested"] as const)("accepts %s npm metadata for published targets", (shape) => {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  expect(script).toContain("curl -fsSL --connect-timeout 10 --max-time 120 --retry 2");
  expect(script).toContain("timeoutMs: 150_000");
  const version = "2026.5.20-beta.1";
  const tarball = `https://registry.example/openclaw-${shape}.tgz`;
  const metadata =
    shape === "keyed"
      ? { "dist.tarball": tarball, gitHead: "abcdef0123456789" }
      : { dist: { tarball } };
  expect(parseRegistryPackageMetadata(JSON.stringify({ version, ...metadata }))).toEqual({
    version,
    tarball,
    gitHead: shape === "keyed" ? "abcdef0123456789" : "",
  });
});

it("guards beta validation against cross-version harness checkouts", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  expect(script).toContain("assertPublishedTargetMatchesHarnessCheckout");
  expect(script).toContain("readHarnessCheckoutVersion");
  expect(script).toContain("openClawVersionFamily");
  expect(script).toContain("OPENCLAW_PARALLELS_ALLOW_HARNESS_TARGET_MISMATCH");
  expect(script).toContain("checkout the matching release branch");
});

it("streams aggregate update logs instead of retaining them in memory", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const updateBlock = script.slice(
    script.indexOf("  private spawnUpdate"),
    script.indexOf("  private updateScript"),
  );

  expect(updateBlock).toContain("appendFileSync(logPath, text");
  expect(updateBlock).not.toContain("log += text");
});

it("bounds POSIX guest failure logs", () => {
  const scripts = [macosUpdateScript, linuxUpdateScript]
    .map((build) => build(updateInput()))
    .join("\n");

  expect(scripts).toContain("print_log_tail()");
  expect(scripts).toContain("OPENCLAW_PARALLELS_NPM_UPDATE_LOG_TAIL_BYTES");
  expect(scripts).toContain('print_log_tail "$output_file"');
  expect(scripts).toContain('print_log_tail "$gateway_log" >&2');
  expect(scripts).not.toContain('cat "$output_file"');
  expect(scripts).not.toContain("cat /tmp/openclaw-parallels-");
});

it.each([
  [undefined, undefined, 900, 1800],
  ["321", "654", 321, 654],
] as const)("passes POSIX model timeouts (%s, %s)", (linux, macos, linuxSeconds, macosSeconds) => {
  withEnv(
    {
      OPENCLAW_PARALLELS_LINUX_MODEL_TIMEOUT_S: linux,
      OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: macos,
      OPENCLAW_PARALLELS_MODEL_TIMEOUT_S: undefined,
    },
    () => {
      expect(macosUpdateScript(updateInput())).toContain(`--timeout ${macosSeconds} --json`);
      expect(linuxUpdateScript(updateInput())).toContain(`--timeout ${linuxSeconds} --json`);
    },
  );
});

it.each(["streaming", "oversized timeout"] as const)(
  "runs fresh commands with %s",
  async (mode) => {
    const streaming = mode === "streaming";
    const logPath = path.join(tempDirs.make("openclaw-parallels-npm-update-"), "fresh.log");
    const output: string[] = [];

    const code = await spawnLoggedCommand(
      process.execPath,
      [
        "-e",
        streaming
          ? "process.stdout.write('fresh-out'); process.stderr.write('fresh-err');"
          : "setTimeout(() => process.exit(0), 25);",
      ],
      logPath,
      {},
      streaming ? (text) => output.push(text) : undefined,
      { timeoutMs: streaming ? 1000 : Number.MAX_SAFE_INTEGER },
    );

    expect(code).toBe(0);
    if (streaming) {
      for (const text of [readFileSync(logPath, "utf8"), output.join("")]) {
        expect(text).toContain("fresh-out");
        expect(text).toContain("fresh-err");
      }
    }
  },
);

it("sets platform-aware fresh lane timeouts", () => {
  withEnv({ OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: undefined }, () => {
    expect(freshLaneTimeoutMs("macos")).toBe(75 * 60 * 1000);
    expect(freshLaneTimeoutMs("linux")).toBe(75 * 60 * 1000);
    expect(freshLaneTimeoutMs("windows")).toBe(90 * 60 * 1000);
  });

  withEnv({ OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: "3" }, () => {
    expect(freshLaneTimeoutMs("macos")).toBe(3000);
  });

  withEnv(
    { OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: String(Number.MAX_SAFE_INTEGER) },
    () => {
      expect(freshLaneTimeoutMs("linux")).toBe(MAX_TIMER_TIMEOUT_MS);
    },
  );
});

it.runIf(process.platform !== "win32")(
  "times out fresh lane process groups",
  async ({ signal, onTestFinished }) => {
    const f = processFixture(onTestFinished, false);
    const code = await f.run(
      () =>
        spawnLoggedCommand(process.execPath, [f.scriptPath], f.logPath, {}, undefined, {
          timeoutKillGraceMs: 25,
          timeoutLabel: "fresh lane test",
          timeoutMs: 250,
        }),
      250,
      "fresh lane descendant readiness",
      signal,
    );

    expect(code).toBe(124);
    expect(readFileSync(f.logPath, "utf8")).toContain("fresh lane test timed out after 250ms");
    expect(existsSync(f.readyPath)).toBe(true);
    const descendantPid = Number(readFileSync(f.readyPath, "utf8"));
    try {
      await waitForDead(descendantPid, signal);
    } finally {
      if (isProcessPresent(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  },
);

it.runIf(process.platform !== "win32").for(["fresh", "update"] as const)(
  "lets %s descendants exit during timeout kill grace",
  async (lane, { signal, onTestFinished }) => {
    const f = processFixture(onTestFinished, true);
    const start =
      lane === "fresh"
        ? () =>
            spawnLoggedCommand(process.execPath, [f.scriptPath], f.logPath, {}, undefined, {
              timeoutKillGraceMs: 500,
              timeoutLabel: "fresh lane grace test",
              timeoutMs: 500,
            })
        : withEnv({ OPENAI_API_KEY: "test-key" }, () => {
            const smoke = new NpmUpdateSmoke(smokeOptions());
            return () =>
              smoke["runStreamingToJobLog"](process.execPath, [f.scriptPath], 500, {
                append: () => undefined,
                signal: new AbortController().signal,
              });
          });
    const label = lane === "fresh" ? "fresh lane" : "update stream";
    expect(await f.run(start, 500, `${label} descendant readiness`, signal)).toBe(124);
    expect(readFileSync(f.donePath, "utf8")).toBe("done");
  },
);

it("clears update stream timers when spawning the guest command fails", async () => {
  vi.useFakeTimers();
  const smoke = withEnv({ OPENAI_API_KEY: "test-key" }, () => new NpmUpdateSmoke(smokeOptions()));

  await expect(
    smoke["runStreamingToJobLog"]("openclaw-definitely-missing-command", [], 60 * 60 * 1000, {
      append: () => undefined,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans timed-out Windows background work", async () => {
  const f = windowsFixture({ poll: () => commandResult("wait\n") });

  await expect(
    f.run("windows background timeout", { script: "Start-Sleep -Seconds 60" }),
  ).rejects.toThrow("windows background timeout timed out");

  const commands = f.commands.join("\n---\n");
  const payloads = f.inputs.join("\n---\n");
  expect(commands).toContain("$pidPath");
  expect(commands).toContain("function Write-OpenClawUtf8File");
  expect(commands).toContain("[System.Text.UTF8Encoding]::new($false)");
  expect(payloads).toContain("Write-OpenClawUtf8File $exitPath '0'");
  expect(payloads).toContain("Write-OpenClawUtf8File $donePath 'done'");
  expect(payloads).toContain("Write-OpenClawUtf8File $pidPath ([string]$PID)");
  expect(commands).toContain('cmd.exe /d /s /c start "" /b powershell.exe');
  expect(commands).toContain("icacls.exe $runDir /inheritance:r");
  expect(commands).toContain("Stop-OpenClawBackgroundProcessTree ([int]$backgroundPid)");
  expect(commands).toContain('Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId"');
  expect(commands).toContain(
    "Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath, $pidPath",
  );
  expect(`${commands}\n${payloads}`).not.toContain("Set-Content -Path $exitPath");
  expect(`${commands}\n${payloads}`).not.toContain("Set-Content -Path $donePath");
  expect(commands).not.toContain("Set-Content -Path $pidPath");
  expect(commands).not.toContain("ReadAllBytes");
});

it.each([
  [0, "started\n", "timed out"],
  [0, "", "background launch failed with exit code 0"],
  [17, "", "background launch failed with exit code 17"],
] as const)(
  "preserves launch status %s with output %j when setup exhausts its budget",
  async (launchStatus, launchOutput, expectedError) => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let launchAttempts = 0;
    const f = windowsFixture({
      input: () => {
        now += 2;
      },
      launch: () => {
        launchAttempts++;
        return commandResult(launchOutput, launchStatus);
      },
    });

    try {
      await expect(
        f.run("windows setup deadline", { script: "Write-Output test" }),
      ).rejects.toThrow(`windows setup deadline ${expectedError}`);
      expect(launchAttempts).toBe(1);
    } finally {
      clock.mockRestore();
    }
  },
);

it("drains a completed Windows job when setup exhausts the active budget", async () => {
  let now = 1_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let completionProbes = 0;
  let logProbes = 0;
  const f = windowsFixture({
    input: () => {
      now += 2;
    },
    poll: (command) => {
      if (command.includes("__OPENCLAW_BACKGROUND_DONE__")) {
        logProbes++;
        const markers = extractWindowsBackgroundControlMarkers(command);
        return commandResult([`${markers.exitPrefix}0`, markers.done, ""].join("\n"));
      }
      if (command.includes("(echo done) else (echo wait)")) {
        completionProbes++;
        return commandResult("done\n");
      }
      return commandResult();
    },
  });

  try {
    await expect(f.run("windows completed before first poll")).resolves.toBeUndefined();
    expect(completionProbes).toBe(1);
    expect(logProbes).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

it("does not treat Windows background log text as completion control", async () => {
  const f = windowsFixture({ poll: () => commandResult("done\n") });

  await expect(
    f.run("windows background marker smuggle", { completedLogDrainGraceMs: 5 }),
  ).rejects.toThrow("windows background marker smuggle timed out");

  expect(f.commands.join("\n")).toContain(
    "Stop-OpenClawBackgroundProcessTree ([int]$backgroundPid)",
  );
});

it("drains completed Windows background logs before cleanup", async () => {
  const output: string[] = [];
  let pollCount = 0;
  const f = windowsFixture({
    poll: (command) => {
      if (command.includes("type")) {
        pollCount += 1;
        const markers = extractWindowsBackgroundControlMarkers(command);
        return commandResult(
          ["first chunk", `${markers.exitPrefix}0`, markers.done, ""].join("\n"),
        );
      }
      if (command.includes("if exist")) {
        return commandResult("done\n");
      }
      return commandResult();
    },
  });

  await expect(
    f.run("windows background drain", {
      append: (chunk) => output.push(String(chunk)),
      completedLogDrainGraceMs: 1000,
      pollIntervalMs: 5000,
      timeoutMs: 20,
    }),
  ).resolves.toBeUndefined();

  expect(pollCount).toBe(1);
  expect(output.join("")).toContain("first chunk");
  expect(f.commands.join("\n")).not.toContain("Stop-OpenClawBackgroundProcessTree");
  expect(f.commands.join("\n")).toContain(
    "Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath, $pidPath",
  );
});

it("scrubs future plugin entries before invoking old same-guest updaters", () => {
  const script = readFileSync(UPDATE_SCRIPTS_PATH, "utf8");
  const windowsScript = windowsUpdateScript(updateInput());
  const macosScript = macosUpdateScript(updateInput());

  expect(script).toContain("Remove-FuturePluginEntries");
  expect(script).toContain("scrub_future_plugin_entries");
  expect(script).toContain("delete plugins.entries.feishu");
  expect(script).toContain("delete plugins.entries.whatsapp");
  expect(windowsScript).toContain(
    'const futurePluginIds = new Set(["feishu", "whatsapp", "openai"])',
  );
  expect(windowsScript).toContain('replace(/^\\uFEFF/u, "")');
  expect(windowsScript).toContain("if (allow.length !== plugins.allow.length)");
  expect(windowsScript).toContain('JSON.stringify(config, null, 2) + "\\n"');
  expect(windowsScript).not.toContain("ConvertTo-Json -Depth 100");
  expect(windowsScript).toContain("& node.exe $nodeScriptPath $configPath");
  expect(windowsScript).toContain(
    "Remove-Item $nodeScriptPath -Force -ErrorAction SilentlyContinue",
  );
  expect(windowsScript).toContain("Remove-FuturePluginEntries\nStop-OpenClawGatewayProcesses");
  expect(script).toContain("scrub_future_plugin_entries\nstop_openclaw_gateway_processes");
  expect(macosScript).toContain('OPENCLAW_BIN="$(resolve_required_command openclaw)"');
  expect(macosScript).toContain("/usr/local/bin:/usr/local/sbin");
  expect(macosScript).not.toContain("/opt/homebrew/bin/openclaw");
});

it("preserves bundled plugin inventory during updates while isolating POSIX gateway stops", () => {
  const input = updateInput();
  const windowsScript = windowsUpdateScript(input);
  const macosScript = macosUpdateScript(input);
  const linuxScript = linuxUpdateScript(input);
  const updateLines = [windowsScript, macosScript, linuxScript].map((generatedScript) =>
    generatedScript.split("\n").find((line) => line.includes(" update --tag ")),
  );

  expect(updateLines).not.toContain(undefined);
  for (const updateLine of updateLines) {
    expect(updateLine).not.toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
  }
  expect(windowsScript).toContain(
    "Invoke-WithScopedEnv @{ OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS = '1'",
  );
  expect(windowsScript).not.toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
  expect(macosScript).toContain('OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 "$OPENCLAW_BIN" gateway stop');
  expect(linuxScript).toContain(
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 OPENCLAW_ALLOW_ROOT=1 openclaw gateway stop",
  );
});

it("generates a .NET-safe Windows stale import regex in the update-failure guard", () => {
  const script = windowsUpdateScript({
    auth: TEST_AUTH,
    expectedNeedle: "2026.4.30",
    updateTarget: "latest",
  });
  const staleImportLine = script.match(/\$stalePostSwapImport = [^\n]+/)?.[0];
  const staleImportMatch = script.match(/\$updateText -match '(node_modules[^']+)'/);
  const staleImportPattern = staleImportMatch?.[1];

  if (!staleImportLine) {
    throw new Error("missing generated Windows stale import guard");
  }
  if (!staleImportPattern) {
    throw new Error("missing generated Windows stale import regex");
  }
  expect(staleImportLine).toContain("$updateText -match 'ERR_MODULE_NOT_FOUND'");
  expect(staleImportLine).toContain(`$updateText -match '${staleImportPattern}'`);
  expect(staleImportPattern).not.toContain("node_modules\\openclaw\\dist\\");
  expect(staleImportPattern.match(/\\\\/g)).toHaveLength(4);
  const generatedRegex = new RegExp(staleImportPattern);
  for (const extension of ["js", "mjs"]) {
    const representativeUpdateFailure = String.raw`Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\runner\AppData\Roaming\npm\node_modules\openclaw\dist\main-a1_B2.${extension}' imported from C:\Users\runner\AppData\Roaming\npm\node_modules\openclaw\dist\cli.js`;
    expect(generatedRegex.test(representativeUpdateFailure)).toBe(true);
    expect(generatedRegex.test(String.raw`node_modules\openclaw\dist\main.${extension}`)).toBe(
      false,
    );
  }
});
