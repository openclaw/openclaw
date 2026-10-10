import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { ExpectedCliError } from "./cli/failure-output.js";
import { runMainOrRootHelp } from "./entry.js";

describe("entry run-main boundary", () => {
  it("retains JSON console routing through process finalization", async () => {
    const runCli = vi.fn(async () => undefined);

    await runMainOrRootHelp(["node", "openclaw", "status"], {
      loadRunCli: async () => ({ runCli }),
    });

    expect(runCli).toHaveBeenCalledWith(["node", "openclaw", "status"], {
      additionalStartupTrace: expect.any(Object),
      runtimeRecoveryEnv: expect.any(Object),
      retainConsoleRoutingUntilProcessExit: true,
    });
  });

  it("frames a command-phase failure as a command failure, not a startup failure", async () => {
    const previousExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
    try {
      await runMainOrRootHelp(["node", "openclaw", "onboard", "recommendations"], {
        loadRunCli: async () => ({
          runCli: vi.fn(async () => {
            throw new Error(
              "Multiple agents are configured, but this operation has no explicit owner.",
            );
          }),
        }),
      });
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith("[openclaw] The CLI command failed.");
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Could not start the CLI"));
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it("frames a failure before the command runs as a startup failure", async () => {
    const previousExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
    try {
      await runMainOrRootHelp(["node", "openclaw", "status"], {
        loadRunCli: async () => {
          throw new Error("cannot load run-main");
        },
      });
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith("[openclaw] Could not start the CLI.");
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("The CLI command failed"));
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it("keeps expected conditions at exit 1 without crash framing", async () => {
    const previousExitCode = process.exitCode;
    const message =
      'The `openclaw workboard` command is provided by the "workboard" plugin, but that bundled plugin is disabled by default. Run `openclaw plugins enable workboard` to enable that CLI surface.';
    const error = new ExpectedCliError({
      message,
      humanOutput: message,
      machineOutput: message,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;

    try {
      await runMainOrRootHelp(["node", "openclaw", "workboard", "list"], {
        loadRunCli: async () => ({
          runCli: vi.fn(async () => {
            throw error;
          }),
        }),
      });

      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls).toEqual([[message]]);
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });
});

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { json: true, phase: "finalize", trace: true, marker: "1" },
  { json: false, phase: "command", trace: false, marker: undefined },
] as const)(
  "preserves $phase failure output after installation replacement (JSON: $json, trace: $trace, updater marker: $marker)",
  async ({ json, phase, trace, marker }) => {
    const failureMessage =
      marker === undefined
        ? "global-install-failed: original update failure"
        : "original update failure";
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
    const relocated = new Map(
      sources.map((file, index) => [path.resolve(file), path.join(root, `owner-${index}.mts`)]),
    );
    for (const [source, destination] of relocated) {
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
    const runner = path.join(root, "runner.mts");
    await fs.writeFile(
      runner,
      `
import fs from 'node:fs/promises';
${trace ? "process.argv.push('gateway');" : ""}
const { runMainOrRootHelp } = await import(${JSON.stringify(pathToFileURL(relocated.get(path.resolve("src/entry.ts"))!).href)});
const fail = async () => { throw new Error(${JSON.stringify(failureMessage)}); };
await runMainOrRootHelp(['node', 'openclaw', 'update', ${json ? "'--json'" : "'--yes'"}], {
  loadRunCli: async () => ({ runCli: async () => {
    await Promise.all(${JSON.stringify([...relocated.values()])}.map(file => fs.rm(file)));
    ${phase === "command" ? "await fail();" : ""}
  }}),
  ${phase === "finalize" ? "finalize: fail," : ""}
});
`,
    );
    const result = await promisify(execFile)(
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
    ).then(
      (value) => ({ ...value, code: 0 }),
      (error: unknown) => {
        if (
          !(error instanceof Error) ||
          !("stdout" in error) ||
          !("stderr" in error) ||
          !("code" in error)
        ) {
          throw error;
        }
        return { stdout: String(error.stdout), stderr: String(error.stderr), code: error.code };
      },
    );
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("original update failure");
    if (marker === undefined) {
      expect(result.stderr).toContain("global-install-failed");
    }
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    if (trace) {
      expect(result.stderr).toContain("startup trace: entry.run-main-import");
    }
    if (json) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { message: failureMessage },
      });
    } else {
      expect(result.stdout).toBe("");
    }
  },
);
