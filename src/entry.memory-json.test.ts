import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../test/helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../test/helpers/qa-gateway-test-lifetime.js";
import { createTempDirTracker } from "../test/helpers/temp-dir.js";
import { withConsoleLogsRoutedToStderrForJson } from "./cli/json-output-mode.js";
import { CliPluginInvocationResources } from "./cli/plugin-invocation-resources.js";
import type { OpenClawConfig } from "./config/types.js";
import { runMainOrRootHelp } from "./entry.js";
import { openNodeSqliteDatabase } from "./infra/node-sqlite.js";
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

// The infra project already prepares the built runtime for this entry-point file.
describe("registered memory_search through Gateway /tools/invoke (infra)", () => {
  it(
    "returns semantic recall before its deadline with chunks-first planner estimates",
    {
      timeout: 120_000,
    },
    (context) => {
      const query = "How do we restore service after a failed deployment?";
      const documents = [
        [
          "rollback",
          "Revert the release to the previous healthy version when the rollout breaks.",
          0.01,
        ],
        ["traffic", "Route requests back to the healthy replica pool while repairs proceed.", 0.05],
        ["snapshot", "Recover the saved application snapshot and restart the service.", 0.1],
        ["verify", "Check health probes and run a smoke test before reopening traffic.", 0.15],
        ["repair", "Repair the broken release in staging before attempting another rollout.", 0.2],
        [
          "keyword",
          "The deployment art exhibition includes a failed sculpture named service.",
          1.55,
        ],
        ["background", "The botanical catalog describes orchids and garden soil.", 1.57],
      ] as const;
      const vector = (angle: number) => [
        Math.cos(angle),
        Math.sin(angle),
        ...Array<number>(8190).fill(0),
      ];
      const embeddings = new Map<string, number[]>(
        documents.map(([, text, angle]) => [text, vector(angle)]),
      );
      const providerErrors: unknown[] = [];
      let instance: OpenClawTestInstance | undefined;
      const provider = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const body: { input: string[] } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              data: body.input.map((text, index) => {
                const embedding =
                  text === query || text === "ping" ? vector(0) : embeddings.get(text.trim());
                if (!embedding) {
                  throw new Error("Unexpected embedding fixture input");
                }
                return { index, embedding };
              }),
            }),
          );
        })().catch((error: unknown) => {
          providerErrors.push(error);
          response.writeHead(500).end();
        });
      });
      return runQaGatewayTestFixture(
        context,
        async ({ signal, verifyCleanup, createTempDir }) => {
          const workspace = createTempDir("openclaw-memory-query-plan-");
          await fs.mkdir(path.join(workspace, "memory"));
          for (const [name, text] of documents) {
            await fs.writeFile(path.join(workspace, "memory", `${name}.md`), `${text}\n`);
          }
          await new Promise<void>((resolve, reject) => {
            provider.once("error", reject);
            provider.listen(0, "127.0.0.1", resolve);
          });
          const address = provider.address();
          if (!address || typeof address === "string") {
            throw new Error("Embedding fixture did not bind a TCP port");
          }
          instance = await createOpenClawTestInstance({
            name: "memory-query-plan",
            entrypoint: [path.resolve("openclaw.mjs")],
            signal,
            verifyCleanup,
            config: {
              agents: {
                ownership: "explicit",
                defaults: {
                  workspace,
                  skipBootstrap: true,
                  heartbeat: { every: "0m" },
                  model: { primary: "fixture/unused" },
                },
                entries: { main: {} },
              },
              gateway: { mode: "local", bind: "loopback" },
              hooks: { enabled: false },
              memory: {
                search: {
                  provider: "openai-compatible",
                  model: "synthetic-embedding",
                  fallback: "none",
                  sources: ["memory"],
                  remote: {
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                    apiKey: "fixture-unused-key",
                  },
                  query: { minScore: 0.2 },
                },
              },
              plugins: {
                allow: ["memory-core"],
                slots: { memory: "memory-core" },
                entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
              },
              tools: { allow: ["memory_search"] },
            },
            env: {
              VITEST: undefined,
              NODE_ENV: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
              OPENCLAW_NO_RESPAWN: "1",
            },
          });
          const indexed = await instance.cli(["memory", "index", "--agent", "main", "--force"]);
          expect(indexed.code, indexed.stderr).toBe(0);
          const databasePath = path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite");
          const db = openNodeSqliteDatabase(databasePath, { allowExtension: true });
          try {
            const loaded = await loadSqliteVecExtension({ db });
            expect(loaded.ok, loaded.error).toBe(true);
            const insert = db.prepare(`INSERT INTO memory_index_chunks
          SELECT ?, path, source, start_line, end_line, hash, model, text, embedding, updated_at
          FROM memory_index_chunks WHERE path = 'memory/background.md' LIMIT 1`);
            const insertVector = db.prepare(
              "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
            );
            const insertProvenance = db.prepare(`INSERT INTO memory_index_chunk_provenance
          (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'agent', 'unknown', ?)`);
            const insertRecall = db.prepare(
              "INSERT INTO memory_index_chunk_recall_metadata (chunk_id) VALUES (?)",
            );
            const background = new Uint8Array(new Float32Array(vector(1.57)).buffer);
            db.exec("BEGIN");
            // Wide vectors make repeated KNN work expensive without a large chunk scan after the fix.
            for (let index = documents.length; index < 4096; index += 1) {
              const id = `padding-${index}`;
              insert.run(id);
              insertVector.run(id, background);
              insertProvenance.run(id, Date.now());
              insertRecall.run(id);
            }
            db.exec("COMMIT; ANALYZE");
            db.exec(
              "UPDATE sqlite_stat1 SET stat = '1 1' WHERE tbl = 'memory_index_chunks'; ANALYZE sqlite_schema;",
            );
            expect(db.prepare("SELECT count(*) AS count FROM memory_index_chunks").get()).toEqual({
              count: 4096,
            });
          } finally {
            db.close();
          }
          await instance.startGateway();
          const startedAt = performance.now();
          const response = await fetch(`http://127.0.0.1:${instance.port}/tools/invoke`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${instance.gatewayToken}`,
            },
            body: JSON.stringify({
              tool: "memory_search",
              agentId: "main",
              args: { query, maxResults: 5, corpus: "memory" },
            }),
            signal,
          });
          const responseBody: unknown = await response.json();
          const elapsedMs = performance.now() - startedAt;
          console.info(JSON.stringify({ elapsedMs, responseBody, providerErrors }));
          expect(response.status).toBe(200);
          expect(responseBody).toMatchObject({
            ok: true,
            result: {
              details: {
                results: ["snapshot", "traffic", "verify", "repair", "rollback"].map((name) => ({
                  path: `memory/${name}.md`,
                  source: "memory",
                  vectorScore: expect.any(Number),
                })),
              },
            },
          });
          expect(responseBody).not.toHaveProperty("result.details.partial");
          expect(responseBody).not.toHaveProperty("result.details.timedOut");
          expect(providerErrors).toEqual([]);
          const after = openNodeSqliteDatabase(databasePath, { readOnly: true });
          try {
            expect(
              after.prepare("SELECT count(*) AS count FROM memory_index_chunks").get(),
            ).toEqual({ count: 4096 });
          } finally {
            after.close();
          }
        },
        async () => instance?.cleanup(),
        async () => {
          if (provider.listening) {
            provider.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              provider.close((error) => (error ? reject(error) : resolve()));
            });
          }
        },
      );
    },
  );
});
