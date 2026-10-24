import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  cliMessageExitEntrypoints,
  cliRecoveryEntrypoints,
} from "./cli-entrypoint.test-support.js";
import { writeFixtureJson } from "./cli-fixtures.test-support.js";
import {
  CLI_PROCESS_DEADLOCK_GUARD_MS,
  formatCliProcessFailure,
  runCliProcessChild,
} from "./cli-process-child.test-helpers.js";
import { registerCoreCliByName } from "./program/command-registry-core.js";
import { createProgramContext } from "./program/context.js";
import { registerSubCliByName } from "./program/register.subclis.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const preparedCliEntry = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);
const SLOW_DOTENV_CHILD_PROCESS_TIMEOUT_MS = 240_000;
const SLOW_DOTENV_TEST_TIMEOUT_MS = SLOW_DOTENV_CHILD_PROCESS_TIMEOUT_MS + 10_000;
const dotenvLoggingConfig = {
  logging: { consoleStyle: "${OPENCLAW_TEST_CONSOLE_STYLE}", level: "silent" },
};
const dotenvStateEnv = () => ({ OPENCLAW_TEST_CONSOLE_STYLE: "json" });
const LAZY_GROUP_HELP_CASES = [
  { group: "backup", usageCommand: "backup", registry: "core" },
  { group: "capability", usageCommand: "infer|capability", registry: "subcli" },
  { group: "channels", usageCommand: "channels", registry: "subcli" },
  { group: "clawbot", usageCommand: "clawbot", registry: "subcli" },
  { group: "daemon", usageCommand: "daemon", registry: "subcli" },
  { group: "hooks", usageCommand: "hooks", registry: "subcli" },
  { group: "migrate", usageCommand: "migrate", registry: "core" },
  { group: "node", usageCommand: "node", registry: "subcli" },
  { group: "security", usageCommand: "security", registry: "subcli" },
  { group: "update", usageCommand: "update", registry: "subcli" },
] as const;

async function listBackupArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

const guardSources = {
  forbidTlsImport: `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:tls" || specifier === "tls") {
      throw new Error(\`CLI help imported TLS from \${context.parentURL ?? "unknown"}\`);
    }
    return nextResolve(specifier, context);
  },
});
`,
  forbidForcedExit:
    'process.exit = () => { throw new Error("unexpected forced process exit"); };\n',
  failRunMainImport: `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\\/cli\\/run-main\\.(?:js|ts)(?:[?#].*)?$/.test(specifier)) {
      throw new Error("forced run-main import failure");
    }
    return nextResolve(specifier, context);
  },
});
`,
};

