import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../test/helpers/temp-dir.js";
import { withConsoleLogsRoutedToStderrForJson } from "./cli/json-output-mode.js";
import { CliPluginInvocationResources } from "./cli/plugin-invocation-resources.js";
import type { OpenClawConfig } from "./config/types.js";
import { runMainOrRootHelp } from "./entry.js";
import { resetLogger, setLoggerOverride } from "./logging/logger.js";
import { createPluginCliLoadSession } from "./plugins/cli-registry-loader.js";
import { registerPluginCliCommands } from "./plugins/cli.js";
import { createPluginCache, retirePluginCache } from "./plugins/plugin-cache.js";
import { createDeferredCore } from "./shared/deferred.js";

type MemoryRootFixture = {
  workspaceDir: string;
  stdout: () => string;
  stderr: () => string;
  invoke: (args: string[]) => Promise<void>;
};

async function withMemoryRoot(run: (fixture: MemoryRootFixture) => Promise<void>) {
  // A later invocation must not adopt roots retained after failed owner drainage.
  const tempDirs = createTempDirTracker();
  const root = tempDirs.make("openclaw-entry-memory-json-");
  const workspaceDir = path.join(root, "workspace");
  const previousExitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cache = createPluginCache();
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    vi.stubEnv("OPENCLAW_DEBUG", "0");
    vi.stubEnv(
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      fileURLToPath(new URL("../extensions", import.meta.url)),
    );
    // The real early-diagnostic dotenv loader must see only this empty fixture.
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: workspaceDir },
        entries: { main: {} },
      },
      plugins: { allow: ["memory-core"], slots: { memory: "memory-core" } },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
          store: { vector: { enabled: false } },
        },
      },
    };
    await fs.writeFile(path.join(root, "openclaw.json"), JSON.stringify(config));
    const fixtureEnv = { ...process.env };
    const invoke = async (args: string[]) => {
      const argv = ["node", "openclaw", "memory", ...args];
      stdout.length = 0;
      stderr.length = 0;
      process.exitCode = 0;
      // Retain JSON routing around the root catch as normal runCli does; the outer
      // scope restores it when this in-process test invocation finishes.
      await withConsoleLogsRoutedToStderrForJson(argv, () =>
        runMainOrRootHelp(argv, {
          loadRunCli: async () => ({
            runCli: async (commandArgv) => {
              const program = new Command().name("openclaw").exitOverride();
              const resources = new CliPluginInvocationResources();
              const session = createPluginCliLoadSession(cache, { resources });
              try {
                await session.withCache(async () => {
                  await registerPluginCliCommands(
                    program,
                    config,
                    fixtureEnv,
                    { pluginSdkResolution: "src" },
                    { primary: "memory", session },
                  );
                  session.close();
                  await resources.run(() => program.parseAsync(commandArgv));
                });
              } finally {
                session.close();
                await resources.release();
              }
            },
          }),
        }),
      );
    };
    await run({
      workspaceDir,
      stdout: () => stdout.join(""),
      stderr: () => stderr.join(""),
      invoke,
    });
  } finally {
    try {
      try {
        const retirement = await retirePluginCache(cache);
        expect(retirement.failures).toEqual([]);
      } finally {
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        // Agent releases can reopen shared state, so close that owner last.
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
      }
    } finally {
      clearRuntimeConfigSnapshot();
      resetLogger();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      process.exitCode = previousExitCode;
    }
    tempDirs.cleanup();
  }
}

async function prepareHistoricalMemoryControl(
  { workspaceDir, invoke, stdout }: Pick<MemoryRootFixture, "workspaceDir" | "invoke" | "stdout">,
  command: "rem-harness" | "rem-backfill",
) {
  const historyPath = path.join(workspaceDir, "2025-01-01.md");
  const history =
    "## Preferences Learned\n- Always choose the copper telescope for observations.\n";
  await fs.writeFile(historyPath, history, "utf8");
  const args = [command, "--agent", "main", "--path", historyPath, "--json"];
  // Qualify the real fixture before any cleanup-failure instrumentation.
  await invoke(args);
  expect(JSON.parse(stdout())).toMatchObject({
    sourcePath: historyPath,
    sourceFiles: [historyPath],
    ...(command === "rem-harness"
      ? { historicalImport: { importedFileCount: 1 } }
      : { groundedFiles: 1, writtenEntries: 1 }),
  });
  expect(process.exitCode).toBe(0);
  return { historyPath, history, args };
}

describe("memory command failures at the root JSON boundary", () => {
  it("writes one actionable JSON failure for a queryless search", async () => {
    await withMemoryRoot(async ({ invoke, stdout, stderr }) => {
      await invoke(["search", "--json"]);

      expect(JSON.parse(stdout())).toEqual({
        ok: false,
        error: {
          type: "cli_error",
          message: "Missing search query. Provide a positional query or use --query <text>.",
        },
      });
      expect(stderr()).toContain("The CLI command failed.");
      // Vitest suppresses the native one-shot exit; this checks the logical code only.
      expect(process.exitCode).toBe(1);
    });
  });

  it.each(["rem-harness", "rem-backfill"] as const)(
    "%s writes one failure document when historical scratch removal rejects",
    async (command) => {
      await withMemoryRoot(async ({ workspaceDir, invoke, stdout, stderr }) => {
        const { historyPath, history, args } = await prepareHistoricalMemoryControl(
          { workspaceDir, invoke, stdout },
          command,
        );
        const realCopyFile = fs.copyFile.bind(fs);
        const realRm = fs.rm.bind(fs);
        const cleanupStarted = createDeferredCore();
        const cleanupRelease = createDeferredCore();
        const cleanupError = new Error("synthetic historical scratch removal denied");
        let scratchDir: string | undefined;
        let cleanupAttempts = 0;
        vi.spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
          await realCopyFile(source, destination, mode);
          if (source === historyPath && typeof destination === "string") {
            const copiedRoot = path.dirname(path.dirname(destination));
            if (
              path.basename(path.dirname(destination)) === "memory" &&
              path.basename(copiedRoot).startsWith(`openclaw-${command}-`)
            ) {
              scratchDir = copiedRoot;
            }
          }
        });
        vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          if (scratchDir !== undefined && target === scratchDir) {
            cleanupAttempts += 1;
            cleanupStarted.resolve();
            await cleanupRelease.promise;
            throw cleanupError;
          }
          await realRm(target, options);
        });
        // Attach both settlement handlers immediately, including the early-error path.
        const settled = invoke(args).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        try {
          const first = await Promise.race([
            cleanupStarted.promise.then(() => "cleanup" as const),
            settled.then(() => "settled" as const),
          ]);
          expect(first).toBe("cleanup");
          const beforeRemovalSettled = stdout();
          cleanupRelease.resolve();
          expect(await settled).toEqual({ kind: "resolved" });

          // Parse the entire stream: a success document followed by the root
          // failure document must fail even when each document is valid JSON.
          expect(JSON.parse(stdout())).toEqual({
            ok: false,
            error: { type: "cli_error", message: cleanupError.message },
          });
          expect(beforeRemovalSettled).toBe("");
          expect(cleanupAttempts).toBe(1);
          expect(stderr()).toContain(cleanupError.message);
          expect(process.exitCode).toBe(1);
          expect(await fs.readFile(historyPath, "utf8")).toBe(history);
        } finally {
          // Release and join even when a baseline assertion fails. Restoring the
          // filesystem spy cannot settle a promise it already returned.
          cleanupRelease.resolve();
          await settled;
          if (scratchDir !== undefined) {
            await realRm(scratchDir, { recursive: true, force: true });
          }
        }
      });
    },
  );
});
