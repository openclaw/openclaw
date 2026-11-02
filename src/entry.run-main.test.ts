import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { ExpectedCliError } from "./cli/expected-cli-error.js";
import { runMainOrRootHelp } from "./entry.js";
import type { PluginRuntime } from "./plugin-sdk/runtime-store.js";
import { buildPluginApi } from "./plugins/api-builder.js";
import { instrumentPluginInstanceApi } from "./plugins/api-facades.js";
import { PluginInstance } from "./plugins/plugin-instance.js";
import type { OpenClawPluginCliRegistrar } from "./plugins/plugin-registration.types.js";

describe("entry run-main boundary", () => {
  let previousExitCode: typeof process.exitCode;
  let errorSpy: MockInstance<typeof console.error>;
  let instance: PluginInstance | undefined;
  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.doUnmock("./cli/run-main.js");
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
    await instance?.dispose();
    instance = undefined;
  });

  it.each(["command", "startup", "expected"] as const)("frames a %s failure", async (phase) => {
    const message = "Enable the workboard plugin.";
    const error =
      phase === "expected"
        ? new ExpectedCliError({ message, humanOutput: message, machineOutput: message })
        : new Error("synthetic CLI failure");
    const runCli = async () => {
      throw error;
    };
    // mock-isolation: Distinguish import failure from failure inside the loaded command.
    vi.doMock("./cli/run-main.js", async () => (phase === "startup" ? runCli() : { runCli }));
    await runMainOrRootHelp(["node", "openclaw", "status"]);
    expect(process.exitCode).toBe(1);
    if (phase === "expected") {
      expect(errorSpy.mock.calls).toEqual([[message]]);
    } else {
      const startup = phase === "startup";
      expect(errorSpy).toHaveBeenCalledWith(
        `[openclaw] ${startup ? "Could not start the CLI." : "The CLI command failed."}`,
      );
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(startup ? "The CLI command failed" : "Could not start the CLI"),
      );
    }
  });

  it.each([false, true])("reports plugin action failures (JSON: %s)", async (json) => {
    const message = "--limit must be a positive integer";
    instance = new PluginInstance("fixture");
    let registrar: OpenClawPluginCliRegistrar | undefined;
    const api = instrumentPluginInstanceApi(
      buildPluginApi({
        id: "fixture",
        name: "fixture",
        source: "test",
        registrationMode: "discovery",
        config: {},
        runtime: {} as PluginRuntime,
        resolvePath: (value) => value,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        handlers: { registerCli: (value) => (registrar = value) },
      }),
      instance,
    );
    api.registerCli(
      ({ program }) => {
        program
          .command("fail")
          .option("--json")
          .action(() => {
            throw new Error(message);
          });
      },
      { commands: ["fail"] },
    );
    const host = new Command();
    await registrar?.({ program: host, parentPath: [], config: {}, logger: api.logger });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const runCli = vi.fn(async (argv: string[]) => {
      await host.parseAsync(argv);
    });
    // mock-isolation: This command runs on the fixture program, not the real CLI runtime.
    vi.doMock("./cli/run-main.js", async () => ({ runCli }));
    const argv = ["node", "openclaw", "fail", ...(json ? ["--json"] : [])];
    await runMainOrRootHelp(argv);
    expect(runCli).toHaveBeenCalledWith(argv, {
      additionalStartupTrace: expect.any(Object),
      runtimeRecoveryEnv: expect.any(Object),
      retainConsoleRoutingUntilProcessExit: true,
    });

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls).toEqual([[message]]);
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(json ? JSON.parse(output) : output).toEqual(
      json ? { ok: false, error: { type: "cli_error", message } } : "",
    );
  });
});

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { json: true, phase: "finalize", trace: true, marker: "1" },
  { json: false, phase: "command", trace: false, marker: undefined },
] as const)(
  "preserves $phase failure output after installation replacement (JSON: $json, trace: $trace, updater marker: $marker)",
  async ({ json, phase, trace, marker }) => {
    const failureMessage = `${marker === undefined ? "global-install-failed: " : ""}original update failure`;
    const root = await fs.realpath(dirs.make("openclaw-entry-replacement-"));
    const sources = [
      "src/entry.ts",
      "src/shared/detached-async-context.ts",
      "src/shared/global-singleton.ts",
      "src/cli/dotenv.ts",
      "src/logging.ts",
      "src/cli/failure-output.ts",
      "src/cli/json-output-mode.ts",
      "src/logging/json-console-line.ts",
      "src/cli/startup-trace.ts",
    ];
    const runMainPath = path.join(root, "run-main.mts");
    const relocated = new Map(
      sources.map((file, index) => [path.resolve(file), path.join(root, `owner-${index}.mts`)]),
    );
    relocated.set(path.resolve("src/cli/run-main.ts"), runMainPath);
    for (const [source, destination] of relocated) {
      if (destination === runMainPath) {
        continue;
      }
      const code = (await fs.readFile(source, "utf8")).replace(
        /(from\s+|import\(|import\s+)"([^"\n]+)"/g,
        (_match, prefix: string, specifier: string) => {
          const target = specifier.startsWith(".")
            ? path.resolve(path.dirname(source), specifier).replace(/\.js$/, ".ts")
            : undefined;
          return `${prefix}${JSON.stringify(target ? pathToFileURL(relocated.get(target) ?? target).href : import.meta.resolve(specifier))}`;
        },
      );
      await fs.writeFile(destination, code);
    }
    await fs.writeFile(
      runMainPath,
      `
import fs from 'node:fs/promises';
export async function runCli() {
  await Promise.all(${JSON.stringify([...relocated.values()])}.map(file => fs.rm(file)));
  ${phase === "command" ? `throw new Error(${JSON.stringify(failureMessage)});` : ""}
}
`,
    );
    const runner = path.join(root, "runner.mts");
    await fs.writeFile(
      runner,
      `
${trace ? "process.argv.push('gateway');" : ""}
const { runMainOrRootHelp } = await import(${JSON.stringify(pathToFileURL(relocated.get(path.resolve("src/entry.ts"))!).href)});
const fail = async () => { throw new Error(${JSON.stringify(failureMessage)}); };
await runMainOrRootHelp(['node', 'openclaw', 'update', ${json ? "'--json'" : "'--yes'"}], {
  ${phase === "finalize" ? "finalize: fail," : ""}
});
`,
    );
    const result = await new Promise<{ stdout: string; stderr: string; code?: string | number }>(
      (resolve) => {
        execFile(
          process.execPath,
          ["--import", path.resolve("scripts/tsx.mjs"), runner],
          {
            cwd: root,
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: path.join(root, "state"),
              OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
              OPENCLAW_DEBUG: "0",
              OPENCLAW_UPDATE_IN_PROGRESS: marker,
              OPENCLAW_GATEWAY_STARTUP_TRACE: trace ? "1" : "0",
              NODE_OPTIONS: "",
              VITEST: "",
              VITEST_POOL_ID: "",
              VITEST_WORKER_ID: "",
              TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
            },
          },
          (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? error.code : 0 }),
        );
      },
    );
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain(failureMessage);
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    if (trace) {
      expect(result.stderr).toContain("startup trace: entry.run-main-import");
    }
    if (json) {
      const expected = { ok: false, error: { message: failureMessage } };
      expect(JSON.parse(result.stdout)).toMatchObject(expected);
    } else {
      expect(result.stdout).toBe("");
    }
  },
);