async function createHelpProcessFixture(config?: Record<string, unknown>) {
  const root = tempDirs.make("openclaw-help-exit-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir, { recursive: true });
  await writeFixtureJson(
    configPath,
    config ?? { plugins: { entries: { "oc-path": { enabled: true } } } },
  );
  return { root, stateDir, configPath };
}

async function runCliProcess(params: {
  args: string[];
  entry?: URL;
  config?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  forbidTlsImport?: boolean;
  forbidForcedExit?: boolean;
  failRunMainImport?: boolean;
  allowRespawn?: boolean;
  stateEnv?: (stateDir: string) => Record<string, string>;
  timeoutMs?: number;
  expectedExitCode?: number;
  pristineHome?: boolean;
  fixture?: Awaited<ReturnType<typeof createHelpProcessFixture>>;
}) {
  const fixture =
    params.fixture ??
    (await createHelpProcessFixture(params.pristineHome ? undefined : params.config));
  if (params.pristineHome) {
    await fs.rm(fixture.stateDir, { force: true, recursive: true });
  }
  if (params.stateEnv) {
    const lines = Object.entries(params.stateEnv(fixture.stateDir)).map(
      ([key, value]) => `${key}=${value}`,
    );
    await fs.writeFile(path.join(fixture.stateDir, ".env"), `${lines.join("\n")}\n`);
  }
  const preloads: string[] = [];
  for (const flag of ["forbidTlsImport", "forbidForcedExit", "failRunMainImport"] as const) {
    if (params[flag]) {
      const guardPath = path.join(fixture.root, flag + ".mjs");
      await fs.writeFile(guardPath, guardSources[flag]);
      preloads.push("--import", pathToFileURL(guardPath).href);
    }
  }
  const expectedExitCode = params.expectedExitCode ?? 0;
  const exit = await runCliProcessChild({
    nodeExecutable:
      params.forbidTlsImport || params.failRunMainImport ? resolveTestNodeExecPath() : undefined,
    nodeArgs: [
      // Prepared entrypoints still load source-checkout plugins; keep the same TSX loader.
      "--import",
      "tsx",
      // Node runs later sync customization hooks first. Install test guards after
      // TSX so they own the requested specifier instead of TSX's resolved result.
      ...preloads,
      params.entry ? fileURLToPath(params.entry) : "src/entry.ts",
      ...params.args,
    ],
    env: {
      ...process.env,
      HOME: fixture.root,
      // CI shard runners export NODE_COMPILE_CACHE; in a source checkout entry.ts
      // then respawns a detached grandchild that shares this child's stdio pipes.
      // If the deadlock guard SIGKILLs the parent, the orphan keeps the pipes open
      // and the process wait never settles, turning any slow child into a blind vitest
      // timeout with no diagnostics. Keep these children single-process; the
      // compile-cache respawn contract has dedicated entry.compile-cache coverage.
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      NODE_USE_SYSTEM_CA: "1",
      OPENCLAW_CONFIG_PATH: params.pristineHome ? undefined : fixture.configPath,
      OPENCLAW_NO_RESPAWN: params.allowRespawn ? undefined : "1",
      OPENCLAW_STATE_DIR: params.pristineHome ? undefined : fixture.stateDir,
      VITEST: undefined,
      ...params.env,
    },
    timeoutMs: params.timeoutMs,
  });
  const { stdout, stderr } = exit;
  if (exit.signal || exit.code !== expectedExitCode) {
    throw new Error(
      formatCliProcessFailure({
        reason: `CLI process exited with code ${exit.code}, signal ${exit.signal} (expected code ${expectedExitCode}, no signal)`,
        stderr,
        stdout,
      }),
    );
  }
  return { root: fixture.root, stderr, stdout };
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function captureHelp() {
  const output = { stdout: "", stderr: "" };
  const program = new Command()
    .name("openclaw")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => {
        output.stdout += value;
      },
      writeErr: (value) => {
        output.stderr += value;
      },
    });
  return { program, output };
}

async function expectInProcessHelp(program: Command, args: string[], output: { stderr: string }) {
  const result = await program.parseAsync(args, { from: "user" }).catch((cause: unknown) => cause);
  expect(result).toBeInstanceOf(CommanderError);
  expect(result).toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
  expect(output.stderr).toBe("");
}

const logRecord = (level: string, message: unknown) => expect.objectContaining({ level, message });

describe("CLI help process exit", () => {
  it.each([
    {
      name: "precomputed root",
      params: {
        args: ["--help"],
        config: { logging: { consoleStyle: "json", level: "silent" } },
        forbidTlsImport: true,
        env: { NODE_USE_SYSTEM_CA: "0" },
      },
      usage: "Usage: openclaw [options] [command]",
      plainText: true,
    },
    {
      name: "plugin-sensitive root",
      params: {
        args: ["--help"],
        config: { plugins: { enabled: false } },
        env: { NODE_USE_SYSTEM_CA: "0" },
      },
      usage: "Usage: openclaw [options] [command]",
      plainText: false,
    },
    {
      name: "lazy group",
      params: { args: ["backup", "--help"], entry: preparedCliEntry },
      usage: "Usage: openclaw backup [options] [command]",
      plainText: false,
    },
  ])("exits naturally after $name help", async ({ params, usage, plainText }) => {
    const result = await runCliProcess({ ...params, forbidForcedExit: true });
    expect(result).toMatchObject({ stderr: "", stdout: expect.stringContaining(usage) });
    if (plainText) {
      expect(() => parseJsonLines(result.stdout)).toThrow();
    }
  });

  it("flushes explicitly requested entry traces on precomputed help", async () => {
    const result = await runCliProcess({
      args: ["gateway", "--help"],
      entry: preparedCliEntry,
      config: { logging: { consoleStyle: "json", level: "silent" } },
      env: { OPENCLAW_GATEWAY_STARTUP_TRACE: "1", NODE_USE_SYSTEM_CA: "0" },
      forbidForcedExit: true,
    });

    expect(parseJsonLines(result.stderr)).toEqual(
      expect.arrayContaining([
        logRecord("info", expect.stringContaining("startup trace: entry.bootstrap")),
      ]),
    );
  });

  it.concurrent.each(LAZY_GROUP_HELP_CASES)(
    "renders in-process help for $group",
    async ({ group, usageCommand, registry }) => {
      const { program, output } = captureHelp();
      const argv = ["node", "openclaw", group, "--help"];
      const registered =
        registry === "core"
          ? await registerCoreCliByName(program, createProgramContext(), group)
          : await registerSubCliByName(program, group, argv);
      expect(registered).toBe(true);
      await expectInProcessHelp(program, argv.slice(2), output);
      expect(output.stdout).toContain(`Usage: openclaw ${usageCommand} [options] [command]`);
    },
  );

  it.concurrent.each([
    { args: ["acp", "--help"], usage: "Usage: openclaw acp [options] [command]" },
    { args: ["acp", "client", "--help"], usage: "Usage: openclaw acp client [options]" },
  ])("renders in-process ACP help for $args", async ({ args, usage }) => {
    const { program, output } = captureHelp();
    let actionStarted = false;
    program.hook("preAction", () => {
      actionStarted = true;
    });
    const argv = ["node", "openclaw", ...args];

    const registered = await registerSubCliByName(program, "acp", argv);
    expect(registered).toBe(true);
    await expectInProcessHelp(program, argv.slice(2), output);
    expect(output.stdout.split(/\r?\n/u).find((line) => line.startsWith("Usage:"))).toBe(usage);
    expect(actionStarted).toBe(false);
  });
});

it("does not scaffold a selected profile before option validation", async () => {
  const profile = "rejected-profile";
  const result = await runCliProcess({
    args: [
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--gateway-port",
      "99999",
      "--profile",
      profile,
    ],
    entry: preparedCliEntry,
    expectedExitCode: 1,
    pristineHome: true,
  });

  expect(result.stderr).toContain("--gateway-port must be an integer between 1 and 65535.");
  await expect(fs.access(path.join(result.root, `.openclaw-${profile}`))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(
  [
    {
      provider: "Moonshot AI",
      message:
        'Invalid provider filter "Moonshot AI". Use a provider id such as "moonshot", not a display label.',
    },
    {
      provider: "autoqa-no-such-provider",
      message:
        'Unknown model catalog provider "autoqa-no-such-provider". Run openclaw models list --all to list models and their provider IDs.',
    },
  ].flatMap(({ provider, message }) =>
    ["routed", "Commander"].map((route) => ({
      name: `${route} ${provider}`,
      provider,
      message,
      env: { OPENCLAW_DISABLE_ROUTE_FIRST: route === "routed" ? undefined : "1" },
    })),
  ),
)("renders $name as one clean canonical JSON document", async ({ provider, message, env }) => {
  const result = await runCliProcess({
    args: ["models", "list", "--provider", provider, "--json"],
    entry: preparedCliEntry,
    config: {},
    env: {
      ...env,
      OPENCLAW_DEBUG: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: undefined,
    },
    expectedExitCode: 1,
  });

  expect(result.stdout).not.toContain("\u001B");
  expect(result.stdout).not.toContain("\u0007");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: false,
    error: { type: "cli_error", message },
  });
  if (provider === "autoqa-no-such-provider") {
    expect(result.stderr).toContain("[openclaw] The CLI command failed.");
    expect(result.stderr).toContain("[openclaw] For help, run `openclaw doctor`.");
    expect(result.stderr).not.toContain(message);
  } else {
    expect(result.stderr).toContain(message);
  }
});

it("drains a large piped JSON payload before exiting nonzero on a structured target failure", ({
  signal,
  onTestFinished,
}) => {
  const lifetime = createFixtureLifetime();
  const finished = new AbortController();
  onTestFinished(async () => {
    finished.abort();
    await lifetime.cleanup();
  });
  return lifetime.run(async () => {
    const root = lifetime.createTempDir("openclaw-message-broadcast-exit-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const entryPath = path.join(root, "run-message-broadcast.mjs");
    const largePayload = "x".repeat(8_388_608);
    const registrationUrl = resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.registration);
    const nodeExecutable = resolveTestNodeExecPath();
    const commandSpecifier = /\.[cm]?ts$/u.test(registrationUrl.pathname)
      ? "../../commands/message.js"
      : resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.command).href;
    const finalizerUrl = resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.oneShotExit);
    await fs.writeFile(
      entryPath,
      `import { registerHooks } from "node:module";
const messageModule = "data:text/javascript," + encodeURIComponent(\`export async function messageCommand() {
  process.stdout.write(JSON.stringify(${JSON.stringify({ payload: largePayload })}) + "\\\\n");
  return ${JSON.stringify({
    kind: "broadcast",
    channel: "fixture",
    action: "broadcast",
    handledBy: "core",
    payload: {
      results: [
        { channel: "fixture", to: "ok-target", ok: true },
        { channel: "fixture", to: "failed-target", ok: false, error: "delivery failed" },
      ],
    },
    dryRun: false,
  })};
}\`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === ${JSON.stringify(commandSpecifier)}
      ? { shortCircuit: true, url: messageModule }
      : nextResolve(specifier, context);
  },
});
const { Command } = await import(${JSON.stringify(import.meta.resolve("commander"))});
const { registerMessageCommands } = await import(${JSON.stringify(registrationUrl.href)});
const { runCliWithExitFinalization } = await import(${JSON.stringify(finalizerUrl.href)});
const program = new Command();
registerMessageCommands(program, {
  programVersion: "test",
  messageChannelOptions: "fixture",
  agentChannelOptions: "last|fixture",
});
await runCliWithExitFinalization({
  run: async () => {
    await program.parseAsync([
      "message", "broadcast", "--channel", "fixture", "--targets",
      "ok-target", "failed-target", "--message", "hello",
    ], { from: "user" });
  },
  onError: (err) => {
    console.error(err);
  },
});
`,
    );

    const maxBuffer = 32 * 1024 * 1024;
    const overflow = new AbortController();
    let outputBytes = 0;
    const spawned: { child?: ChildProcess } = {};
    const child = await lifetime.track(
      runNodeScript(
        (workerArgv) => [
          ...resolveVitestNodeArgs(),
          ...workerArgv(registrationUrl).slice(0, -1),
          entryPath,
        ],
        {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          TMPDIR: process.env.TMPDIR,
          ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
          TSX_DISABLE_CACHE: process.env.TSX_DISABLE_CACHE,
          HOME: root,
          USERPROFILE: root,
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: stateDir,
        },
        CLI_PROCESS_DEADLOCK_GUARD_MS,
        {
          executable: nodeExecutable,
          cwd: path.resolve("."),
          maxBuffer,
          signal: AbortSignal.any([signal, finished.signal, overflow.signal]),
          requireProcessTreeExit: process.platform !== "win32",
          onReady(spawnedChild) {
            spawned.child = spawnedChild;
            // Preserve spawnSync's combined stdout/stderr failure bound.
            const countOutput = (chunk: Buffer) => {
              outputBytes += chunk.byteLength;
              if (outputBytes > maxBuffer) {
                overflow.abort();
              }
            };
            spawnedChild.stdout?.on("data", countOutput);
            spawnedChild.stderr?.on("data", countOutput);
          },
        },
      ),
    );
    if (overflow.signal.aborted) {
      throw new Error("Message fixture output exceeded maxBuffer", { cause: child.error });
    }

    expect(child.error).toBeUndefined();
    expect(spawned.child?.signalCode).toBeNull();
    expect(child.status, child.stderr).toBe(1);
    expect(JSON.parse(child.stdout.trim())).toEqual({ payload: largePayload });
  });
});

it.runIf(process.platform !== "win32")(
  "excludes a configured workspace before archive link validation",
  async () => {
    const fixture = await createHelpProcessFixture({});
    const { root, stateDir, configPath } = fixture;
    const workspaceDir = path.join(stateDir, "workspace");
    const externalTarget = path.join(root, "external-build");
    const outputDir = path.join(root, "output");
    await Promise.all([
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(externalTarget, { recursive: true }),
      fs.mkdir(outputDir, { recursive: true }),
    ]);
    await writeFixtureJson(configPath, { agents: { defaults: { workspace: workspaceDir } } });
    await fs.writeFile(path.join(stateDir, "state-sentinel.txt"), "state\n");
    await fs.writeFile(path.join(workspaceDir, "workspace-notes.txt"), "workspace\n");
    await fs.symlink(externalTarget, path.join(workspaceDir, ".build"), "dir");

    const result = await runCliProcess({
      fixture,
      entry: preparedCliEntry,
      args: [
        "backup",
        "create",
        "--no-include-workspace",
        "--output",
        outputDir,
        "--verify",
        "--json",
      ],
      env: {
        USERPROFILE: root,
        NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_HOME: root,
        OPENCLAW_SKIP_CHANNELS: "1",
      },
    });

    const output: unknown = JSON.parse(result.stdout);
    expect(output).toMatchObject({ includeWorkspace: false, verified: true });
    if (
      !output ||
      typeof output !== "object" ||
      !("archivePath" in output) ||
      typeof output.archivePath !== "string"
    ) {
      throw new Error("backup CLI did not return an archive path");
    }
    const entries = await listBackupArchiveEntries(output.archivePath);
    expect(entries.some((entry) => entry.endsWith("/state-sentinel.txt"))).toBe(true);
    expect(entries.some((entry) => entry.includes("/workspace/"))).toBe(false);
  },
);

describe("JSON console style process output", () => {
  const loggingConfig = {
    logging: {
      consoleLevel: "info",
      consoleStyle: "json",
      level: "silent",
    },
  };

  it(
    "captures exact exit code 2 after loading dotenv for entry validation diagnostics",
    async () => {
      const result = await runCliProcess({
        args: ["--container"],
        config: dotenvLoggingConfig,
        env: { OPENCLAW_TEST_CONSOLE_STYLE: undefined },
        stateEnv: dotenvStateEnv,
        timeoutMs: SLOW_DOTENV_CHILD_PROCESS_TIMEOUT_MS,
        expectedExitCode: 2,
      });

      expect(parseJsonLines(result.stderr)).toEqual([
        logRecord("error", expect.stringContaining("--container requires a value")),
      ]);
    },
    SLOW_DOTENV_TEST_TIMEOUT_MS,
  );

  it(
    "loads eligible dotenv before formatting a run-main import failure",
    async () => {
      const result = await runCliProcess({
        args: ["gateway", "status"],
        config: dotenvLoggingConfig,
        env: {
          OPENCLAW_DEBUG: undefined,
          OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
          OPENCLAW_TEST_CONSOLE_STYLE: undefined,
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
        },
        failRunMainImport: true,
        stateEnv: dotenvStateEnv,
        timeoutMs: SLOW_DOTENV_CHILD_PROCESS_TIMEOUT_MS,
        expectedExitCode: 1,
      });

      expect(parseJsonLines(result.stderr)).toEqual(
        expect.arrayContaining([
          logRecord("info", expect.stringContaining("startup trace: entry.bootstrap")),
          logRecord("error", "[openclaw] Could not start the CLI."),
          logRecord("error", "[openclaw] For help, run `openclaw doctor`."),
        ]),
      );
      expect(result.stderr).not.toContain("forced run-main import failure");
    },
    SLOW_DOTENV_TEST_TIMEOUT_MS,
  );

  it("preserves structured entry startup tracing across a normal respawn", async () => {
    // Gateway status skips warning-only respawn. A missing call method exercises
    // startup respawn without contacting a Gateway.
    const result = await runCliProcess({
      args: ["gateway", "call"],
      expectedExitCode: 1,
      allowRespawn: true,
      config: loggingConfig,
      env: { OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
    });

    const bootstrapRecords = parseJsonLines(result.stderr).filter(
      (record) =>
        typeof record.message === "string" &&
        record.message.includes("startup trace: entry.bootstrap"),
    );
    expect(bootstrapRecords.length).toBeGreaterThanOrEqual(2);
  });
});
